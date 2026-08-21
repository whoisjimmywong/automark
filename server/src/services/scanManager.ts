/**
 * 扫描件管理：data/exams/<id>/scans/ 目录即扫描件仓库。
 * 支持 PDF（多页）与单页图片（png/jpg）；批改时逐页分析。
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_ROOT = process.env.AUTOMARK_DATA_DIR
  ? path.resolve(process.env.AUTOMARK_DATA_DIR, 'exams')
  : path.resolve(process.cwd(), '..', 'data', 'exams');

function scansDir(examId: string): string {
  return path.join(DATA_ROOT, examId, 'scans');
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);

export interface ScanFileInfo {
  name: string;
  size: number;
  kind: 'pdf' | 'image';
  uploaded_at: string;
}

export function ensureScansDir(examId: string): void {
  fs.mkdirSync(scansDir(examId), { recursive: true });
}

export function listScans(examId: string): ScanFileInfo[] {
  ensureScansDir(examId);
  const dir = scansDir(examId);
  const out: ScanFileInfo[] = [];
  for (const n of fs.readdirSync(dir)) {
    const ext = path.extname(n).toLowerCase();
    if (ext !== '.pdf' && !IMAGE_EXT.has(ext)) continue;
    const st = fs.statSync(path.join(dir, n));
    out.push({
      name: n,
      size: st.size,
      kind: ext === '.pdf' ? 'pdf' : 'image',
      uploaded_at: st.mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
}

export function scanPath(examId: string, name: string): string | null {
  const p = path.join(scansDir(examId), path.basename(name));
  return fs.existsSync(p) ? p : null;
}

export function deleteScan(examId: string, name: string): boolean {
  const p = scanPath(examId, name);
  if (!p) return false;
  fs.rmSync(p, { force: true });
  return true;
}

/** 保存上传文件（重名加时间戳前缀，避免覆盖） */
export function saveUploaded(examId: string, filename: string, data: Buffer): string {
  ensureScansDir(examId);
  const safe = path.basename(filename).replace(/[^\w.\-一-龥]/g, '_');
  const ts = Date.now().toString(36);
  const name = fs.existsSync(path.join(scansDir(examId), safe)) ? `${ts}_${safe}` : safe;
  fs.writeFileSync(path.join(scansDir(examId), name), data);
  return name;
}

export function processedDir(examId: string): string {
  return path.join(DATA_ROOT, examId, 'processed');
}

export function resultsDir(examId: string): string {
  return path.join(DATA_ROOT, examId, 'results');
}

export function exportsDir(examId: string): string {
  return path.join(DATA_ROOT, examId, 'exports');
}

export function processedPagePath(examId: string, name: string): string | null {
  const p = path.join(processedDir(examId), path.basename(name));
  return fs.existsSync(p) ? p : null;
}

export function resultsFilePath(examId: string, studentId: string): string {
  return path.join(resultsDir(examId), `${safeId(studentId)}.json`);
}

export function listResultFiles(examId: string): string[] {
  const dir = resultsDir(examId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
}

/** 学号 → 安全文件名（兜底学号 S1 等本就安全） */
export function safeId(id: string): string {
  return id.replace(/[^\w\-]/g, '_');
}
