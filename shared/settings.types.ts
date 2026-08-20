/**
 * 全局设置（data/settings.json）类型定义（M3 优化包）：
 * OCR 引擎 local / external（OpenAI 视觉）/ llm（通用 LLM 三协议）。
 * LLM API Key 安全：settings.json 本地明文存储（单机用户目录），
 * 但 GET 响应一律脱敏（仅回传 has_key + 尾 4 位），PUT 时空/掩码值保留原 key，
 * 日志与批改流程不接触 key。
 */

export interface ExternalOcrConfig {
  /** OpenAI 兼容 /chat/completions 端点，如 https://api.openai.com/v1 */
  endpoint: string;
  api_key: string;
  model: string;
}

export type LlmProvider = 'openai_completion' | 'openai_responses' | 'anthropic' | 'none';

export interface LlmConfig {
  provider: LlmProvider;
  /** 各协议默认端点：openai 系 → https://api.openai.com/v1；anthropic → https://api.anthropic.com */
  endpoint: string;
  api_key: string;
  model: string;
}

export type OcrEngine = 'local' | 'external' | 'llm';

export interface AppSettings {
  ocr: {
    /** local = RapidOCR（默认）；external = OpenAI 视觉 chat/completions；llm = 通用 LLM 配置 */
    engine: OcrEngine;
    /** 填空 OCR 置信度低于此值 → 进复核队列，默认 0.6 */
    min_confidence: number;
    /** local 识别置信度低于 min_confidence 或无法识别时，调用 LLM/视觉 API 复核（默认开；未配置或关闭则跳过） */
    recheck_enabled: boolean;
    external: ExternalOcrConfig;
    /** 通用 LLM 文字识别（OpenAI completion / OpenAI Responses / Anthropic） */
    llm: LlmConfig;
  };
  grading: {
    /** 涂选填充率阈值，默认 0.5 */
    fill_selected: number;
    /** 低置信下限，默认 0.25 */
    fill_suspicious: number;
  };
  export: {
    /** 是否在 StudentScores 中附带排名，默认 false */
    include_rank: boolean;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  ocr: {
    engine: 'local',
    min_confidence: 0.6,
    recheck_enabled: true,
    external: { endpoint: '', api_key: '', model: 'gpt-4o-mini' },
    llm: { provider: 'none', endpoint: '', api_key: '', model: 'gpt-4o-mini' },
  },
  grading: {
    fill_selected: 0.5,
    fill_suspicious: 0.25,
  },
  export: { include_rank: false },
};

function pickEngine(e: unknown): OcrEngine {
  return e === 'external' || e === 'llm' ? e : 'local';
}

export function sanitizeSettings(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>;
  return {
    ocr: {
      engine: pickEngine(r.ocr?.engine),
      min_confidence: typeof r.ocr?.min_confidence === 'number'
        ? r.ocr.min_confidence : DEFAULT_SETTINGS.ocr.min_confidence,
      recheck_enabled: r.ocr?.recheck_enabled !== false,
      external: {
        endpoint: r.ocr?.external?.endpoint ?? '',
        api_key: r.ocr?.external?.api_key ?? '',
        model: r.ocr?.external?.model ?? DEFAULT_SETTINGS.ocr.external.model,
      },
      llm: {
        provider: ['openai_completion', 'openai_responses', 'anthropic', 'none']
          .includes(r.ocr?.llm?.provider ?? '') ? r.ocr!.llm!.provider as LlmProvider : 'none',
        endpoint: r.ocr?.llm?.endpoint ?? '',
        api_key: r.ocr?.llm?.api_key ?? '',
        model: r.ocr?.llm?.model ?? DEFAULT_SETTINGS.ocr.llm.model,
      },
    },
    grading: {
      fill_selected: typeof r.grading?.fill_selected === 'number'
        ? r.grading.fill_selected : DEFAULT_SETTINGS.grading.fill_selected,
      fill_suspicious: typeof r.grading?.fill_suspicious === 'number'
        ? r.grading.fill_suspicious : DEFAULT_SETTINGS.grading.fill_suspicious,
    },
    export: {
      include_rank: r.export?.include_rank === true,
    },
  };
}

/** 掩码 key：返回形如 "…abcd"（尾 4 位），空 key 返回 ""。仅用于 GET 脱敏展示。 */
export function maskKey(key: string): string {
  const k = (key ?? '').trim();
  if (!k) return '';
  if (k.length <= 4) return '••••';
  return `••••••••${k.slice(-4)}`;
}
