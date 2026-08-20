/**
 * AMF (AutoMark File) — 组卷工程/答案权威来源的 TypeScript 类型定义。
 * 与 shared/amf.schema.ts 一一对应（schema 用于运行时校验，本文件用于静态类型）。
 * 坐标单位一律为 mm，原点为页面左上角（与 PDF 物理坐标解耦，批改用 DPI 换算像素）。
 */

export const AMF_VERSION = '0.1' as const;

export type PaperMode = 'answer_sheet' | 'on_paper';

export type SectionType = 'single_choice' | 'multiple_choice' | 'true_false' | 'fill_blank';

// ---------------------------------------------------------------- exam ----
export interface ExamInfo {
  /** 全局唯一 ID；生成时若缺省由系统自动补全（exam_xxxxxxxx） */
  id: string;
  title: string;
  subject: string;
  grade?: string;
  duration_min?: number;
  created_at?: string;
}

export interface PaperTemplate {
  title: string;
  subtitle?: string;
  instructions?: string;
  header?: {
    show_name?: boolean;
    show_student_id?: boolean;
  };
  /** 页脚模板，支持 {page} 与 {pages} 占位符 */
  footer?: string;
}

// -------------------------------------------------------------- answers ----
export interface SingleAnswer {
  kind: 'single';
  /** 正确选项下标（0 起） */
  correct: number;
}

export interface MultipleScoring {
  /** 全对得分（默认 = 题目分值） */
  full?: number;
  /** 漏选（所选皆为正确项但不全）得分，默认满分 × 0.5 */
  partial?: number;
  /** 错选/多选/未涂得分，默认 0 */
  wrong?: number;
}

export interface MultipleAnswer {
  kind: 'multiple';
  /** 正确选项下标集合（0 起，≥1 个） */
  correct: number[];
  scoring?: MultipleScoring;
}

export interface TrueFalseAnswer {
  kind: 'tf';
  /** 0 = 第一个标签（默认 T），1 = 第二个标签（默认 F） */
  correct: 0 | 1;
}

export type MatchRule =
  | { type: 'exact'; value: string }
  | { type: 'any_of'; values: string[] }
  | { type: 'regex'; pattern: string }
  | { type: 'numeric'; value: number; tolerance: number };

/** 单个空格：匹配规则 + 分空赋分（分）。
 * per_blank 模式下答对第 i 空得 points_i 分；
 * 若 Σpoints < 题目总分，差值为"全对奖励分"（仅全部答对时获得）；
 * Σpoints 不得超过题目总分；缺省按均分处理。 */
export interface BlankSpec {
  match: MatchRule;
  points?: number;
}

export type FillScoring = 'all_or_nothing' | 'per_blank';

export interface TextAnswer {
  kind: 'text';
  /**
   * 多空格式（1–5 空）。与 match 互斥；
   * 缺省 scoring：多空时按 per_blank（均分权重）处理。
   */
  blanks?: BlankSpec[];
  scoring?: FillScoring;
  /** 旧版单空格式（等价于 blanks:[{match}]），与 blanks 互斥 */
  match?: MatchRule;
  /**
   * 严格大小写判定（默认 false=非严格）：
   * 非严格下归一化忽略大小写（CAR≈car≈Car 都对）；
   * 严格下仅大小写完全一致才匹配（正确答案 CAR 只有 CAR 算对）。
   * 不影响 NFKC/空白/全半角/句尾标点归一化。
   */
  case_sensitive?: boolean;
}

/** 归一化取空格列表（兼容旧版 match 单空格式） */
export function blanksOf(a: TextAnswer): BlankSpec[] {
  if (a.blanks && a.blanks.length > 0) return a.blanks;
  return a.match ? [{ match: a.match }] : [];
}

export const BLANK_MIN = 1;
export const BLANK_MAX = 5;
export const OPTION_MIN = 2;
export const OPTION_MAX = 8;

export type Answer = SingleAnswer | MultipleAnswer | TrueFalseAnswer | TextAnswer;

// ------------------------------------------------------------ questions ----
/** 选择题选项在试卷上的排列形式（默认 vertical 竖排）：
 *  - row：单排一行，按选项个数等分整行宽度（每选项一列均分）
 *  - rows2：两行，第一行靠左排前若干项，第二行剩余，如 ABC / DE
 *  - cols2：两列行主序，如 AB / CD / E（最后一项靠左）
 *  - vertical：每选项一行（答题卡气泡布局不受影响，机器可读保持不变） */
export type OptionsLayout = 'row' | 'rows2' | 'cols2' | 'vertical';

export interface QuestionBase {
  id: string;
  /** 题号（全卷唯一、连续，由编辑器自动重排） */
  number: number;
  /** 分值（满分） */
  score: number;
  /** 题干（富文本的纯文本序列化，首版不内嵌图片） */
  prompt: string;
  /** 本题目前强制分页（仅在不在页首时生效） */
  page_break_before?: boolean;
  /** 本题目前的空行高度（mm，手动排版用） */
  gap_before_mm?: number;
  /** 隐藏题干：试卷上不显示该题（含题号），答题卡/答案卷/批改照常 */
  hidden?: boolean;
}

export interface ChoiceQuestion extends QuestionBase {
  options: string[];
  /** 选项排列形式（试卷上；答题卡气泡等距不变） */
  options_layout?: OptionsLayout;
  answer: SingleAnswer | MultipleAnswer | TrueFalseAnswer;
}

export interface FillBlankQuestion extends QuestionBase {
  answer: TextAnswer;
  layout?: {
    /** 作答框行数（每行 8mm），默认 1 */
    lines?: number;
  };
}

export type Question = ChoiceQuestion | FillBlankQuestion;

/** 阅读材料/完形篇章（section 级，渲染在标题后、题目列表前一次）。
 * html 支持与 prompt 相同的富文本子集；题目 prompt 可留空（仅题号+选项/空），
 * 避免文章与题目重复显示造成混乱。 */
export interface SectionPassage {
  title?: string;
  html: string;
}

export interface Section {
  id: string;
  type: SectionType;
  title?: string;
  /** 板块标题（如 "Part 1 Listening"）：多个相邻 section 共用同一 part_title 时只显示一次，
   * 大题标题用 title（如 "I. Conversation"） */
  part_title?: string;
  instructions?: string;
  passage?: SectionPassage;
  /** 本分区前强制分页 */
  page_break_before?: boolean;
  /** 本分区前的空行高度（mm） */
  gap_before_mm?: number;
  questions: Question[];
}

// ------------------------------------------------------- answer sheet ------
export interface AnswerSheetConfig {
  page_size?: 'A4';
  orientation?: 'portrait';
  mark_style?: 'ellipse' | 'circle';
  /** 气泡直径，默认 3.0mm */
  bubble_size_mm?: number;
  /** 同题相邻气泡中心距，默认 8.0mm */
  bubble_pitch_mm?: number;
  student_id?: {
    kind: 'bubble';
    /** 学号位数，默认 6 */
    digits: number;
  };
  markers?: {
    corners?: boolean;
    qr?: boolean;
    barcode?: boolean;
  };
  /** 判断题选项标签，默认 ["T", "F"]，可改为 ["对","错"] 等 */
  tf_labels?: [string, string];
  /** 页脚印刷说明（如 "Use a pencil..."） */
  footer_note?: string;
  /** 首页缺考/异常标记圈（ABSENT/WITHDRAWN），默认 true */
  absent_mark?: boolean;
}

// ------------------------------------------------------------ positions ----
/** [x1, y1, x2, y2]，mm，页面左上角原点 */
export type RectMM = [number, number, number, number];
/** [x, y]，mm，页面左上角原点 */
export type PointMM = [number, number];

export interface BlockPosition {
  qid: string;
  kind: 'bubble' | 'ocr';
  /** 题块整体外接矩形；bubble 块覆盖全部选项气泡，ocr 块为作答框 */
  rect: RectMM;
  /** bubble 块：选项个数 */
  options?: number;
  /** ocr 块：行数 */
  lines?: number;
  /** ocr 块：空格下标（单空为 0）——逐空记录，批改侧按此重建 ROI */
  blank?: number;
}

export type PageRole = 'paper' | 'answer_sheet';

export interface PagePositions {
  page: number;
  role: PageRole;
  markers: {
    /** 四角 L 标的中心点，顺序：左上、右上、左下、右下 */
    corners: PointMM[];
    /** 二维码矩形 */
    qr: RectMM;
  };
  blocks: BlockPosition[];
  /** 学号涂卡区外接矩形（模式 A 每页重复） */
  student_id_rect?: RectMM;
  /** 缺考/异常标记圈外接矩形（模式 A 首页） */
  absent_rect?: RectMM;
}

export interface Positions {
  pages: PagePositions[];
}

// ------------------------------------------------------------------ AMF ----
export interface AMF {
  version: string;
  exam: ExamInfo;
  paper: {
    mode: PaperMode;
    template: PaperTemplate;
    sections: Section[];
  };
  answer_sheet_config?: AnswerSheetConfig;
  /** 由布局引擎在生成后回填（批改的权威坐标来源） */
  positions?: Positions;
  metadata?: {
    generator?: string;
    layout_engine?: string;
    [k: string]: unknown;
  };
}

// ------------------------------------------------------------- helpers -----
export const SECTION_TYPE_LABEL: Record<SectionType, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  true_false: '判断题',
  fill_blank: '填空题',
};

export function isFillBlank(q: Question): q is FillBlankQuestion {
  return q.answer.kind === 'text';
}

export function isChoice(q: Question): q is ChoiceQuestion {
  return q.answer.kind !== 'text';
}

/** 全卷题目（按 sections 顺序展开） */
export function allQuestions(amf: AMF): Question[] {
  return amf.paper.sections.flatMap((s) => s.questions);
}

/** 全卷满分 */
export function fullScore(amf: AMF): number {
  return allQuestions(amf).reduce((sum, q) => sum + q.score, 0);
}

/** 判断题显示标签（默认 T/F） */
export function tfLabels(amf: AMF): [string, string] {
  return amf.answer_sheet_config?.tf_labels ?? ['T', 'F'];
}

/** 客观题选项标签：A, B, C, ... */
export function optionLabel(index: number): string {
  return String.fromCharCode(65 + index);
}
