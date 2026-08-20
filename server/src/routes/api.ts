/**
 * API 路由：项目管理 / AMF 校验与导入 / PDF 生成与下载。
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import type { AMF } from '../../../shared/amf.types.js';
import { validateAmf } from '../amf/validator.js';
import {
  createBlankProject,
  deleteProject,
  generatedDir,
  generatedFilePath,
  importProject,
  listProjects,
  loadProject,
  saveProject,
} from '../services/projectManager.js';
import { renderProject, visionHealth } from '../services/visionClient.js';

export async function registerApi(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    vision: await visionHealth(),
    time: new Date().toISOString(),
  }));

  // ---------------------------------------------------------- projects ----
  app.get('/api/projects', async () => listProjects());

  app.post<{ Body: { title: string; subject: string; grade?: string; mode: 'answer_sheet' | 'on_paper' } }>(
    '/api/projects',
    async (req, reply) => {
      const { title, subject, grade, mode } = req.body ?? ({} as never);
      if (!title || !subject || !mode) {
        return reply.code(400).send({ error: '缺少字段：title / subject / mode' });
      }
      const amf = createBlankProject({ title, subject, grade, mode });
      return { id: amf.exam.id, amf };
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const amf = loadProject(req.params.id);
    if (!amf) return reply.code(404).send({ error: `项目不存在: ${req.params.id}` });
    return amf;
  });

  app.put<{ Params: { id: string }; Body: AMF }>('/api/projects/:id', async (req, reply) => {
    if (req.params.id !== req.body?.exam?.id) {
      return reply.code(400).send({ error: '路径 id 与 AMF exam.id 不一致' });
    }
    const result = validateAmf(req.body);
    if (!result.valid) {
      return reply.code(422).send({ error: 'AMF 校验未通过', details: result.errors });
    }
    // 编辑后旧 positions 作废，由下次生成回填
    delete req.body.positions;
    saveProject(req.body);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (!deleteProject(req.params.id)) {
      return reply.code(404).send({ error: `项目不存在: ${req.params.id}` });
    }
    return { ok: true };
  });

  // -------------------------------------------------------------- amf -----
  app.post<{ Body: { amf: unknown } }>('/api/amf/validate', async (req) => {
    const result = validateAmf(req.body?.amf);
    return result;
  });

  app.post<{ Body: { amf: unknown } }>('/api/amf/import', async (req, reply) => {
    const result = validateAmf(req.body?.amf);
    if (!result.valid) {
      return reply.code(422).send({ error: 'AMF 校验未通过', details: result.errors });
    }
    const id = importProject(req.body!.amf as AMF);
    return { ok: true, id };
  });

  // ---------------------------------------------------------- generate ----
  app.post<{ Params: { id: string } }>('/api/projects/:id/generate', async (req, reply) => {
    const amf = loadProject(req.params.id);
    if (!amf) return reply.code(404).send({ error: `项目不存在: ${req.params.id}` });
    const check = validateAmf(amf);
    if (!check.valid) {
      return reply.code(422).send({ error: 'AMF 校验未通过，请先在编辑器中修正', details: check.errors });
    }
    if (!(await visionHealth())) {
      return reply.code(503).send({ error: 'vision 服务不可用（请先启动 Python 识别服务）' });
    }
    const outDir = generatedDir(amf.exam.id);
    const result = await renderProject(amf, outDir);
    if (!result.ok) {
      return reply.code(500).send({ error: result.error ?? 'PDF 生成失败' });
    }
    // 回填 positions 并保存
    amf.positions = result.positions;
    amf.metadata = { ...amf.metadata, generator: 'AutoMark v0.1', layout_engine: 'amf-layout@0.1' };
    saveProject(amf);
    return { ok: true, pages: result.pages, positions: result.positions };
  });

  app.get<{ Params: { id: string; kind: string } }>(
    '/api/projects/:id/files/:kind',
    async (req, reply) => {
      const p = generatedFilePath(req.params.id, req.params.kind);
      if (!p) {
        return reply.code(404).send({ error: `文件不存在: ${req.params.kind}（请先生成）` });
      }
      const stream = fs.createReadStream(p);
      if (p.endsWith('.pdf')) {
        reply.header('content-type', 'application/pdf');
        reply.header('content-disposition', `inline; filename="${req.params.kind}.pdf"`);
      } else {
        reply.header('content-type', 'application/json; charset=utf-8');
      }
      return reply.send(stream);
    },
  );
}
