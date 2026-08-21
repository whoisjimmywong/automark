/**
 * 批改编排（M2 + M3）：扫描件 → vision 逐页分析（涂卡+学号+填空OCR）→
 * 判分（客观题 + 填空匹配）→ 逐学生 result JSON → 复核队列 / 改判重算。
 * 任务状态进程内保存（M3；中断续跑/持久化列为后续项）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AMF } from '../../../shared/amf.types.js';
import { allQuestions, isChoice, isFillBlank, blanksOf } from '../../../shared/amf.types.js';
import { matchRule, expectedAnswerText } from './scoring.js';
import type {
  AnswerRecord,
  GradingJob,
  ReviewDecision,
  ReviewItem,
  StudentResult,
} from '../../../shared/results.types.js';
import { analyzeScanPage, scanInfo } from './visionClient.js';
import {
  DEFAULT_THRESHOLDS,
  gradeFillBlank,
  gradeQuestion,
  type BlankOcrReading,
  type BubbleReading,
  type GradingThresholds,
} from './scoring.js';
import {
  listScans,
  processedDir,
  resultsDir,
  resultsFilePath,
  scanPath,
} from './scanManager.js';
import { loadSettings } from './settingsService.js';

const DPI = 300;

const jobs = new Map<string, GradingJob>();
const RUNNING = new Set<string>();  // 内存并发锁：exam_id -> 是否有 running job

/** 批改任务目录（M4 持久化：data/exams/:id/jobs/*.json） */
export function jobsDir(examId: string): string {
  return path.join(resultsDir(examId), '..', 'jobs');
}

function jobFilePath(examId: string, jobId: string): string {
  return path.join(jobsDir(examId), `${jobId}.json`);
}

function saveJob(job: GradingJob): void {
  try {
    fs.mkdirSync(jobsDir(job.exam_id), { recursive: true });
    fs.writeFileSync(jobFilePath(job.exam_id, job.id), JSON.stringify(job, null, 2), 'utf-8');
  } catch {
    // 落盘失败不阻断批改（内存态仍可用）
  }
}

/** 启动时恢复历史任务：running → interrupted（不自动续跑，UI 手动续跑） */
export function restoreJobs(): void {
  try {
    const root = process.env.AUTOMARK_DATA_DIR
      ? path.resolve(process.env.AUTOMARK_DATA_DIR, 'exams')
      : path.resolve(process.cwd(), '..', 'data', 'exams');
    if (!fs.existsSync(root)) return;
    for (const examDir of fs.readdirSync(root)) {
      const dir = path.join(root, examDir, 'jobs');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const job = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as GradingJob;
          if (job.status === 'running') {
            job.status = 'interrupted';
            job.finished_at = new Date().toISOString();
            fs.writeFileSync(path.join(dir, f), JSON.stringify(job, null, 2), 'utf-8');
          }
          jobs.set(job.id, job);
        } catch {
          // 损坏的 job 文件跳过
        }
      }
    }
  } catch {
    // 目录不可读时忽略（全新环境）
  }
}

export function listJobs(examId: string, limit = 10): GradingJob[] {
  const out: GradingJob[] = [];
  try {
    const dir = jobsDir(examId);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const job = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as GradingJob;
          if (job.exam_id === examId) out.push(job);
        } catch {
          // 跳过损坏文件
        }
      }
    }
  } catch {
    // 忽略
  }
  // 合并内存中尚未落盘的任务
  for (const job of jobs.values()) {
    if (job.exam_id === examId && !out.some((j) => j.id === job.id)) out.push(job);
  }
  out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out.slice(0, limit);
}

export function getJob(id: string): GradingJob | undefined {
  return jobs.get(id);
}

export function newJobId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `job_${ts}${rand}`;
}

function thresholdsFromSettings(): GradingThresholds {
  const s = loadSettings();
  return {
    fill_selected: s.grading.fill_selected,
    fill_suspicious: s.grading.fill_suspicious,
    ocr_min_confidence: s.ocr.min_confidence,
  };
}

function ocrConfigFromSettings(): Record<string, unknown> {
  const s = loadSettings();
  return {
    engine: s.ocr.engine,
    min_confidence: s.ocr.min_confidence,
    recheck_enabled: s.ocr.recheck_enabled,
    external: s.ocr.external,
    llm: s.ocr.llm,
  };
}

/** 启动批改任务（后台执行）；返回 job 句柄（轮询用）。
 * opts.manualFill = true → 只自动批改选择题，填空题留待人工批改（verdict=pending）。
 * opts.resumeFrom = 源 job id → 学生级断点续跑（跳过该 job 已处理的学生）。
 * 同一考试同时只允许一个 running 任务（内存 + 落盘双重检查）。 */
export function startGrading(
  examId: string,
  amf: AMF,
  opts: { manualFill?: boolean; resumeFrom?: string } = {},
): GradingJob {
  // 并发锁：内存检查 + 磁盘 running 检查
  if (RUNNING.has(examId) || hasRunningJobOnDisk(examId)) {
    throw new Error('该考试已有批改任务在运行（请等待完成或先中断）');
  }
  const job: GradingJob = {
    id: newJobId(),
    exam_id: examId,
    status: 'running',
    total_pages: 0,
    processed_pages: 0,
    students: [],
    created_at: new Date().toISOString(),
    manual_fill: opts.manualFill === true,
    ...(opts.resumeFrom ? { resumed_from: opts.resumeFrom } : {}),
  };
  jobs.set(job.id, job);
  RUNNING.add(examId);
  saveJob(job);
  void runPipeline(job, amf);
  return job;
}

function hasRunningJobOnDisk(examId: string): boolean {
  try {
    const dir = jobsDir(examId);
    if (!fs.existsSync(dir)) return false;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as GradingJob;
        if (job.status === 'running') return true;
      } catch {
        // 跳过
      }
    }
  } catch {
    // 忽略
  }
  return false;
}

async function runPipeline(job: GradingJob, amf: AMF): Promise<void> {
  try {
    const examId = job.exam_id;
    const manualFill = job.manual_fill === true;
    if (!amf.positions?.pages?.length) {
      throw new Error('AMF 缺少 positions（请先执行生成 PDF）');
    }
    const files = listScans(examId);
    if (files.length === 0) {
      throw new Error('没有可批改的扫描件（请先上传扫描 PDF/图片）');
    }

    for (const f of files) {
      const info = await scanInfo(scanPath(examId, f.name)!);
      job.total_pages += info.pages;
    }

    fs.mkdirSync(resultsDir(examId), { recursive: true });
    fs.mkdirSync(processedDir(examId), { recursive: true });

    const thresholds = thresholdsFromSettings();
    const results: StudentResult[] = [];
    const questions = allQuestions(amf);
    const config = {
      ...(amf.answer_sheet_config ?? {}),
      role: amf.paper.mode === 'answer_sheet' ? 'answer_sheet' : 'paper',
    };
    const ocrConfig = ocrConfigFromSettings();

    // 断点续跑：跳过源 job 已处理完的学生（按 source_file）
    const resumeSkip = new Set<string>();
    if (job.resumed_from) {
      const prev = jobs.get(job.resumed_from) ?? getJobFromDisk(examId, job.resumed_from);
      for (const f of prev?.processed_students ?? []) resumeSkip.add(f);
    }

    for (let fi = 0; fi < files.length; fi++) {
      // 协作式中断：interrupt 后不再处理剩余学生
      if (job.status !== 'running') break;
      const file = files[fi];
      if (resumeSkip.has(file.name)) {
        // 续跑：该生结果已在（源 job 生成），跳过识别与判分
        continue;
      }
      const absPath = scanPath(examId, file.name)!;
      const info = await scanInfo(absPath);

      const readings = new Map<string, BubbleReading>();
      const ocrReadings = new Map<string, BlankOcrReading>();
      const pageWarnings: string[] = [];
      let studentIdFromBubbles: string | null = null;
      let idRead = false;
      let absentMarked = false;

      for (let pi = 0; pi < info.pages; pi++) {
        const outPng = path.join(processedDir(examId), `${file.name}_p${pi + 1}.png`);
        const res = await analyzeScanPage({
          source: { kind: file.kind, path: absPath, page: pi },
          dpi: DPI,
          exam_id: amf.exam.id,
          positions: amf.positions,
          config,
          out_png: outPng,
          do_ocr: !manualFill,
          ocr_config: ocrConfig,
        });
        job.processed_pages += 1;

        if (!res.ok) {
          pageWarnings.push(`第 ${pi + 1} 页分析失败: ${res.error ?? '未知错误'}`);
          continue;
        }
        for (const w of res.warnings ?? []) pageWarnings.push(`第 ${pi + 1} 页: ${w}`);
        for (const b of res.bubbles ?? []) {
          readings.set(b.qid, {
            qid: b.qid,
            options: b.options,
            fill: b.fill,
            selected: b.selected,
            suspicious: b.suspicious,
            page: res.page,
          });
        }
        for (const o of res.ocr ?? []) {
          if (o.error) {
            pageWarnings.push(`第 ${pi + 1} 页 ${o.qid} OCR 失败: ${o.error}`);
            continue;
          }
          let r = ocrReadings.get(o.qid);
          if (!r) {
            r = {
              qid: o.qid,
              texts: [],
              confidences: [],
              confidence: 0,
              alternatives: [],
              engine: o.engine,
              page: res.page,
            };
            ocrReadings.set(o.qid, r);
          }
          r.texts[o.blank] = o.text;
          r.confidences[o.blank] = o.confidence;
          if (Array.isArray(o.alternatives) && o.alternatives.length) {
            r.alternatives![o.blank] = o.alternatives;
          }
        }
        if (!idRead && res.student_id?.ok) {
          studentIdFromBubbles = res.student_id.read;
          idRead = true;
        }
        if (res.absent) absentMarked = true;
      }

      // 聚合填空置信度：非空文本的逐空置信度均值
      for (const r of ocrReadings.values()) {
        const cs = r.confidences.filter((c, i) => (r.texts[i] ?? '').trim().length > 0);
        r.confidence = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0;
      }

      // 身份：涂卡学号优先，否则按扫描顺序兜底
      const fallbackId = `S${fi + 1}`;
      const sid = idRead ? studentIdFromBubbles! : fallbackId;
      if (!idRead) {
        pageWarnings.push('未读出涂卡学号，按扫描顺序兜底（建议人工核对）');
      }

      // 判分（manual_fill 模式：只自动批改选择题，填空题留待人工批改 → pending）
      const pageOfQid = (qid: string): number | undefined => {
        for (const pp of amf.positions?.pages ?? []) {
          if (pp.blocks.some((b) => b.qid === qid)) return pp.page;
        }
        return undefined;
      };
      const answers = questions.map((q) => {
        if (isChoice(q)) {
          const r = readings.get(q.id)
            ?? { qid: q.id, options: 0, fill: [], selected: [], suspicious: [] };
          return gradeQuestion(q, r, amf, thresholds);
        }
        if (manualFill) {
          return {
            qid: q.id,
            type: 'fill_blank' as const,
            number: q.number,
            max_score: q.score,
            student_answer: '',
            correct_answer: blanksOf(q.answer).map((b) => expectedAnswerText(b.match)).join(' | '),
            raw: { fill: [], selected: [], suspicious: [], texts: [], confidences: [], matched: [] },
            confidence: 0,
            verdict: 'pending' as const,
            score: 0,
            ...(pageOfQid(q.id) !== undefined ? { page: pageOfQid(q.id) } : {}),
          };
        }
        return gradeFillBlank(q, ocrReadings.get(q.id), amf, thresholds);
      });
      const total = answers.reduce((s, a) => s + a.score, 0);
      const full = answers.reduce((s, a) => s + a.max_score, 0);
      const pendingFill = answers.filter((a) => a.type === 'fill_blank' && a.verdict === 'pending').length;
      // 仅真正影响判读的警告强制复核（如学号未读出/QR 异常/配准失败）；
      // 信息性提示（如续页无学号区）不把整卷标记为待复核
      const benign = /本页无学号涂卡区（非首页）/;
      const reviewRequired = answers.some((a) => a.verdict === 'review')
        || pageWarnings.some((w) => !benign.test(w));

      // 缺考/异常：涂了 ABSENT/WITHDRAWN 圈 → 不计分
      if (absentMarked) {
        pageWarnings.push('涂卡 ABSENT/WITHDRAWN：标记为缺考/异常，不计分');
      }

      const result: StudentResult = {
        exam_id: examId,
        student: {
          id: sid,
          name: null,
          source_file: file.name,
          page_indexes: Array.from({ length: info.pages }, (_, i) => i),
          id_from_bubbles: idRead,
          ...(absentMarked ? { absent: true } : {}),
        },
        answers,
        total_score: absentMarked ? 0 : total,
        full_score: full,
        review_required: reviewRequired,
        graded_at: new Date().toISOString(),
        warnings: pageWarnings,
        ...(pendingFill ? { pending_fill: pendingFill } : {}),
      };
      fs.writeFileSync(resultsFilePath(examId, sid), JSON.stringify(result, null, 2), 'utf-8');
      results.push(result);
      job.students = [...results];
      job.processed_students = [...(job.processed_students ?? []), file.name];
      saveJob(job);  // 每学生完成即落盘（断点续跑依据）
    }

    job.status = 'done';
    job.finished_at = new Date().toISOString();
    saveJob(job);
  } catch (err) {
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finished_at = new Date().toISOString();
    saveJob(job);
  } finally {
    RUNNING.delete(job.exam_id);
  }
}

/** 中断运行中的任务（协作式：runPipeline 在学生循环检查状态后退出） */
export function interruptJob(job: GradingJob): void {
  if (job.status !== 'running') return;
  job.status = 'interrupted';
  job.finished_at = new Date().toISOString();
  saveJob(job);
  RUNNING.delete(job.exam_id);
}

function getJobFromDisk(examId: string, jobId: string): GradingJob | undefined {
  try {
    const p = jobFilePath(examId, jobId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as GradingJob;
  } catch {
    // 忽略
  }
  return undefined;
}

// ------------------------------------------------------------ 复核 ----
/** 从 positions 找题目裁剪信息（复核原图用） */
export function findCropRect(amf: AMF, page: number, qid: string, blank?: number):
  { rect: [number, number, number, number]; kind: 'ocr' | 'bubble'; options?: number } | null {
  for (const pp of amf.positions?.pages ?? []) {
    if (page && pp.page !== page) continue;
    for (const b of pp.blocks) {
      if (b.qid !== qid) continue;
      if (b.kind === 'ocr' && blank !== undefined && b.blank !== blank) continue;
      if (b.kind === 'ocr' && blank === undefined) continue;
      return { rect: b.rect as [number, number, number, number], kind: b.kind, options: b.options };
    }
  }
  return null;
}

/** 复核队列（当前 verdict='review' 的条目，按置信度升序） */
export function listReviewItems(examId: string, amf: AMF): ReviewItem[] {
  const results = listStudentResults(examId);
  const items: ReviewItem[] = [];
  for (const r of results) {
    for (const a of r.answers) {
      if (a.verdict !== 'review') continue;
      // 填空：定位置信度最低的空（供裁剪与默认改判目标）
      let blank: number | undefined;
      if (a.type === 'fill_blank') {
        const confs = a.raw.confidences ?? [];
        const texts = a.raw.texts ?? [];
        let worst = -1;
        let worstConf = 1.1;
        for (let i = 0; i < texts.length; i++) {
          if (texts[i] && confs[i] !== undefined && confs[i] < worstConf) {
            worstConf = confs[i];
            worst = i;
          }
        }
        if (worst >= 0) blank = worst;
      }
      const crop = findCropRect(amf, a.page ?? 1, a.qid, blank);
      if (!crop) continue;
      items.push({
        student_id: r.student.id,
        qid: a.qid,
        number: a.number,
        type: a.type,
        reason: a.review_reason ?? '低置信',
        confidence: a.confidence,
        student_answer: a.student_answer,
        correct_answer: a.correct_answer,
        page: a.page ?? 1,
        ...(a.raw.alternatives?.length ? { alternatives: a.raw.alternatives } : {}),
        crop: {
          file: `${r.student.source_file}_p${a.page ?? 1}.png`,
          rect: crop.rect,
          kind: crop.kind,
          options: crop.options,
        },
        ...(blank !== undefined ? { blank } : {}),
      });
    }
  }
  items.sort((x, y) => x.confidence - y.confidence);
  return items;
}

/** 改判：应用复核决定并重算该生成绩 */
export async function applyReviewDecision(
  examId: string,
  studentId: string,
  qid: string,
  decision: ReviewDecision,
  amf: AMF,
): Promise<{ ok: boolean; result?: StudentResult; error?: string }> {
  const result = loadStudentResult(examId, studentId);
  if (!result) return { ok: false, error: '学生结果不存在' };
  const idx = result.answers.findIndex((a) => a.qid === qid);
  if (idx < 0) return { ok: false, error: '题目不在该生结果中' };
  const q = allQuestions(amf).find((x) => x.id === qid);
  if (!q) return { ok: false, error: 'AMF 中无此题' };

  const prev = { ...result.answers[idx] };
  const thresholds = thresholdsFromSettings();
  const fresh: AnswerRecord = gradeOne(q, prev, decision, thresholds, amf);

  result.answers[idx] = fresh;
  result.total_score = result.answers.reduce((s, a) => s + a.score, 0);
  // 人工批改后更新待批填空数（为 0 时移除字段）
  const pendingFill = result.answers.filter(
    (a) => a.type === 'fill_blank' && a.verdict === 'pending').length;
  if (pendingFill) result.pending_fill = pendingFill;
  else delete result.pending_fill;
  // 与批改时一致：仅真正影响判读的警告强制复核，信息性提示不算
  const benign = /本页无学号涂卡区（非首页）/;
  result.review_required = result.answers.some((a) => a.verdict === 'review')
    || result.warnings.some((w) => !benign.test(w));
  result.review_log = [
    ...(result.review_log ?? []),
    {
      qid,
      decision,
      resolved_at: new Date().toISOString(),
      previous_verdict: prev.verdict,
      new_verdict: fresh.verdict,
    },
  ];
  fs.writeFileSync(resultsFilePath(examId, studentId), JSON.stringify(result, null, 2), 'utf-8');
  return { ok: true, result };
}

/** 按改判决定重新判分（不再触发 review；改判后 verdict 反映真实匹配） */
function gradeOne(
  q: ReturnType<typeof allQuestions>[number],
  prev: AnswerRecord,
  decision: ReviewDecision,
  thresholds: GradingThresholds,
  amf: AMF,
): AnswerRecord {
  const cleanThresholds = { ...thresholds, ocr_min_confidence: 0, fill_suspicious: 0 };
  if (isChoice(q)) {
    const fill = prev.raw.fill ?? [];
    let selected = [...(prev.raw.selected ?? [])];
    if (decision.action === 'select') selected = decision.options ?? [];
    if (decision.action === 'accept') {
      // 教师确认可疑浅涂为有效涂选：suspicious 气泡并入 selected
      selected = [...new Set([...selected, ...(prev.raw.suspicious ?? [])])];
      if (selected.length > 1 && (q.answer.kind === 'single' || q.answer.kind === 'tf')) {
        // 单选多涂：取填充率最高者
        const best = fill.indexOf(Math.max(...fill));
        selected = best >= 0 ? [best] : [selected[0]];
      }
    }
    const reading: BubbleReading = {
      qid: q.id,
      options: Math.max(fill.length, q.answer.kind === 'tf' ? 2 : q.options.length),
      fill,
      selected,
      suspicious: [],
      page: prev.page,
    };
    return gradeQuestion(q, reading, amf, cleanThresholds);
  }
  // 填空
  const texts = [...(prev.raw.texts ?? [])];
  const confs = [...(prev.raw.confidences ?? [])];
  const manualVerdicts = [...(prev.raw.manual_verdict ?? [])];
  if (decision.action === 'override_text') texts[decision.blank ?? 0] = decision.text;
  if (decision.action === 'mark_blank') texts[decision.blank ?? 0] = '';
  if (decision.action === 'manual_set') {
    // 人工批改逐空判定：写入 raw.manual_verdict，判分端优先采用
    manualVerdicts[decision.blank] = decision.verdict;
    if (decision.verdict === 'blank') texts[decision.blank] = '';
  }
  if (decision.action === 'accept' && isFillBlank(q)) {
    // 候选冲突复核的「接受」：采纳能匹配标准答案的备选候选（如 vehide→vehicle）
    const alts = prev.raw.alternatives ?? [];
    const blanks = blanksOf(q.answer);
    for (let i = 0; i < blanks.length; i++) {
      if ((texts[i] ?? '').trim().length === 0) continue;
      const match = alts[i] ?? [];
      const good = match.find((a) => a.text.trim()
        && matchRule(blanks[i].match, a.text, q.answer.case_sensitive === true));
      if (good) {
        texts[i] = good.text;
        confs[i] = Math.max(confs[i] ?? 0, good.confidence);
      }
    }
  }
  const nonEmpty = confs.filter((c, i) => (texts[i] ?? '').trim().length > 0);
  const reading: BlankOcrReading = {
    qid: q.id,
    texts,
    confidences: confs,
    confidence: nonEmpty.length ? nonEmpty.reduce((a, b) => a + b, 0) / nonEmpty.length : 0,
    ...(manualVerdicts.some((v) => v !== undefined)
      ? { manual_verdict: manualVerdicts as ('correct' | 'incorrect' | 'blank')[] }
      : {}),
    engine: prev.raw.ocr_engine,
    page: prev.page,
  };
  return gradeFillBlank(q, reading, amf, cleanThresholds);
}

/** 读取已保存的某学生结果 */
export function loadStudentResult(examId: string, studentId: string): StudentResult | null {
  const p = resultsFilePath(examId, studentId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as StudentResult;
  } catch {
    return null;
  }
}

/** 汇总所有已保存结果（结果页/导出用） */
export function listStudentResults(examId: string): StudentResult[] {
  const dir = resultsDir(examId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')) as StudentResult;
      } catch {
        return null;
      }
    })
    .filter((r): r is StudentResult => r !== null)
    .sort((a, b) => a.student.id.localeCompare(b.student.id));
}

export { DEFAULT_THRESHOLDS };
