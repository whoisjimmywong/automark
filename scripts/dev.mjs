// One-command dev launcher: vision (Python) + server (Fastify) + web (Vite).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';

const procs = [
  { name: 'vision', cmd: process.execPath, args: ['scripts/dev-vision.mjs'] },
  { name: 'server', cmd: pnpm, args: ['--filter', '@automark/server', 'dev'] },
  { name: 'web', cmd: pnpm, args: ['--filter', '@automark/web', 'dev'] },
];

const children = [];
for (const p of procs) {
  const child = spawn(p.cmd, p.args, { cwd: root, stdio: 'inherit', shell: isWin });
  child.on('exit', (code) => {
    console.log(`[dev] ${p.name} exited (${code}); shutting down the rest`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

function shutdown(code = 0) {
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] AutoMark dev stack starting:');
console.log('[dev]   web    -> http://127.0.0.1:5173');
console.log('[dev]   server -> http://127.0.0.1:8790');
console.log('[dev]   vision -> http://127.0.0.1:8791');
