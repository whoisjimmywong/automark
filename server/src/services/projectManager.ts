/**
 * 考试项目管理：data/exams/<exam_id>/ 目录即项目。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AMF } from '../../../shared/amf.types.js';
import { AMF_VERSION } from '../../../shared/amf.types.js';

export interface ProjectSummary {
  id: string;
  title: string;
  subject: string;
  grade?: string;
  created_at?: string;
  questionCount: number;
  generated: boolean;
}

const DATA_ROOT = process.env.AUTOMARK_DATA_DIR
  ? path.resolve(process.env.AUTOMARK_DATA_DIR, 'exams')
  : path.resolve(process.cwd(), '..', 'data', 'exams');

function projectDir(examId: string): string {
  return path.join(DATA_ROOT, examId);
}

function amfPath(examId: string): string {
  return path.join(projectDir(examId), 'project.amf.json');
}

const SUBDIRS = ['generated', 'scans', 'processed', 'results', 'exports'];

export function ensureDataRoot(): void {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
}

export function newExamId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `exam_${ts}${rand}`;
}

export function projectExists(examId: string): boolean {
  return fs.existsSync(amfPath(examId));
}

export function listProjects(): ProjectSummary[] {
  ensureDataRoot();
  const out: ProjectSummary[] = [];
  for (const name of fs.readdirSync(DATA_ROOT)) {
    const p = amfPath(name);
    if (!fs.existsSync(p)) continue;
    try {
      const amf = JSON.parse(fs.readFileSync(p, 'utf-8')) as AMF;
      const generated = fs.existsSync(path.join(projectDir(name), 'generated', 'paper.pdf'));
      out.push({
        id: amf.exam.id,
        title: amf.exam.title,
        subject: amf.exam.subject,
        grade: amf.exam.grade,
        created_at: amf.exam.created_at,
        questionCount: amf.paper.sections.reduce((n, s) => n + s.questions.length, 0),
        generated,
      });
    } catch {
      // 损坏的项目文件：跳过（不阻塞列表）
    }
  }
  return out.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

export function loadProject(examId: string): AMF | null {
  const p = amfPath(examId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as AMF;
}

export function saveProject(amf: AMF): void {
  const dir = projectDir(amf.exam.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(amfPath(amf.exam.id), JSON.stringify(amf, null, 2), 'utf-8');
}

export function deleteProject(examId: string): boolean {
  const dir = projectDir(examId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 由 AMF 创建新项目；若 id 冲突则换新 id。返回最终 id。 */
export function importProject(amf: AMF): string {
  if (projectExists(amf.exam.id)) {
    amf.exam.id = newExamId();
  }
  // 导入的工程不携带旧 positions（版面可能已变化），由下次生成时回填
  delete amf.positions;
  saveProject(amf);
  return amf.exam.id;
}

/** 新建空白工程 */
export function createBlankProject(input: {
  title: string;
  subject: string;
  grade?: string;
  mode: 'answer_sheet' | 'on_paper';
}): AMF {
  const amf: AMF = {
    version: AMF_VERSION,
    exam: {
      id: newExamId(),
      title: input.title,
      subject: input.subject,
      ...(input.grade ? { grade: input.grade } : {}),
      created_at: new Date().toISOString(),
    },
    paper: {
      mode: input.mode,
      template: {
        title: input.title,
        header: { show_name: true, show_student_id: true },
        footer: 'Page {page} of {pages}',
      },
      sections: [
        {
          id: 'sec_1',
          type: 'single_choice',
          title: 'Section A',
          questions: [],
        },
      ],
    },
    ...(input.mode === 'answer_sheet'
      ? {
          answer_sheet_config: {
            page_size: 'A4' as const,
            orientation: 'portrait' as const,
            mark_style: 'ellipse' as const,
            bubble_size_mm: 3.0,
            bubble_pitch_mm: 8.0,
            student_id: { kind: 'bubble' as const, digits: 12 },
            markers: { corners: true, qr: true, barcode: false },
            absent_mark: true,
          },
        }
      : {}),
    metadata: { generator: 'AutoMark v0.1' },
  };
  // 空白分区不允许保存为空（schema 要求 minItems:1）——但新建工程允许草稿态
  saveProject(amf);
  return amf;
}

export function generatedDir(examId: string): string {
  return path.join(projectDir(examId), 'generated');
}

export function generatedFilePath(examId: string, kind: string): string | null {
  const map: Record<string, string> = {
    paper: 'paper.pdf',
    answer_sheet: 'answer_sheet.pdf',
    answer_key: 'answer_key.pdf',
    amf: 'project.amf.json',
  };
  const file = map[kind];
  if (!file) return null;
  const p = kind === 'amf' ? amfPath(examId) : path.join(generatedDir(examId), file);
  return fs.existsSync(p) ? p : null;
}
