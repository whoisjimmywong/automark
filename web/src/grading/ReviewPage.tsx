import { useCallback, useEffect, useState } from 'react';
import { api, type ReviewDecision, type ReviewItem } from '../api';

const TYPE_LABEL: Record<string, string> = {
  single_choice: '单选',
  multiple_choice: '多选',
  true_false: '判断',
  fill_blank: '填空',
};

export default function ReviewPage({ examId }: { examId: string }) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [active, setActive] = useState<ReviewItem | null>(null);
  const [cropUrl, setCropUrl] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [optDraft, setOptDraft] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const refresh = useCallback(() => {
    api.listReviewItems(examId)
      .then((r) => setItems(r.items))
      .catch((e) => setToast((e as Error).message));
  }, [examId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function open(item: ReviewItem) {
    setActive(item);
    setTextDraft('');
    setOptDraft([]);
    setCropUrl('');
    api.reviewCrop(examId, item.student_id, item.qid)
      .then((r) => setCropUrl(`data:image/png;base64,${r.png_b64}`))
      .catch((e) => setToast((e as Error).message));
  }

  async function decide(decision: ReviewDecision) {
    if (!active) return;
    setBusy(true);
    setToast('');
    try {
      const r = await api.applyReview(examId, active.student_id, active.qid, decision);
      setToast(`已处理（剩余 ${r.remaining} 项）`);
      setActive(null);
      refresh();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isFill = active?.type === 'fill_blank';

  return (
    <div className="page">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>人工复核</h2>
        <span className="badge warn">{items.length} 项待处理</span>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="ghost" onClick={refresh}>刷新</button>
      </div>

      {toast && <p className="status-line">{toast}</p>}

      {items.length === 0 ? (
        <div className="card muted">
          没有待复核条目。低置信涂卡（浅涂/多涂）与填空 OCR 低置信会进入这里。
        </div>
      ) : (
        <div className="card">
          <table className="results-table">
            <thead>
              <tr>
                <th>学号</th><th>题号</th><th>题型</th><th>原因</th>
                <th>置信度</th><th>识别结果</th><th>标准答案</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={`${it.student_id}:${it.qid}`} onClick={() => open(it)}>
                  <td>{it.student_id}</td>
                  <td>{it.number}</td>
                  <td>{TYPE_LABEL[it.type] ?? it.type}</td>
                  <td className="muted">{it.reason}</td>
                  <td>{it.confidence.toFixed(2)}</td>
                  <td>{it.student_answer || '—'}</td>
                  <td>{it.correct_answer || '—'}</td>
                  <td className="muted">复核 →</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <div className="modal-mask" onClick={() => setActive(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h2>
              复核：学生 {active.student_id} · 第 {active.number} 题（{TYPE_LABEL[active.type] ?? active.type}）
              <span className="badge warn">{active.reason}</span>
            </h2>
            {isFill && active.blank !== undefined && (
              <p className="muted">
                正在复核第 {active.blank + 1} 空 · 置信度 {active.confidence.toFixed(2)} ·
                当前识别：{active.student_answer || '（空）'} · 参考答案：{active.correct_answer}
              </p>
            )}
            {isFill && active.alternatives?.some((alts) => alts?.length) && (
              <p className="muted">
                备选识别：
                {active.alternatives
                  .flatMap((alts, i) => (alts ?? []).map((a) => `${i + 1}空「${a.text}」(${a.mode})`))
                  .join('、')}
                —— 点「采纳备选答案」直接采用可匹配标准答案的候选
              </p>
            )}
            {!isFill && (
              <p className="muted">
                置信度 {active.confidence.toFixed(2)} · 当前作答：{active.student_answer || '（未涂）'} ·
                标准答案：{active.correct_answer}
              </p>
            )}
            <div className="review-body">
              <div className="review-crop">
                {cropUrl
                  ? <img src={cropUrl} alt="原图裁剪" />
                  : <span className="muted">加载原图…</span>}
              </div>
              <div className="review-actions">
                {isFill ? (
                  <div>
                    <label>修正作答文本（留空视为未作答）</label>
                    <input
                      value={textDraft}
                      onChange={(e) => setTextDraft(e.target.value)}
                      placeholder="输入正确识别后的文本，如 go"
                    />
                    <div className="actions" style={{ marginTop: 10 }}>
                      <button className="primary" disabled={busy}
                              onClick={() => decide({ action: 'override_text', text: textDraft, blank: active.blank })}>
                        提交修正
                      </button>
                      <button disabled={busy} onClick={() => decide({ action: 'mark_blank', blank: active.blank })}>
                        标记为空白
                      </button>
                      <button disabled={busy} onClick={() => decide({ action: 'accept' })}>
                        {active.alternatives?.some((alts) => alts?.length)
                          ? '采纳备选答案'
                          : '接受当前识别'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <label>改选选项（多选题可勾选多个）</label>
                    <div className="opt-grid">
                      {Array.from({ length: active.crop.options ?? 4 }, (_, i) => (
                        <label key={i} className="opt-chip">
                          <input
                            type="checkbox"
                            checked={optDraft.includes(i)}
                            onChange={() => setOptDraft((prev) =>
                              prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}
                          />
                          {String.fromCharCode(65 + i)}
                        </label>
                      ))}
                    </div>
                    <div className="actions" style={{ marginTop: 10 }}>
                      <button className="primary" disabled={busy}
                              onClick={() => decide({ action: 'select', options: optDraft })}>
                        按所选判定
                      </button>
                      <button disabled={busy} onClick={() => decide({ action: 'accept' })}>
                        接受当前识别
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="actions">
              <button className="ghost" onClick={() => setActive(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
