/**
 * 批改路由：扫描件上传/列表/删除、批改任务、结果、导出。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AMF } from '../../../shared/amf.types.js';
import { loadProject } from '../services/projectManager.js';
import {
  deleteScan,
  listScans,
  processedPagePath,
  saveUploaded,
} from '../services/scanManager.js';
import {
  getJob,
  listStudentResults,
  loadStudentResult,
  startGrading,
  listReviewItems,
  applyReviewDecision,
  findCropRect,
} from '../services/gradingService.js';
import { cropPage } from '../services/visionClient.js';
import { processedDir } from '../services/scanManager.js';
import { loadSettings, redactedSettings, saveSettings } from '../services/settingsService.js';
import type { ReviewDecision } from '../../../shared/results.types.js';
import type { AppSettings } from '../../../shared/settings.types.js';
import { exportResults, latestExport } from '../services/exportService.js';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

export async function registerGradingRoutes(app: FastifyInstance): Promise<void> {
  function requireProject(id: string): { amf: AMF } | { error: string } {
    const amf = loadProject(id);
    if (!amf) return { error: `项目不存在: ${id}` };
    return { amf };
  }

  // ------------------------------------------------------------- scans ----
  app.post<{ Params: { id: string } }>('/api/projects/:id/scans', async (req, reply) => {
    const chk = requireProject(req.params.id);
    if ('error' in chk) return reply.code(404).send({ error: chk.error });
    const saved: string[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of part.file) {
          total += (chunk as Buffer).length;
          if (total > MAX_UPLOAD_BYTES) {
            return reply.code(413).send({ error: '上传文件过大（>200MB）' });
          }
          chunks.push(chunk as Buffer);
        }
        const name = saveUploaded(req.params.id, part.filename ?? 'scan.pdf', Buffer.concat(chunks));
        saved.push(name);
      }
      return { ok: true, saved };
    } catch (err) {
      return reply.code(500).send({
        error: `上传失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/scans', async (req) => ({
    scans: listScans(req.params.id),
  }));

  app.delete<{ Params: { id: string; name: string } }>(
    '/api/projects/:id/scans/:name',
    async (req, reply) => {
      if (!deleteScan(req.params.id, req.params.name)) {
        return reply.code(404).send({ error: '扫描件不存在' });
      }
      return { ok: true };
    },
  );

  // ------------------------------------------------------------- grade ----
  app.post<{ Params: { id: string }; Body: { mode?: 'auto' | 'manual_fill' } }>(
    '/api/projects/:id/grade',
    async (req, reply) => {
      const chk = requireProject(req.params.id);
      if ('error' in chk) return reply.code(404).send({ error: chk.error });
      // manual_fill：只自动批改选择题，填空题留待人工批改
      const manualFill = req.body?.mode === 'manual_fill';
      const job = startGrading(req.params.id, chk.amf, { manualFill });
      return { ok: true, jobId: job.id, mode: manualFill ? 'manual_fill' : 'auto' };
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/api/projects/:id/grade/:jobId',
    async (req, reply) => {
      const job = getJob(req.params.jobId);
      if (!job) return reply.code(404).send({ error: '任务不存在' });
      return {
        id: job.id,
        status: job.status,
        error: job.error,
        total_pages: job.total_pages,
        processed_pages: job.processed_pages,
        student_count: job.students.length,
        created_at: job.created_at,
        finished_at: job.finished_at,
      };
    },
  );

  // ----------------------------------------------------------- results ----
  app.get<{ Params: { id: string } }>('/api/projects/:id/results', async (req) => {
    const results = listStudentResults(req.params.id);
    return {
      students: results.map((r) => ({
        student_id: r.student.id,
        name: r.student.name,
        source_file: r.student.source_file,
        total_score: r.total_score,
        full_score: r.full_score,
        review_required: r.review_required,
        ...(r.pending_fill ? { pending_fill: r.pending_fill } : {}),
      })),
      review_items: results.flatMap((r) =>
        r.answers
          .filter((a) => a.verdict === 'review')
          .map((a) => ({ student_id: r.student.id, qid: a.qid, reason: a.review_reason ?? '' })),
      ),
    };
  });

  app.get<{ Params: { id: string; studentId: string } }>(
    '/api/projects/:id/results/:studentId',
    async (req, reply) => {
      const r = loadStudentResult(req.params.id, req.params.studentId);
      if (!r) return reply.code(404).send({ error: '该学生结果不存在' });
      return r;
    },
  );

  // ------------------------------------------------------------ export ----
  app.post<{ Params: { id: string } }>('/api/projects/:id/export', async (req, reply) => {
    const chk = requireProject(req.params.id);
    if ('error' in chk) return reply.code(404).send({ error: chk.error });
    const results = listStudentResults(req.params.id);
    const out = await exportResults(req.params.id, results, chk.amf);
    if (!out.ok) return reply.code(400).send({ error: out.error });
    return { ok: true, file: out.name };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/files/export', async (req, reply) => {
    const p = latestExport(req.params.id);
    if (!p) return reply.code(404).send({ error: '暂无导出文件（请先批改并导出）' });
    reply.header('content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename="${path.basename(p)}"`);
    return reply.send(fs.createReadStream(p));
  });

  app.get<{ Params: { id: string; studentId: string; qid: string }; Querystring: { blank?: string } }>(
    '/api/projects/:id/results/:studentId/:qid/crop',
    async (req, reply) => {
      const chk = requireProject(req.params.id);
      if ('error' in chk) return reply.code(404).send({ error: chk.error });
      const result = loadStudentResult(req.params.id, req.params.studentId);
      if (!result) return reply.code(404).send({ error: '该学生结果不存在' });
      const a = result.answers.find((x) => x.qid === req.params.qid);
      if (!a) return reply.code(404).send({ error: '该题不在结果中' });
      const page = a.page ?? 1;
      const blank = req.query.blank !== undefined ? Number(req.query.blank) : undefined;
      const crop = findCropRect(chk.amf, page, req.params.qid, blank);
      if (!crop) return reply.code(404).send({ error: '裁剪位置不存在' });
      const p = path.join(processedDir(req.params.id),
        `${result.student.source_file}_p${page}.png`);
      if (!fs.existsSync(p)) return reply.code(404).send({ error: '矫正页图不存在' });
      const b64 = await cropPage(p, crop.rect as number[]);
      if (!b64) return reply.code(404).send({ error: '裁剪失败（vision 不可用？）' });
      return { ok: true, png_b64: b64 };
    },
  );

  // ---------------------------------------------- processed 页图（复核用） ----
  app.get<{ Params: { id: string; name: string } }>(
    '/api/projects/:id/files/processed/:name',
    async (req, reply) => {
      const p = processedPagePath(req.params.id, req.params.name);
      if (!p) return reply.code(404).send({ error: '矫正页图不存在' });
      reply.header('content-type', 'image/png');
      return reply.send(fs.createReadStream(p));
    },
  );

  // -------------------------------------------------------------- 复核 ----
  app.get<{ Params: { id: string } }>('/api/projects/:id/review-items', async (req, reply) => {
    const chk = requireProject(req.params.id);
    if ('error' in chk) return reply.code(404).send({ error: chk.error });
    return { items: listReviewItems(req.params.id, chk.amf) };
  });

  app.get<{ Params: { id: string; studentId: string; qid: string } }>(
    '/api/projects/:id/review-items/:studentId/:qid/crop',
    async (req, reply) => {
      const chk = requireProject(req.params.id);
      if ('error' in chk) return reply.code(404).send({ error: chk.error });
      const items = listReviewItems(req.params.id, chk.amf);
      const item = items.find(
        (i) => i.student_id === req.params.studentId && i.qid === req.params.qid,
      );
      if (!item) return reply.code(404).send({ error: '复核条目不存在' });
      const p = path.join(processedDir(req.params.id), item.crop.file);
      if (!fs.existsSync(p)) return reply.code(404).send({ error: '矫正页图不存在' });
      const b64 = await cropPage(p, item.crop.rect as number[]);
      if (!b64) return reply.code(404).send({ error: '裁剪失败（vision 不可用？）' });
      return { ok: true, png_b64: b64 };
    },
  );

  app.put<{
    Params: { id: string; studentId: string; qid: string };
    Body: ReviewDecision;
  }>('/api/projects/:id/review-items/:studentId/:qid', async (req, reply) => {
    const chk = requireProject(req.params.id);
    if ('error' in chk) return reply.code(404).send({ error: chk.error });
    const decision = req.body;
    if (!decision || !decision.action) {
      return reply.code(400).send({ error: '缺少 decision.action' });
    }
    const out = await applyReviewDecision(
      req.params.id, req.params.studentId, req.params.qid, decision, chk.amf,
    );
    if (!out.ok) return reply.code(404).send({ error: out.error });
    return {
      ok: true,
      result: {
        student_id: out.result!.student.id,
        total_score: out.result!.total_score,
        full_score: out.result!.full_score,
        review_required: out.result!.review_required,
        ...(out.result!.pending_fill ? { pending_fill: out.result!.pending_fill } : {}),
      },
      remaining: listReviewItems(req.params.id, chk.amf).length,
    };
  });

  // ------------------------------------------------------------ 设置 ----
  // GET 返回脱敏设置（api_key 只回显掩码尾 4 位，避免明文出网）
  app.get('/api/settings', async () => ({ settings: redactedSettings(loadSettings()) }));

  app.put<{ Body: { settings: AppSettings } }>('/api/settings', async (req, reply) => {
    if (!req.body?.settings) {
      return reply.code(400).send({ error: '缺少 settings' });
    }
    return { settings: redactedSettings(saveSettings(req.body.settings)) };
  });
}
