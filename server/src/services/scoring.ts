/**
 * 判分引擎（M2 客观题 + M3 填空 OCR）：
 *  - 单选/判断：正确满分，错误/未涂 0 分；组内多涂 → review
 *  - 多选：全对满分；漏选部分分（默认满分×0.5）；错选/多选/未涂 0 分
 *    （scoring.full/partial/wrong 可配置）
 *  - 涂卡填充率落入 [fill_suspicious, fill_selected) → 低置信 → review
 *  - 涂卡置信度 = 1 - exp(-k·(最高涂选填充率 - 次高))，k=6
 *  - 填空（M3）：归一化匹配 exact/any_of/regex/numeric；
 *    per_blank 分空赋分（全部答对时补足总分差值奖励）或 all_or_nothing；
 *    OCR 置信度 < min_confidence 且非空 → review
 */
import {
  isChoice,
  isFillBlank,
  blanksOf,
  optionLabel,
  tfLabels,
  type AMF,
  type MatchRule,
  type Question,
} from '../../../shared/amf.types.js';
import type { AnswerRecord, Verdict } from '../../../shared/results.types.js';

export interface BubbleReading {
  qid: string;
  options: number;
  fill: number[];
  selected: number[];
  suspicious: number[];
  page?: number;
}

export interface BlankOcrReading {
  qid: string;
  /** 逐空转写文本（按 blank 下标） */
  texts: string[];
  /** 逐空置信度 */
  confidences: number[];
  /** 聚合置信度 */
  confidence: number;
  /** 逐空 OCR 备选候选（det/rec/rec-trim 多路径，用于候选冲突复核） */
  alternatives?: { text: string; confidence: number; mode: string }[][];
  /** 人工批改逐空判定（manual_fill 模式；存在时优先于文本匹配） */
  manual_verdict?: ('correct' | 'incorrect' | 'blank')[];
  engine?: string;
  page?: number;
}

export interface GradingThresholds {
  fill_selected: number;
  fill_suspicious: number;
  ocr_min_confidence: number;
}

export const DEFAULT_THRESHOLDS: GradingThresholds = {
  fill_selected: 0.5,
  fill_suspicious: 0.25,
  ocr_min_confidence: 0.6,
};

const CONF_K = 6;

// ------------------------------------------------------------ 归一化 ------
/** 归一化（product_dev §8.5）：NFKC、全角→半角、小写、折叠空白、去句尾标点。
 * case_sensitive=true 时保留大小写（严格判定），其余归一化不变。 */
export function normalizeText(s: string, caseSensitive = false): string {
  let t = (s ?? '').normalize('NFKC');
  t = t.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  t = t.replace(/\u3000/g, ' ');
  if (!caseSensitive) t = t.toLowerCase();
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[.,;:!?=。，；：！？'"“”]+$/, '');
  return t;
}

/** 匹配规则：exact / any_of / regex（全匹配）/ numeric（±tolerance）
 * caseSensitive：true=严格大小写（CAR≠car）；false=忽略大小写（默认）。 */
export function matchRule(rule: MatchRule, text: string, caseSensitive = false): boolean {
  const norm = normalizeText(text, caseSensitive);
  if (!norm) return false;
  switch (rule.type) {
    case 'exact':
      return normalizeText(rule.value, caseSensitive) === norm;
    case 'any_of':
      return rule.values.some((v) => normalizeText(v, caseSensitive) === norm);
    case 'regex': {
      try {
        const flags = caseSensitive ? '' : 'i';
        return new RegExp(`^(?:${rule.pattern})$`, flags).test(norm);
      } catch {
        return false;
      }
    }
    case 'numeric': {
      const parsed = parseFloat(norm.replace(/[^\d.\-]/g, ''));
      if (Number.isNaN(parsed)) return false;
      return Math.abs(parsed - rule.value) <= rule.tolerance;
    }
  }
}

/** 期望答案的展示文本（答案卷/结果/复核用） */
export function expectedAnswerText(m: MatchRule): string {
  if (m.type === 'exact') return m.value;
  if (m.type === 'any_of') return m.values.join(' / ');
  if (m.type === 'regex') return `regex: ${m.pattern}`;
  return `${m.value} ±${m.tolerance}`;
}

// ------------------------------------------------------------ 涂卡 ------
/** 客观题作答记录（含判分） */
export function gradeQuestion(
  q: Question,
  reading: BubbleReading | undefined,
  amf: AMF,
  thresholds: GradingThresholds = DEFAULT_THRESHOLDS,
): AnswerRecord {
  const base = {
    qid: q.id,
    type: sectionTypeOf(q, amf),
    number: q.number,
    max_score: q.score,
    page: reading?.page,
  };

  // 填空由 gradeFillBlank 处理（调用方分流）
  if (isFillBlank(q)) {
    return {
      ...base,
      student_answer: '',
      correct_answer: '',
      raw: { fill: [], selected: [], suspicious: [] },
      confidence: 0,
      verdict: 'pending' as Verdict,
      score: 0,
    };
  }

  const fill = reading?.fill ?? [];
  const selected = reading?.selected ?? [];
  const suspicious = reading?.suspicious ?? [];
  const raw = { fill, selected, suspicious };
  const { fill_selected: fSel, fill_suspicious: fSus } = thresholds;

  const answer = q.answer;
  if (answer.kind === 'single' || answer.kind === 'tf') {
    const correct = answer.correct;
    const labels = answer.kind === 'tf' ? tfLabels(amf) : undefined;
    const studentAnswer = selected.length === 1
      ? (labels ? labels[selected[0]] : optionLabel(selected[0]))
      : '';
    const correctAnswer = labels ? labels[correct] : optionLabel(correct);

    let verdict: Verdict;
    let score = 0;
    let reason: string | undefined;
    if (suspicious.length > 0) {
      verdict = 'review';
      reason = '存在低置信涂卡（浅涂/擦除残留）';
    } else if (selected.length === 0) {
      verdict = 'incorrect';
    } else if (selected.length > 1) {
      verdict = 'review';
      reason = '单选/判断题组内多涂';
    } else if (selected[0] === correct) {
      verdict = 'correct';
      score = q.score;
    } else {
      verdict = 'incorrect';
    }
    return {
      ...base,
      student_answer: studentAnswer,
      correct_answer: correctAnswer,
      raw,
      confidence: bubbleConfidence(fill, selected, fSus),
      verdict,
      score,
      ...(reason ? { review_reason: reason } : {}),
    };
  }

  // multiple
  const correct = new Set(answer.correct);
  const scoring = answer.scoring ?? {};
  const full = scoring.full ?? q.score;
  const partial = scoring.partial ?? full * 0.5;
  const wrong = scoring.wrong ?? 0;
  const selectedSet = new Set(selected);
  const studentAnswer = [...selected].sort((a, b) => a - b)
    .map((i) => optionLabel(i)).join(',');
  const correctAnswer = [...correct].sort((a, b) => a - b)
    .map((i) => optionLabel(i)).join(',');

  let verdict: Verdict;
  let score = wrong;
  let reason: string | undefined;
  const isSubset = [...selectedSet].every((i) => correct.has(i));
  if (suspicious.length > 0) {
    verdict = 'review';
    reason = '存在低置信涂卡（浅涂/擦除残留）';
  } else if (selectedSet.size === 0) {
    verdict = 'incorrect';
  } else if (selectedSet.size === correct.size && isSubset) {
    verdict = 'correct';
    score = full;
  } else if (isSubset) {
    verdict = 'partial';
    score = partial;
  } else {
    verdict = 'incorrect';
  }
  return {
    ...base,
    student_answer: studentAnswer,
    correct_answer: correctAnswer,
    raw,
    confidence: bubbleConfidence(fill, selected, fSus),
    verdict,
    score,
    ...(reason ? { review_reason: reason } : {}),
  };
}

// ------------------------------------------------------------ 填空 ------
/**
 * 填空判分（M3）。ocr 缺省视为未作答。
 * per_blank：逐空 points（缺省均分）；全部答对且 Σpoints < 总分 → 补足总分
 * all_or_nothing：全对满分，否则 0
 * OCR 置信度 < min_confidence 且文本非空 → review（教师复核确认）
 */
export function gradeFillBlank(
  q: Question,
  ocr: BlankOcrReading | undefined,
  amf: AMF,
  thresholds: GradingThresholds = DEFAULT_THRESHOLDS,
): AnswerRecord {
  const base = {
    qid: q.id,
    type: 'fill_blank' as const,
    number: q.number,
    max_score: q.score,
    page: ocr?.page,
  };
  if (!isFillBlank(q)) {
    return gradeQuestion(q, undefined, amf, thresholds);
  }

  const blanks = blanksOf(q.answer);
  const n = Math.max(blanks.length, 1);
  const texts = Array.from({ length: n }, (_, i) => (ocr?.texts?.[i] ?? '').trim());
  const confidences = Array.from({ length: n }, (_, i) => ocr?.confidences?.[i] ?? 0);
  const confidence = ocr?.confidence ?? 0;
  const caseSensitive = q.answer.case_sensitive === true;
  // 人工批改判定（manual_fill 模式）优先于文本匹配
  const manual = ocr?.manual_verdict ?? [];
  const matched = texts.map((t, i) =>
    manual[i] ? manual[i] === 'correct' : matchRule(blanks[i].match, t, caseSensitive));
  const hasText = texts.some((t) => t.length > 0) || manual.some((v) => v !== undefined);
  const matchedAll = matched.every(Boolean);
  const matchedAny = matched.some(Boolean);
  const engine = ocr?.engine;

  const scoring = q.answer.scoring ?? 'per_blank';
  let score: number;
  if (scoring === 'all_or_nothing') {
    score = matchedAll ? q.score : 0;
  } else {
    // per_blank：逐空 points（缺省均分）
    score = matched.reduce((sum, ok, i) => sum + (ok ? (blanks[i].points ?? q.score / n) : 0), 0);
    const sumPoints = blanks.reduce((s, b, i) => s + (b.points ?? q.score / n), 0);
    if (matchedAll && sumPoints < q.score) {
      score = q.score; // 全对奖励分
    }
  }

  let verdict: Verdict;
  let reason: string | undefined;
  // 低置信判定：任一非空作答空格的置信度 < 阈值 → review（人工判定空除外）
  const lowConf = texts.some((t, i) =>
    t.trim().length > 0 && !manual[i] && confidences[i] < thresholds.ocr_min_confidence);
  // OCR 候选冲突：首选判错，但备选候选（多路径：det/rec/裁边 rec）能匹配标准答案
  // → 识别歧义，转人工复核（避免高置信静默误判，如 vehicle→vehide）
  const alts = ocr?.alternatives ?? [];
  const altCanMatch = alts.some((altList, i) =>
    !matched[i]
    && (altList ?? []).some((a) => a.text.trim().length > 0
      && matchRule(blanks[i].match, a.text, caseSensitive)),
  );
  if (!hasText) {
    verdict = 'incorrect'; // 未作答
  } else if (lowConf) {
    verdict = 'review';
    reason = '填空识别置信度低';
  } else if (matchedAll) {
    verdict = 'correct';
  } else if (altCanMatch) {
    verdict = 'review';
    reason = 'OCR 候选冲突（识别歧义，请人工确认）';
  } else if (matchedAny && scoring !== 'all_or_nothing') {
    verdict = 'partial';
  } else {
    // all_or_nothing 部分匹配或全不匹配 → 整题 0 分
    verdict = 'incorrect';
  }

  return {
    ...base,
    student_answer: texts.join(' | '),
    correct_answer: blanks.map((b) => expectedAnswerText(b.match)).join(' | '),
    raw: {
      fill: [],
      selected: [],
      suspicious: [],
      texts,
      confidences: confidences.map((c) => Number(c.toFixed(4))),
      matched,
      ...(manual.some((v) => v !== undefined) ? { manual_verdict: [...manual] } : {}),
      ...(alts.length ? { alternatives: alts } : {}),
      ...(engine ? { ocr_engine: engine } : {}),
    },
    confidence: Number(confidence.toFixed(4)),
    verdict,
    score: Number(score.toFixed(4)),
    ...(reason ? { review_reason: reason } : {}),
  };
}

function sectionTypeOf(q: Question, amf: AMF): AnswerRecord['type'] {
  for (const sec of amf.paper.sections) {
    if (sec.questions.some((x) => x.id === q.id)) return sec.type;
  }
  return isFillBlank(q) ? 'fill_blank' : 'single_choice';
}

/** 涂卡置信度：涂选组最高填充率与其余最高填充率的间隔；未涂时随最高填充率下降 */
function bubbleConfidence(fill: number[], selected: number[], suspiciousFloor: number): number {
  if (fill.length === 0) return 0;
  const sorted = [...fill].sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  if (selected.length > 0) {
    return Math.min(1, Math.max(0, 1 - Math.exp(-CONF_K * (top - second))));
  }
  const margin = suspiciousFloor - top;
  return Math.min(1, Math.max(0, 1 - Math.exp(-CONF_K * Math.max(margin, -1))));
}
