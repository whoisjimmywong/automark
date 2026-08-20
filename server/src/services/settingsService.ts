/**
 * 全局设置读写：data/settings.json（本地优先，密钥仅存本机）。
 * API Key 安全：GET 响应脱敏（maskKey 只回显尾 4 位）；PUT 时空值/掩码值保留原 key；
 * 设置内容不写入日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  maskKey,
  sanitizeSettings,
  type AppSettings,
} from '../../../shared/settings.types.js';

const DATA_ROOT = path.resolve(process.cwd(), '..', 'data');

function settingsPath(): string {
  return path.join(DATA_ROOT, 'settings.json');
}

let cache: AppSettings | null = null;

export function loadSettings(): AppSettings {
  if (cache) return cache;
  const p = settingsPath();
  if (fs.existsSync(p)) {
    try {
      cache = sanitizeSettings(JSON.parse(fs.readFileSync(p, 'utf-8')));
      return cache;
    } catch {
      // 损坏则回退默认
    }
  }
  cache = structuredClone(DEFAULT_SETTINGS);
  return cache;
}

export function saveSettings(next: AppSettings): AppSettings {
  const prev = loadSettings();
  const clean = sanitizeSettings(next);
  // key 保留策略：提交空字符串或掩码（含 '•'）→ 沿用旧 key
  clean.ocr.external.api_key = keepKey(prev.ocr.external.api_key, clean.ocr.external.api_key);
  clean.ocr.llm.api_key = keepKey(prev.ocr.llm.api_key, clean.ocr.llm.api_key);
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(clean, null, 2), 'utf-8');
  cache = clean;
  return clean;
}

function keepKey(oldKey: string, submitted: string): string {
  const s = (submitted ?? '').trim();
  if (!s || s.includes('•') || s.includes('*')) return oldKey;
  return s;
}

/** GET 用脱敏视图：api_key 只回显掩码尾 4 位，避免明文出网 */
export function redactedSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    ocr: {
      ...settings.ocr,
      external: {
        ...settings.ocr.external,
        api_key: maskKey(settings.ocr.external.api_key),
      },
      llm: {
        ...settings.ocr.llm,
        api_key: maskKey(settings.ocr.llm.api_key),
      },
    },
  };
}

export { maskKey };
