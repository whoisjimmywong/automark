/**
 * 识别/文档服务（Python vision）HTTP 客户端。
 */
import type { AMF, Positions } from '../../../shared/amf.types.js';

const VISION_URL = process.env.VISION_URL ?? 'http://127.0.0.1:8791';

export interface RenderResult {
  ok: boolean;
  pdfs: { paper: string; answer_sheet?: string; answer_key: string };
  positions: Positions;
  pages: { paper: number; answer_sheet: number; answer_key: number };
  error?: string;
}

export async function visionHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${VISION_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 请求 vision 服务生成 PDF 三件套并回填 positions */
export async function renderProject(amf: AMF, outDir: string): Promise<RenderResult> {
  const r = await fetch(`${VISION_URL}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amf, out_dir: outDir }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`vision /render 失败 (HTTP ${r.status}): ${text.slice(0, 500)}`);
  }
  return (await r.json()) as RenderResult;
}

// ---------------------------------------------------------------- 批改 ----

export interface ScanInfoResult {
  ok: boolean;
  kind: 'pdf' | 'image';
  pages: number;
  error?: string;
}

export interface AnalyzeScanResult {
  ok: boolean;
  page?: number;
  qr?: { ok: boolean; payload?: string | null; decoded?: unknown; error?: string };
  bubbles?: Array<{
    qid: string;
    options: number;
    fill: number[];
    selected: number[];
    suspicious: number[];
  }>;
  student_id?: { ok: boolean; digits: Array<number | null>; read: string; confidence: number };
  /** 缺考/异常标记（首页 ABSENT/WITHDRAWN 圈是否涂选） */
  absent?: boolean;
  /** M3：填空 OCR（do_ocr=true 时返回） */
  ocr?: Array<{
    qid: string;
    blank: number;
    lines: number;
    text: string;
    confidence: number;
    engine: string;
    error?: string;
    /** 多路径备选候选（det/rec/rec-trim），用于候选冲突复核 */
    alternatives?: Array<{ text: string; confidence: number; mode: string }>;
  }>;
  warnings?: string[];
  error?: string;
}

export async function scanInfo(pdfOrImagePath: string): Promise<ScanInfoResult> {
  const r = await fetch(`${VISION_URL}/scan/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdfOrImagePath, dpi: 150 }),
    signal: AbortSignal.timeout(30_000),
  });
  return (await r.json()) as ScanInfoResult;
}

export async function analyzeScanPage(req: {
  source: { kind: string; path: string; page: number };
  dpi: number;
  exam_id: string;
  positions: NonNullable<AMF['positions']>;
  config: Record<string, unknown>;
  out_png?: string;
  do_ocr?: boolean;
  ocr_config?: Record<string, unknown>;
}): Promise<AnalyzeScanResult> {
  const r = await fetch(`${VISION_URL}/scan/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return { ok: false, error: `vision /scan/analyze 失败 (HTTP ${r.status}): ${text.slice(0, 300)}` };
  }
  return (await r.json()) as AnalyzeScanResult;
}

/** 从矫正页图裁剪 ROI（mm rect），返回 PNG base64（复核界面用） */
export async function cropPage(
  processedPath: string,
  rect: number[],
  padMm = 2.0,
): Promise<string | null> {
  const r = await fetch(`${VISION_URL}/scan/crop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: processedPath, rect, pad_mm: padMm }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await r.json()) as { ok?: boolean; png_b64?: string; error?: string };
  return data.ok ? (data.png_b64 ?? null) : null;
}

/** 渲染扫描页为 PNG（预览用），返回 base64 */
export async function renderScanPage(path: string, page: number, dpi = 150): Promise<string | null> {
  const r = await fetch(`${VISION_URL}/scan/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, page, dpi }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await r.json()) as { ok?: boolean; png_b64?: string; error?: string };
  return data.ok ? (data.png_b64 ?? null) : null;
}
