/**
 * AutoMark 主后端入口（Fastify）。
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { registerApi } from './routes/api.js';
import { registerGradingRoutes } from './routes/grading.js';
import { ensureDataRoot } from './services/projectManager.js';
import { visionHealth } from './services/visionClient.js';

const PORT = Number(process.env.PORT ?? 8790);
const HOST = '127.0.0.1';

async function main(): Promise<void> {
  ensureDataRoot();
  const app = Fastify({ logger: { level: 'info' } });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });
  await registerApi(app);
  await registerGradingRoutes(app);

  await app.listen({ port: PORT, host: HOST });
  const vision = await visionHealth();
  app.log.info(`AutoMark server ready on http://${HOST}:${PORT} (vision: ${vision ? 'up' : 'DOWN'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
