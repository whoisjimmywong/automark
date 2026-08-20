// Dev launcher for the Python vision service.
// Creates vision/.venv on first run, installs requirements, then starts uvicorn.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const visionDir = path.join(root, 'vision');
const isWin = process.platform === 'win32';
const venvPython = path.join(visionDir, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: visionDir, shell: isWin, ...opts });
  if (r.status !== 0) {
    console.error(`[vision] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(venvPython)) {
  console.log('[vision] creating virtualenv (first run)...');
  run('python', ['-m', 'venv', '.venv']);
  console.log('[vision] installing requirements...');
  run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
}

const port = process.env.VISION_PORT || '8791';
console.log(`[vision] starting uvicorn on 127.0.0.1:${port}`);
const child = spawn(venvPython, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', port], {
  cwd: visionDir,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
