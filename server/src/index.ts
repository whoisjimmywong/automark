/**
 * AutoMark 主后端入口（Fastify）。
 * 打包模式（安装版）：AUTOMARK_WEB_DIST 指向 web 构建产物，由本服务直接托管前端，
 * launcher 不再依赖 vite（开发模式仍用 5173）。
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { registerApi } from './routes/api.js';
import { registerGradingRoutes } from './routes/grading.js';
import { ensureDataRoot } from './services/projectManager.js';
import { restoreJobs } from './services/gradingService.js';
import { visionHealth } from './services/visionClient.js';

const PORT = Number(process.env.PORT ?? 8790);
const HOST = '127.0.0.1';

function webDist(): string | null {
  if (process.env.AUTOMARK_WEB_DIST) return process.env.AUTOMARK_WEB_DIST;
  // 开发仓库布局：server/../web/dist
  const p = path.resolve(process.cwd(), '..', 'web', 'dist');
  return fs.existsSync(p) ? p : null;
}

async function main(): Promise<void> {
  ensureDataRoot();
  restoreJobs();  // M4：恢复历史批改任务（running → interrupted，可续跑）
  const app = Fastify({ logger: { level: 'info' } });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });
  await registerApi(app);
  await registerGradingRoutes(app);

  // 打包模式：托管 web 静态产物（SPA 回退到 index.html）
  const dist = webDist();
  if (dist) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not Found' });
    });
    app.log.info(`web 静态托管: ${dist}`);
  }

  await app.listen({ port: PORT, host: HOST });
  const vision = await visionHealth();
  app.log.info(`AutoMark server ready on http://${HOST}:${PORT} (vision: ${vision ? 'up' : 'DOWN'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
