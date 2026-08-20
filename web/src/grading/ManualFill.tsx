import { useCallback, useEffect, useState } from 'react';
import { api, type StudentResult } from '../api';
import { blanksOf, type AMF, type MatchRule } from '../../../shared/amf.types';

/**
 * 【填空题人工批改】独立组件（manual_fill 模式）。
 * 只自动批改选择题，这里逐空人工判定：对/错/空白，按 AMF 赋分规则自动算分。
 */
interface PendingItem {
  qid: string;
  number: number;
  correct_answer: string;
  /** 该题每一空的参考答案文本（展示用） */
  expect: string[];
  /** 每空当前人工判定（null = 未批） */
  verdicts: Array<'correct' | 'incorrect' | 'blank' | null>;
}

function expectText(m: MatchRule): string {
  if (m.type === 'exact') return m.value;
  if (m.type === 'any_of') return m.values.join(' / ');
  if (m.type === 'regex') return `regex: ${m.pattern}`;
  return `${m.value} ±${m.tolerance}`;
}

export default function ManualFill({
  examId,
  onClose,
  onChanged,
}: {
  examId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [amf, setAmf] = useState<AMF | null>(null);
  const [students, setStudents] = useState<Array<{ id: string; pending: number }>>([]);
  const [sid, setSid] = useState('');
  const [detail, setDetail] = useState<StudentResult | null>(null);
  const [items, setItems] = useState<PendingItem[]>([]);
  const [crops, setCrops] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const refreshStudents = useCallback(() => {
    api.listResults(examId).then((r) => {
      setStudents(
        r.students
          .filter((s) => (s.pending_fill ?? 0) > 0)
          .map((s) => ({ id: s.student_id, pending: s.pending_fill ?? 0 })),
      );
    }).catch(() => undefined);
  }, [examId]);

  useEffect(() => {
    api.loadProject(examId).then(setAmf).catch(() => undefined);
    refreshStudents();
  }, [examId, refreshStudents]);

  // 选中学生 → 加载结果并解析待批项
  useEffect(() => {
    if (!sid) {
      setDetail(null);
      setItems([]);
      setCrops({});
      return;
    }
    api.loadStudentResult(examId, sid).then((d) => {
      setDetail(d);
      const qByQid = new Map(
        (amf?.paper.sections ?? []).flatMap((s) => s.questions).map((q) => [q.id, q]),
      );
      const pending: PendingItem[] = [];
      for (const a of d.answers) {
        if (a.type !== 'fill_blank') continue;
        const q = qByQid.get(a.qid);
        if (!q || q.answer.kind !== 'text') continue;
        const n = blanksOf(q.answer).length;
        const manual: Array<'correct' | 'incorrect' | 'blank' | null> =
          Array.from({ length: n }, (_, i) => {
            const v = a.raw.manual_verdict?.[i];
            return v === 'correct' || v === 'incorrect' || v === 'blank' ? v : null;
          });
        // 仍有空未批（含 verdict=pending 或部分批）
        if (manual.some((v) => v === null)) {
          pending.push({
            qid: a.qid,
            number: a.number,
            correct_answer: a.correct_answer,
            expect: blanksOf(q.answer).map((b) => expectText(b.match)),
            verdicts: manual,
          });
        }
      }
      setItems(pending);
      setCrops({});
      // 预取各空裁剪图
      for (const it of pending) {
        for (let i = 0; i < it.verdicts.length; i++) {
          if (it.verdicts[i] !== null) continue;
          api.answerCrop(examId, sid, it.qid, i).then((r) => {
            if (r.ok) {
              setCrops((prev) => ({
                ...prev,
                [`${it.qid}:${i}`]: `data:image/png;base64,${r.png_b64}`,
              }));
            }
          }).catch(() => undefined);
        }
      }
    }).catch(() => setToast('加载学生结果失败'));
  }, [sid, examId, amf]);

  async function decide(qid: string, blank: number, verdict: 'correct' | 'incorrect' | 'blank') {
    setBusy(true);
    setToast('');
    try {
      await api.applyReview(examId, sid, qid, { action: 'manual_set', blank, verdict });
      // 重新加载该生结果
      const d = await api.loadStudentResult(examId, sid);
      setDetail(d);
      // 重新解析 items
      const qByQid = new Map(
        (amf?.paper.sections ?? []).flatMap((s) => s.questions).map((q) => [q.id, q]),
      );
      const pending: PendingItem[] = [];
      for (const a of d.answers) {
        if (a.type !== 'fill_blank') continue;
        const q = qByQid.get(a.qid);
        if (!q || q.answer.kind !== 'text') continue;
        const n = blanksOf(q.answer).length;
        const manual: Array<'correct' | 'incorrect' | 'blank' | null> =
          Array.from({ length: n }, (_, i) => {
            const v = a.raw.manual_verdict?.[i];
            return v === 'correct' || v === 'incorrect' || v === 'blank' ? v : null;
          });
        if (manual.some((v) => v === null)) {
          pending.push({
            qid: a.qid,
            number: a.number,
            correct_answer: a.correct_answer,
            expect: blanksOf(q.answer).map((b) => expectText(b.match)),
            verdicts: manual,
          });
        }
      }
      setItems(pending);
      if (pending.length === 0) {
        // 该生批完 → 返回学生列表
        setSid('');
        setDetail(null);
        setItems([]);
        setCrops({});
        setToast('该生填空题已全部批完');
        refreshStudents();
        onChanged();
      }
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const VLABEL: Record<string, string> = { correct: '判对', incorrect: '判错', blank: '空白' };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>填空题人工批改</h2>
        {!sid && (
          <div>
            <p className="muted">
              manual_fill 模式：选择题已自动批改，以下学生还有待批改的填空
              {students.length === 0 && '（当前无待批学生，可先以该模式重新批改）'}
            </p>
            {students.length === 0 && (
              <button className="primary" onClick={() => {
                void api.startGrade(examId, 'manual_fill');
                setToast('已重新发起 manual_fill 批改，稍后刷新');
              }} disabled={busy}>重新发起批改（manual_fill）</button>
            )}
            <ul className="scan-list">
              {students.map((s) => (
                <li key={s.id} onClick={() => setSid(s.id)} style={{ cursor: 'pointer' }}>
                  <b>{s.id}</b>
                  <span className="badge warn">待批填空 {s.pending} 题</span>
                  <span className="muted">点击进入 →</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {sid && detail && (
          <div>
            <p className="muted">
              学生 <b>{sid}</b> · 当前总分 <b>{detail.total_score}</b> / {detail.full_score}
              {detail.pending_fill ? ` · 待批填空 ${detail.pending_fill} 题` : ''}
              <button className="ghost" style={{ marginLeft: 12 }} onClick={() => setSid('')}>
                ← 返回学生列表
              </button>
            </p>
            {toast && <p className="status-line">{toast}</p>}
            {items.map((it) => (
              <div key={it.qid} className="card" style={{ marginBottom: 12 }}>
                <h3>第 {it.number} 题（填空）</h3>
                <div className="manual-fill-grid">
                  {it.verdicts.map((v, i) => (
                    <div key={i} className="manual-fill-blank">
                      <div className="muted">第 {i + 1} 空 · 参考答案：{it.expect[i] ?? it.correct_answer}</div>
                      <div className="review-crop" style={{ minHeight: 70 }}>
                        {crops[`${it.qid}:${i}`]
                          ? <img src={crops[`${it.qid}:${i}`]} alt={`第${i + 1}空`} />
                          : <span className="muted">加载裁剪图…</span>}
                      </div>
                      <div className="actions">
                        {(['correct', 'incorrect', 'blank'] as const).map((opt) => (
                          <button
                            key={opt}
                            className={v === opt ? 'primary' : ''}
                            disabled={busy}
                            onClick={() => void decide(it.qid, i, opt)}
                          >
                            {VLABEL[opt]}{v === opt ? ' ✓' : ''}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {items.length === 0 && <p>该生填空已全部批完。</p>}
          </div>
        )}

        <div className="actions">
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
