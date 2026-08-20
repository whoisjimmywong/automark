/**
 * 导出服务：批改结果 → 单个 XLSX 工作簿（四工作表，列名英文固定，对齐 §9.3）。
 *  Metadata / StudentAnswers / StudentScores / ClassReport
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { AMF } from '../../../shared/amf.types.js';
import { allQuestions, isChoice } from '../../../shared/amf.types.js';
import type { StudentResult } from '../../../shared/results.types.js';
import { exportsDir } from './scanManager.js';

export interface ExportOutcome {
  ok: boolean;
  file?: string;
  name?: string;
  error?: string;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** 生成 XLSX 到 exports/，返回文件路径 */
export async function exportResults(examId: string, students: StudentResult[], amf: AMF): Promise<ExportOutcome> {
  try {
    if (students.length === 0) {
      return { ok: false, error: '没有可导出的批改结果（请先批改）' };
    }
    const dir = exportsDir(examId);
    fs.mkdirSync(dir, { recursive: true });

    const wb = new ExcelJS.Workbook();
    const questions = allQuestions(amf);

    // ---------------------------------------------------------- Metadata --
    const meta = wb.addWorksheet('Metadata');
    const exam = amf.exam;
    const metaRows: Array<[string, string]> = [
      ['exam_id', exam.id],
      ['title', exam.title],
      ['subject', exam.subject],
      ['grade', exam.grade ?? ''],
      ['exported_at', new Date().toISOString()],
      ['schema_version', amf.version],
      ['engine', 'AutoMark v0.1 / amf-layout@0.1'],
      ['grading_scope', 'M2 客观题 + M3 填空 OCR（RapidOCR）'],
      ['student_count', String(students.length)],
      ['full_score_objective', fmt(students[0]?.full_score ?? 0)],
    ];
    meta.addRow(['key', 'value']);
    for (const r of metaRows) meta.addRow(r);
    meta.getRow(1).font = { bold: true };

    // ------------------------------------------------------- StudentAnswers
    const sa = wb.addWorksheet('StudentAnswers');
    sa.columns = [
      { header: 'student_id', key: 'student_id', width: 14 },
      { header: 'name', key: 'name', width: 12 },
      { header: 'source_file', key: 'source_file', width: 24 },
      { header: 'page', key: 'page', width: 6 },
      { header: 'question_id', key: 'question_id', width: 10 },
      { header: 'number', key: 'number', width: 7 },
      { header: 'type', key: 'type', width: 16 },
      { header: 'student_answer', key: 'student_answer', width: 12 },
      { header: 'correct_answer', key: 'correct_answer', width: 12 },
      { header: 'verdict', key: 'verdict', width: 10 },
      { header: 'confidence', key: 'confidence', width: 10 },
      { header: 'score', key: 'score', width: 7 },
      { header: 'max_score', key: 'max_score', width: 9 },
    ];
    for (const s of students) {
      for (const a of s.answers) {
        sa.addRow({
          student_id: s.student.id,
          name: s.student.name ?? '',
          source_file: s.student.source_file,
          page: a.page ?? '',
          question_id: a.qid,
          number: a.number,
          type: a.type,
          student_answer: a.student_answer,
          correct_answer: a.correct_answer,
          verdict: a.verdict,
          confidence: Number(a.confidence.toFixed(3)),
          score: a.score,
          max_score: a.max_score,
        });
      }
    }
    sa.getRow(1).font = { bold: true };

    // -------------------------------------------------------- StudentScores
    const ss = wb.addWorksheet('StudentScores');
    const qcols = questions.map((q) => ({ header: `q${q.number}`, key: q.id, width: 7 }));
    ss.columns = [
      { header: 'student_id', key: 'student_id', width: 14 },
      { header: 'name', key: 'name', width: 12 },
      ...qcols,
      { header: 'total_score', key: 'total_score', width: 11 },
      { header: 'full_score', key: 'full_score', width: 10 },
      { header: 'ratio', key: 'ratio', width: 8 },
    ];
    const scoreByQid = (s: StudentResult) => {
      const m = new Map(s.answers.map((a) => [a.qid, a.score]));
      return m;
    };
    const pendingByQid = (s: StudentResult) => new Set(
      s.answers.filter((a) => a.verdict === 'pending').map((a) => a.qid),
    );
    for (const s of students) {
      const m = scoreByQid(s);
      const pending = pendingByQid(s);
      const row: Record<string, unknown> = {
        student_id: s.student.id,
        name: s.student.name ?? '',
        total_score: s.total_score,
        full_score: s.full_score,
        ratio: s.full_score > 0 ? Number((s.total_score / s.full_score).toFixed(3)) : 0,
      };
      for (const q of questions) {
        if (q.answer.kind === 'text') row[q.id] = pending.has(q.id) ? '待批改' : (m.get(q.id) ?? 0);
        else row[q.id] = m.get(q.id) ?? 0;
      }
      ss.addRow(row);
    }
    ss.getRow(1).font = { bold: true };

    // ---------------------------------------------------------- ClassReport
    const cr = wb.addWorksheet('ClassReport');
    const totals = students.map((s) => s.total_score);
    const full = students[0]?.full_score ?? 0;
    const avg = totals.reduce((a, b) => a + b, 0) / Math.max(totals.length, 1);
    const sorted = [...totals].sort((a, b) => a - b);
    const median = sorted.length ? (sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0;
    const variance = totals.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(totals.length, 1);
    const pass = totals.filter((t) => full > 0 && t / full >= 0.6).length;
    const buckets = ['0-20', '20-40', '40-60', '60-80', '80-100'];
    const bucketCounts = buckets.map(() => 0);
    for (const t of totals) {
      const ratio = full > 0 ? t / full : 0;
      const idx = Math.min(buckets.length - 1, Math.floor(ratio * 5));
      bucketCounts[idx] += 1;
    }

    cr.addRow(['metric', 'value']);
    cr.addRow(['student_count', students.length]);
    cr.addRow(['avg_score', Number(avg.toFixed(2))]);
    cr.addRow(['max_score', totals.length ? Math.max(...totals) : 0]);
    cr.addRow(['min_score', totals.length ? Math.min(...totals) : 0]);
    cr.addRow(['median_score', Number(median.toFixed(2))]);
    cr.addRow(['stddev', Number(Math.sqrt(variance).toFixed(2))]);
    cr.addRow(['pass_rate_60', full > 0 ? Number((pass / students.length).toFixed(3)) : 0]);
    buckets.forEach((b, i) => cr.addRow([`bucket_${b}`, bucketCounts[i]]));
    cr.addRow([]);
    cr.addRow(['question_id', 'number', 'correct_rate', 'option_A', 'option_B', 'option_C', 'option_D',
               'option_E', 'option_F', 'option_G', 'option_H']);
    for (const q of questions) {
      if (!isChoice(q)) continue;
      const rows = students.flatMap((s) => s.answers.filter((a) => a.qid === q.id));
      if (!rows.length) continue;
      const correctN = rows.filter((a) => a.verdict === 'correct' || a.verdict === 'partial').length;
      const nOpts = q.answer.kind === 'tf' ? 2 : q.options.length;
      const optCounts = Array.from({ length: Math.max(nOpts, 8) }, () => 0);
      for (const a of rows) {
        for (const i of a.raw.selected) if (i < optCounts.length) optCounts[i] += 1;
      }
      cr.addRow([
        q.id, q.number,
        Number((correctN / Math.max(rows.length, 1)).toFixed(3)),
        ...optCounts.map((c) => c),
      ]);
    }
    cr.getRow(1).font = { bold: true };

    const name = `results_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.xlsx`;
    const file = path.join(dir, name);
    await wb.xlsx.writeFile(file);
    return { ok: true, file, name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 最新导出文件路径（下载用） */
export function latestExport(examId: string): string | null {
  const dir = exportsDir(examId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.xlsx')).sort();
  if (files.length === 0) return null;
  return path.join(dir, files[files.length - 1]);
}
