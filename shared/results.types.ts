/**
 * 批改结果类型（M2 客观题 + M3 填空 OCR 批改）。
 * 结构对齐 product_dev §9.2 批改结果 JSON；列名英文固定（导出兼容存档）。
 */
import type { RectMM, SectionType } from './amf.types.js';

export type Verdict = 'correct' | 'incorrect' | 'partial' | 'review' | 'pending';

/** 单题作答原始记录 + 判定 */
export interface AnswerRecord {
  qid: string;
  type: SectionType;
  /** 题号（全卷连续编号） */
  number: number;
  /** 学生作答（选项字母序列如 "B,C"；填空为逐空文本 "go | by"） */
  student_answer: string;
  /** 标准答案（字母序列 / T·F / 填空期望文本） */
  correct_answer: string;
  /** 原始识别数据：涂卡题 = 逐选项填充率；填空 = 逐空文本/置信度/匹配结果 */
  raw: {
    fill: number[];
    selected: number[];
    suspicious: number[];
    texts?: string[];
    confidences?: number[];
    matched?: boolean[];
    ocr_engine?: string;
    /** 填空 OCR 备选候选（逐空；首选判错且备选可匹配标准答案时转复核） */
    alternatives?: { text: string; confidence: number; mode: string }[][];
    /** 人工批改逐空判定（manual_fill 模式；存在时优先于文本匹配） */
    manual_verdict?: ('correct' | 'incorrect' | 'blank')[];
  };
  /** 该题出自扫描第几页（QR 页码） */
  page?: number;
  confidence: number;
  verdict: Verdict;
  score: number;
  max_score: number;
  review_reason?: string;
}

export interface StudentIdentity {
  /** 学号（涂卡读出或顺序兜底 S<n>） */
  id: string;
  name: string | null;
  source_file: string;
  /** 该生占用的扫描页下标（0 起） */
  page_indexes: number[];
  /** true = 学号由涂卡区读出；false = 按扫描顺序兜底 */
  id_from_bubbles: boolean;
  /** true = 答题卡涂了 ABSENT/WITHDRAWN 缺考/异常标记（不计分） */
  absent?: boolean;
}

export interface ReviewItem {
  student_id: string;
  qid: string;
  number: number;
  type: SectionType;
  reason: string;
  confidence: number;
  student_answer: string;
  correct_answer: string;
  /** 该题所在扫描页（QR 页码） */
  page: number;
  /** 填空：置信度最低的空下标（裁剪与改判目标） */
  blank?: number;
  /** 填空 OCR 备选候选（逐空；多路径 det/rec/裁边 rec） */
  alternatives?: { text: string; confidence: number; mode: string }[][];
  /** 复核原图裁剪信息 */
  crop: { file: string; rect: RectMM; kind: 'ocr' | 'bubble'; options?: number };
}

export type ReviewDecision =
  | { action: 'accept' }
  | { action: 'override_text'; text: string; blank?: number }
  | { action: 'mark_blank'; blank?: number }
  | { action: 'select'; options: number[] }
  | { action: 'manual_set'; blank: number; verdict: 'correct' | 'incorrect' | 'blank' };

export interface ReviewLogEntry {
  qid: string;
  decision: ReviewDecision;
  resolved_at: string;
  previous_verdict?: Verdict;
  new_verdict?: Verdict;
}

export interface StudentResult {
  exam_id: string;
  student: StudentIdentity;
  answers: AnswerRecord[];
  /** 客观题 + 填空得分合计 */
  total_score: number;
  /** 全卷满分 */
  full_score: number;
  review_required: boolean;
  graded_at: string;
  warnings: string[];
  /** manual_fill 模式下待人工批改的填空题数（未批完时 > 0） */
  pending_fill?: number;
  /** 复核记录（审计；改判后追加） */
  review_log?: ReviewLogEntry[];
}

export interface GradingJob {
  id: string;
  exam_id: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  error?: string;
  total_pages: number;
  processed_pages: number;
  students: StudentResult[];
  created_at: string;
  finished_at?: string;
  /** true = manual_fill 模式（只自动批选择题，填空题待人工批改） */
  manual_fill?: boolean;
  /** 已处理完的学生学号（断点续跑：跳过这些学生） */
  processed_students?: string[];
  /** 续跑的源 job id（resume_from） */
  resumed_from?: string;
}

export interface ReviewItem {
  student_id: string;
  qid: string;
  reason: string;
}

export interface GradingSummary {
  students: Array<{
    student_id: string;
    name: string | null;
    source_file: string;
    total_score: number;
    full_score: number;
    review_required: boolean;
  }>;
  review_items: ReviewItem[];
}
