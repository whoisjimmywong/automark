/**
 * AutoMark 桌面启动器（Electron）。
 *
 * 职责：
 *  1. 检查 5173(web)/8790(server)/8791(vision) 是否已运行，缺失则拉起
 *  2. 打开应用窗口（加载本地 Web 前端）
 *  3. 托盘图标：最小化到托盘；退出时清理拉起的子进程
 *
 * 运行：pnpm --filter @automark/launcher start
 */
const { app, BrowserWindow, Tray, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_URL = 'http://127.0.0.1:5173';
const PORTS = { web: 5173, server: 8790, vision: 8791 };

const children = [];
let tray = null;
let win = null;

function log(...args) {
  console.log(`[launcher ${new Date().toLocaleTimeString()}]`, ...args);
}

function start(cmd, args, cwd, label) {
  log(`启动 ${label}: ${cmd} ${args.join(' ')}（cwd=${cwd}）`);
  const child = spawn(cmd, args, { cwd, shell: true, env: { ...process.env }, windowsHide: true });
  child.stdout?.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  child.on('exit', (code) => log(`${label} 退出 code=${code}`));
  children.push(child);
  return child;
}

async function httpOk(url, timeoutMs = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitHttp(url, timeoutMs = 90_000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeoutMs) {
    if (await httpOk(url, 1500)) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function ensureServices() {
  const visionPy = path.join(ROOT, 'vision', '.venv', 'Scripts', 'python.exe');

  if (!(await waitHttp('http://127.0.0.1:8791/health', 2500))) {
    start(visionPy, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8791'],
          path.join(ROOT, 'vision'), 'vision');
  }
  if (!(await waitHttp('http://127.0.0.1:8790/api/health', 2500))) {
    start('npx', ['tsx', 'src/index.ts'], path.join(ROOT, 'server'), 'server');
  }
  if (!(await waitHttp(WEB_URL, 2500))) {
    start('npx', ['vite'], path.join(ROOT, 'web'), 'web');
  }

  await Promise.all([
    waitHttp('http://127.0.0.1:8791/health'),
    waitHttp('http://127.0.0.1:8790/api/health'),
    waitHttp(WEB_URL),
  ]);
  log('三服务就绪');
}

function cleanup() {
  log(`清理 ${children.length} 个子进程…`);
  for (const c of children) {
    try {
      if (!c.killed) c.kill();
    } catch {
      /* ignore */
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'AutoMark 试卷批改',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(WEB_URL);
  win.on('closed', () => {
    win = null;
  });
  win.on('close', (e) => {
    // 有托盘时关闭窗口 → 最小化到托盘（可常驻后台批改）
    if (tray && !app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  const icon = require('electron').nativeImage.createFromPath(
    path.join(__dirname, 'assets', 'icon.png'),
  );
  tray = new Tray(icon);
  tray.setToolTip('AutoMark 试卷批改');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 AutoMark', click: () => { if (!win) createWindow(); win?.show(); } },
    { label: '退出（关闭所有服务）', click: () => { app.isQuiting = true; cleanup(); app.quit(); } },
  ]));
  tray.on('double-click', () => { if (!win) createWindow(); win?.show(); });
}

app.whenReady().then(async () => {
  try {
    await ensureServices();
  } catch (err) {
    log('服务启动失败：', err);
  }
  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win?.show();
  });
});

app.on('window-all-closed', () => {
  // 有托盘时保持常驻；macOS 惯例除外（Windows/Linux 保持）
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', () => {
  app.isQuiting = true;
  cleanup();
});

process.on('exit', cleanup);
