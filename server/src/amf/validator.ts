/**
 * AMF 校验器：JSON Schema 校验 + 语义校验。
 * 逐条给出可读错误（字段路径 + 原因），不因单个错误丢弃整份文件。
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { AMF_SCHEMA } from '../../../shared/amf.schema.js';
import type { AMF, Question, ChoiceQuestion, FillBlankQuestion } from '../../../shared/amf.types.js';

export interface AmfError {
  /** 字段路径，如 paper.sections[0].questions[2].answer */
  path: string;
  /** 可读原因 */
  message: string;
}

export interface AmfValidationResult {
  valid: boolean;
  errors: AmfError[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(AMF_SCHEMA);

function ajvPath(instancePath: string): string {
  // ajv: /paper/sections/0/questions/2/answer → paper.sections[0].questions[2].answer
  if (!instancePath) return '(root)';
  return instancePath
    .replace(/^\//, '')
    .replace(/\/(\d+)(?=\/|$)/g, '[$1]')
    .replace(/\//g, '.');
}

/** section oneOf 分支顺序（与 amf.schema.ts 一致） */
const SEC_BRANCH: Record<string, number> = {
  single_choice: 0,
  multiple_choice: 1,
  true_false: 2,
  fill_blank: 3,
};
/** match rule oneOf 分支顺序 */
const MATCH_BRANCH: Record<string, number> = {
  exact: 0,
  any_of: 1,
  regex: 2,
  numeric: 3,
};

/**
 * oneOf 降噪：ajv 会报告所有失败分支的错误。按数据实际声明的
 * section.type / match.type 只保留对应分支的错误。
 */
interface LooseMatch {
  type?: string;
}
interface LooseAnswer {
  kind?: string;
  match?: LooseMatch;
  blanks?: { match?: LooseMatch }[];
}
interface LooseSection {
  type?: string;
  questions?: { answer?: LooseAnswer }[];
}

function filterOneOfNoise(
  errors: NonNullable<typeof validateSchema.errors>,
  data: unknown,
): NonNullable<typeof validateSchema.errors> {
  const sections = (data as { paper?: { sections?: LooseSection[] } })?.paper?.sections;
  return errors.filter((e) => {
    if (e.keyword === 'oneOf' && e.schemaPath.endsWith('/oneOf')) return false;
    const secMatch = e.instancePath.match(/^\/paper\/sections\/(\d+)(\/|$)/);
    if (!secMatch) return true;
    const sec = sections?.[Number(secMatch[1])];
    const secBranch = sec?.type ? SEC_BRANCH[sec.type] : undefined;
    const branchOf = e.schemaPath.match(/\/sections\/items\/oneOf\/(\d+)\//);
    if (branchOf) {
      if (secBranch === undefined) return false; // 未知 section 类型 → 丢弃全部分支错误（后续合成一条）
      if (Number(branchOf[1]) !== secBranch) return false;
    }
    // match rule 降噪（含 blanks[i].match 路径）
    const qMatch = e.instancePath.match(
      /^\/paper\/sections\/\d+\/questions\/(\d+)\/answer\/(?:blanks\/(\d+)\/)?match(\/|$)/,
    );
    if (qMatch) {
      const q = sec?.questions?.[Number(qMatch[1])];
      const bi = qMatch[2] !== undefined ? Number(qMatch[2]) : undefined;
      const mType =
        bi !== undefined ? q?.answer?.blanks?.[bi]?.match?.type : q?.answer?.match?.type;
      const mBranch = mType ? MATCH_BRANCH[mType] : undefined;
      const mBranchOf = e.schemaPath.match(/\/match\/oneOf\/(\d+)\//);
      if (mBranchOf) {
        if (mBranch === undefined) return false;
        if (Number(mBranchOf[1]) !== mBranch) return false;
      }
    }
    return true;
  });
}

/** 为「未知 section.type / match.type」合成一条明确错误（其分支错误已被降噪丢弃） */
function synthesizeTypeErrors(data: unknown): AmfError[] {
  const out: AmfError[] = [];
  const sections = (data as { paper?: { sections?: { type?: string; questions?: { answer?: { kind?: string; match?: { type?: string } } }[] }[] } })
    ?.paper?.sections;
  sections?.forEach((sec, si) => {
    if (sec?.type !== undefined && SEC_BRANCH[sec.type] === undefined) {
      out.push({
        path: `paper.sections[${si}].type`,
        message: `未知类型 "${sec.type}"，必须是 single_choice / multiple_choice / true_false / fill_blank 之一`,
      });
    }
    sec?.questions?.forEach((q, qi) => {
      if (q?.answer?.kind === 'text') {
        const mt = q.answer.match?.type;
        if (mt !== undefined && MATCH_BRANCH[mt] === undefined) {
          out.push({
            path: `paper.sections[${si}].questions[${qi}].answer.match.type`,
            message: `未知匹配类型 "${mt}"，必须是 exact / any_of / regex / numeric 之一`,
          });
        }
      }
    });
  });
  return out;
}

/** schema 层面的可读化 */
function schemaErrors(
  errors: NonNullable<typeof validateSchema.errors>,
  data: unknown,
): AmfError[] {
  const seen = new Set<string>();
  const out: AmfError[] = [];
  for (const e of filterOneOfNoise(errors, data)) {
    const path = ajvPath(e.instancePath);
    let message = e.message ?? 'invalid';
    if (e.keyword === 'required') {
      message = `缺少必填字段 "${(e.params as { missingProperty: string }).missingProperty}"`;
    } else if (e.keyword === 'additionalProperties') {
      message = `不允许的字段 "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    } else if (e.keyword === 'const') {
      message = `值必须为 ${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)}`;
    } else if (e.keyword === 'enum') {
      message = `值不在允许范围内`;
    } else if (e.keyword === 'type') {
      message = `类型错误，应为 ${(e.params as { type: string }).type}`;
    }
    const key = `${path}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, message });
  }
  out.push(...synthesizeTypeErrors(data));
  return out;
}

/** 语义校验（schema 表达不了的规则） */
function semanticErrors(amf: AMF): AmfError[] {
  const errors: AmfError[] = [];
  const qNumbers = new Map<number, string>();
  const qIds = new Set<string>();
  const sectionIds = new Set<string>();

  amf.paper.sections.forEach((sec, si) => {
    if (sectionIds.has(sec.id)) {
      errors.push({ path: `paper.sections[${si}].id`, message: `分区 id "${sec.id}" 重复` });
    }
    sectionIds.add(sec.id);

    sec.questions.forEach((q, qi) => {
      const base = `paper.sections[${si}].questions[${qi}]`;
      if (qIds.has(q.id)) errors.push({ path: `${base}.id`, message: `题目 id "${q.id}" 重复` });
      qIds.add(q.id);
      const prev = qNumbers.get(q.number);
      if (prev !== undefined) {
        errors.push({ path: `${base}.number`, message: `题号 ${q.number} 与题目 "${prev}" 重复` });
      }
      qNumbers.set(q.number, q.id);

      if (q.answer.kind === 'text') {
        const fq = q as FillBlankQuestion;
        const ta = fq.answer;
        const hasMatch = ta.match !== undefined;
        const hasBlanks = ta.blanks !== undefined;
        if (hasMatch && hasBlanks) {
          errors.push({
            path: `${base}.answer`,
            message: 'match（旧版单空）与 blanks（多空）只能保留其一',
          });
        } else if (!hasMatch && !hasBlanks) {
          errors.push({ path: `${base}.answer`, message: '填空题必须提供 match 或 blanks' });
        }
        const blanks = ta.blanks ?? (ta.match ? [{ match: ta.match }] : []);
        if (hasBlanks && (blanks.length < 1 || blanks.length > 5)) {
          errors.push({
            path: `${base}.answer.blanks`,
            message: `空格数 ${blanks.length} 超出范围（1..5）`,
          });
        }
        blanks.forEach((b, bi) => {
          if (b.match.type === 'regex') {
            try {
              new RegExp(b.match.pattern);
            } catch {
              errors.push({
                path: `${base}.answer${hasBlanks ? `.blanks[${bi}]` : ''}.match.pattern`,
                message: '正则表达式无法编译',
              });
            }
          }
        });
        // 分空赋分：全部设置或全部缺省；Σpoints 不得超过题目总分（差值为全对奖励分）
        if (hasBlanks && blanks.length > 1) {
          const pts = (ta.blanks ?? []).map((b) => b.points);
          const setCount = pts.filter((p) => p !== undefined).length;
          if (setCount > 0 && setCount < blanks.length) {
            errors.push({
              path: `${base}.answer.blanks`,
              message: '各空分数需全部设置，或全部缺省（按均分处理）',
            });
          } else if (setCount === blanks.length) {
            let sum = 0;
            for (const p of pts) sum += p ?? 0;
            sum = Math.round(sum * 100) / 100;
            if (sum - q.score > 1e-6) {
              errors.push({
                path: `${base}.answer.blanks`,
                message: `各空分数之和为 ${sum}，超过题目总分 ${q.score}`,
              });
            }
          }
        }
      } else {
        const cq = q as ChoiceQuestion;
        const nOpt = cq.options.length;
        const bad = (i: number) => i < 0 || i >= nOpt;
        if (cq.answer.kind === 'single' && bad(cq.answer.correct)) {
          errors.push({
            path: `${base}.answer.correct`,
            message: `正确选项下标 ${cq.answer.correct} 超出选项范围（0..${nOpt - 1}）`,
          });
        }
        if (cq.answer.kind === 'multiple') {
          cq.answer.correct.forEach((c) => {
            if (bad(c)) {
              errors.push({
                path: `${base}.answer.correct`,
                message: `正确选项下标 ${c} 超出选项范围（0..${nOpt - 1}）`,
              });
            }
          });
          if (cq.answer.correct.length >= nOpt) {
            errors.push({
              path: `${base}.answer.correct`,
              message: '多选题正确选项不应覆盖全部选项',
            });
          }
        }
      }
    });
  });

  // 题号连续性（缺号提示）
  const nums = [...qNumbers.keys()].sort((a, b) => a - b);
  if (nums.length > 0 && (nums[0] !== 1 || nums[nums.length - 1] !== nums.length)) {
    const missing: number[] = [];
    for (let i = 1; i <= nums[nums.length - 1]; i++) if (!qNumbers.has(i)) missing.push(i);
    if (missing.length > 0 || nums[0] !== 1) {
      errors.push({
        path: 'paper.sections',
        message: `题号不连续${missing.length ? `，缺少: ${missing.join(', ')}` : ''}（应从 1 连续编号）`,
      });
    }
  }

  return errors;
}

/** 完整校验：schema + 语义。返回全部错误。 */
export function validateAmf(data: unknown): AmfValidationResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, errors: [{ path: '(root)', message: 'AMF 必须是一个 JSON 对象' }] };
  }
  const ok = validateSchema(data);
  const errors: AmfError[] = ok ? [] : schemaErrors(validateSchema.errors ?? [], data);
  // schema 通过才做语义校验（避免在结构损坏的对象上二次报错）
  if (ok) {
    errors.push(...semanticErrors(data as AMF));
  }
  return { valid: errors.length === 0, errors };
}

/** 判断是否为「仅警告级」：当前语义错误全部视为错误；保留出口便于将来分级 */
export function summarize(errors: AmfError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('\n');
}

export type { Question };
