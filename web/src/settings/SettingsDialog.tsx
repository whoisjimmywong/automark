import { useEffect, useState } from 'react';
import { api } from '../api';
import { DEFAULT_SETTINGS, type AppSettings, type LlmProvider } from '../../../shared/settings.types';

const PROVIDERS: Array<{ v: LlmProvider; label: string; hint: string }> = [
  { v: 'none', label: '不启用 LLM', hint: '' },
  { v: 'openai_completion', label: 'OpenAI Chat Completions', hint: 'https://api.openai.com/v1' },
  { v: 'openai_responses', label: 'OpenAI Responses API', hint: 'https://api.openai.com/v1' },
  { v: 'anthropic', label: 'Anthropic Messages', hint: 'https://api.anthropic.com' },
];

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then((r) => setS(r.settings)).catch((e) => setErr((e as Error).message));
  }, []);

  async function save() {
    setBusy(true);
    setErr('');
    try {
      await api.saveSettings(s);
      setSaved(true);
      setTimeout(onClose, 600);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const external = s.ocr.engine === 'external';
  const llmOn = s.ocr.engine === 'llm';
  const llmCfg = s.ocr.llm;
  const llmActive = llmCfg.provider !== 'none';

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <label>填空 OCR 引擎</label>
        <select
          value={s.ocr.engine}
          onChange={(e) => setS({ ...s, ocr: { ...s.ocr, engine: e.target.value as AppSettings['ocr']['engine'] } })}
        >
          <option value="local">本地 RapidOCR（推荐，数据不出本机）</option>
          <option value="external">外部视觉 API（OpenAI 兼容）</option>
          <option value="llm">通用 LLM（OpenAI / Anthropic）</option>
        </select>

        <label>填空 OCR 置信度阈值（低于此值进复核，默认 0.6）</label>
        <input
          type="number" step="0.05" min="0" max="1"
          value={s.ocr.min_confidence}
          onChange={(e) => setS({ ...s, ocr: { ...s.ocr, min_confidence: Number(e.target.value) } })}
        />

        <div className="checkbox-line">
          <input
            id="ocr-recheck"
            type="checkbox"
            checked={s.ocr.recheck_enabled}
            onChange={(e) => setS({ ...s, ocr: { ...s.ocr, recheck_enabled: e.target.checked } })}
          />
          <label htmlFor="ocr-recheck">
            RapidOCR 低置信或无法识别时，调用 LLM/视觉 API 复核（需在下方配置；默认开启）
          </label>
        </div>

        {external && (
          <>
            <p className="status-line err">
              ⚠ 启用外部 API 后，填空作答框图像将发送至第三方服务，请确认数据合规。
            </p>
            <label>API Endpoint（如 https://api.openai.com/v1）</label>
            <input
              value={s.ocr.external.endpoint}
              onChange={(e) => setS({ ...s, ocr: { ...s.ocr, external: { ...s.ocr.external, endpoint: e.target.value } } })}
              placeholder="https://api.openai.com/v1"
            />
            <label>API Key（掩码显示，留空保持原值）</label>
            <input
              type="password"
              value={s.ocr.external.api_key}
              onChange={(e) => setS({ ...s, ocr: { ...s.ocr, external: { ...s.ocr.external, api_key: e.target.value } } })}
            />
            <label>模型名</label>
            <input
              value={s.ocr.external.model}
              onChange={(e) => setS({ ...s, ocr: { ...s.ocr, external: { ...s.ocr.external, model: e.target.value } } })}
              placeholder="gpt-4o-mini"
            />
          </>
        )}

        {llmOn && (
          <>
            <p className="status-line err">
              ⚠ 启用 LLM 后，填空作答框图像将发送至所选服务（OpenAI/Anthropic），请确认数据合规。
              API Key 仅保存在本机 data/settings.json，界面与接口均以掩码显示。
            </p>
            <label>LLM 协议</label>
            <select
              value={llmCfg.provider}
              onChange={(e) => setS({ ...s, ocr: { ...s.ocr, llm: { ...llmCfg, provider: e.target.value as LlmProvider } } })}
            >
              {PROVIDERS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
            {llmActive && (
              <>
                <label>API Endpoint</label>
                <input
                  value={llmCfg.endpoint}
                  onChange={(e) => setS({ ...s, ocr: { ...s.ocr, llm: { ...llmCfg, endpoint: e.target.value } } })}
                  placeholder={PROVIDERS.find((p) => p.v === llmCfg.provider)?.hint}
                />
                <label>API Key（掩码显示，留空保持原值）</label>
                <input
                  type="password"
                  value={llmCfg.api_key}
                  onChange={(e) => setS({ ...s, ocr: { ...s.ocr, llm: { ...llmCfg, api_key: e.target.value } } })}
                />
                <label>模型名</label>
                <input
                  value={llmCfg.model}
                  onChange={(e) => setS({ ...s, ocr: { ...s.ocr, llm: { ...llmCfg, model: e.target.value } } })}
                  placeholder="gpt-4o-mini / claude-3-5-sonnet"
                />
              </>
            )}
          </>
        )}

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 13 }}>高级：涂卡阈值与导出</summary>
          <label>涂选填充率阈值（默认 0.5）</label>
          <input
            type="number" step="0.05" min="0" max="1"
            value={s.grading.fill_selected}
            onChange={(e) => setS({ ...s, grading: { ...s.grading, fill_selected: Number(e.target.value) } })}
          />
          <label>低置信下限（默认 0.25）</label>
          <input
            type="number" step="0.05" min="0" max="1"
            value={s.grading.fill_suspicious}
            onChange={(e) => setS({ ...s, grading: { ...s.grading, fill_suspicious: Number(e.target.value) } })}
          />
          <div className="checkbox-line">
            <input
              type="checkbox"
              checked={s.export.include_rank}
              onChange={(e) => setS({ ...s, export: { ...s.export, include_rank: e.target.checked } })}
            />
            <span>导出时附带排名</span>
          </div>
        </details>

        {err && <p className="status-line err">{err}</p>}
        {saved && <p className="status-line ok">已保存 ✓</p>}
        <div className="actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={() => void save()}>保存</button>
        </div>
      </div>
    </div>
  );
}
