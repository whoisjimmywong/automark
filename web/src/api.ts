/** AutoMark server API 客户端 */
import type { AMF } from '../../shared/amf.types';
import type { AppSettings } from '../../shared/settings.types';

export interface ProjectSummary {
  id: string;
  title: string;
  subject: string;
  grade?: string;
  created_at?: string;
  questionCount: number;
  generated: boolean;
}

export interface AmfError {
  path: string;
  message: string;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error ?? `HTTP ${r.status}`) as Error & { details?: AmfError[] };
    err.details = data.details;
    throw err;
  }
  return data as T;
}

export const api = {
  listProjects: () => req<ProjectSummary[]>('/api/projects'),

  createProject: (input: { title: string; subject: string; grade?: string; mode: 'answer_sheet' | 'on_paper' }) =>
    req<{ id: string; amf: AMF }>('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  loadProject: (id: string) => req<AMF>(`/api/projects/${id}`),

  saveProject: (amf: AMF) =>
    req<{ ok: true }>(`/api/projects/${amf.exam.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(amf),
    }),

  deleteProject: (id: string) => req<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),

  validateAmf: (amf: unknown) =>
    req<{ valid: boolean; errors: AmfError[] }>('/api/amf/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amf }),
    }),

  importAmf: (amf: unknown) =>
    req<{ ok: true; id: string }>('/api/amf/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amf }),
    }),

  generate: (id: string) =>
    req<{ ok: true; pages: { paper: number; answer_sheet: number; answer_key: number } }>(
      `/api/projects/${id}/generate`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    ),

  fileUrl: (id: string, kind: 'paper' | 'answer_sheet' | 'answer_key') =>
    `/api/projects/${id}/files/${kind}`,

  // ------------------------------------------------------------ 批改 ----
  listScans: (id: string) => req<{ scans: ScanFileInfo[] }>(`/api/projects/${id}/scans`),

  uploadScans: (id: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    return req<{ ok: boolean; saved: string[] }>(`/api/projects/${id}/scans`, {
      method: 'POST',
      body: fd,
    });
  },

  deleteScan: (id: string, name: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/scans/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  startGrade: (id: string, mode: 'auto' | 'manual_fill' = 'auto', resumeFrom?: string) =>
    req<{ ok: boolean; jobId: string }>(`/api/projects/${id}/grade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, ...(resumeFrom ? { resume_from: resumeFrom } : {}) }),
    }),

  gradeStatus: (id: string, jobId: string) =>
    req<GradingJobStatus>(`/api/projects/${id}/grade/${jobId}`),

  /** M4：历史批改任务摘要（不含学生明细） */
  listJobs: (id: string) => req<{ jobs: GradingJobSummary[] }>(`/api/projects/${id}/jobs`),

  /** M4：中断运行中的任务 */
  interruptJob: (id: string, jobId: string) =>
    req<{ ok: boolean; status: string }>(`/api/projects/${id}/grade/${jobId}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),

  listResults: (id: string) => req<ResultsSummary>(`/api/projects/${id}/results`),

  loadStudentResult: (id: string, studentId: string) =>
    req<StudentResult>(`/api/projects/${id}/results/${encodeURIComponent(studentId)}`),

  exportResults: (id: string) =>
    req<{ ok: boolean; file?: string }>(`/api/projects/${id}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),

  exportUrl: (id: string) => `/api/projects/${id}/files/export`,
  processedUrl: (id: string, name: string) =>
    `/api/projects/${id}/files/processed/${encodeURIComponent(name)}`,

  // ------------------------------------------------------------ 复核 ----
  listReviewItems: (id: string) =>
    req<{ items: ReviewItem[] }>(`/api/projects/${id}/review-items`),

  reviewCrop: (id: string, studentId: string, qid: string) =>
    req<{ ok: boolean; png_b64: string }>(
      `/api/projects/${id}/review-items/${encodeURIComponent(studentId)}/${encodeURIComponent(qid)}/crop`,
    ),

  /** 人工批改：直接按结果+positions 裁剪该题作答区（不限于复核队列；blank 多空下标） */
  answerCrop: (id: string, studentId: string, qid: string, blank?: number) =>
    req<{ ok: boolean; png_b64: string }>(
      `/api/projects/${id}/results/${encodeURIComponent(studentId)}/${encodeURIComponent(qid)}/crop`
      + (blank !== undefined ? `?blank=${blank}` : ''),
    ),

  applyReview: (
    id: string,
    studentId: string,
    qid: string,
    decision: ReviewDecision,
  ) =>
    req<{ ok: boolean; remaining: number; result: { total_score: number; full_score: number } }>(
      `/api/projects/${id}/review-items/${encodeURIComponent(studentId)}/${encodeURIComponent(qid)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decision),
      },
    ),

  // ------------------------------------------------------------ 设置 ----
  getSettings: () => req<{ settings: AppSettings }>('/api/settings'),

  saveSettings: (settings: AppSettings) =>
    req<{ settings: AppSettings }>('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    }),
};

export interface ScanFileInfo {
  name: string;
  size: number;
  kind: 'pdf' | 'image';
  uploaded_at: string;
}

export interface GradingJobStatus {
  id: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  total_pages: number;
  processed_pages: number;
  student_count: number;
  created_at: string;
  finished_at?: string;
}

/** M4：历史批改任务摘要（不含学生明细） */
export interface GradingJobSummary {
  id: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  error?: string;
  mode: 'auto' | 'manual_fill';
  total_pages: number;
  processed_pages: number;
  student_count: number;
  processed_students: number;
  resumed_from?: string;
  created_at: string;
  finished_at?: string;
}

export interface ResultsSummary {
  students: Array<{
    student_id: string;
    name: string | null;
    source_file: string;
    total_score: number;
    full_score: number;
    review_required: boolean;
    pending_fill?: number;
  }>;
  review_items: Array<{ student_id: string; qid: string; reason: string }>;
}

export interface StudentResult {
  exam_id: string;
  student: {
    id: string;
    name: string | null;
    source_file: string;
    page_indexes: number[];
    id_from_bubbles: boolean;
  };
  answers: Array<{
    qid: string;
    type: string;
    number: number;
    student_answer: string;
    correct_answer: string;
    raw: {
      fill: number[];
      selected: number[];
      suspicious: number[];
      texts?: string[];
      confidences?: number[];
      matched?: boolean[];
      ocr_engine?: string;
      alternatives?: { text: string; confidence: number; mode: string }[][];
      manual_verdict?: Array<'correct' | 'incorrect' | 'blank' | null>;
    };
    page?: number;
    confidence: number;
    verdict: string;
    score: number;
    max_score: number;
    review_reason?: string;
  }>;
  total_score: number;
  full_score: number;
  review_required: boolean;
  /** manual_fill 模式下待人工批改的填空题数 */
  pending_fill?: number;
  graded_at: string;
  warnings: string[];
  review_log?: Array<{
    qid: string;
    decision: ReviewDecision;
    resolved_at: string;
    previous_verdict?: string;
    new_verdict?: string;
  }>;
}

export interface ReviewItem {
  student_id: string;
  qid: string;
  number: number;
  type: string;
  reason: string;
  confidence: number;
  student_answer: string;
  correct_answer: string;
  page: number;
  blank?: number;
  /** 填空 OCR 备选候选（逐空） */
  alternatives?: { text: string; confidence: number; mode: string }[][];
  crop: { file: string; rect: number[]; kind: 'ocr' | 'bubble'; options?: number };
}

export type ReviewDecision =
  | { action: 'accept' }
  | { action: 'override_text'; text: string; blank?: number }
  | { action: 'mark_blank'; blank?: number }
  | { action: 'select'; options: number[] }
  | { action: 'manual_set'; blank: number; verdict: 'correct' | 'incorrect' | 'blank' };
