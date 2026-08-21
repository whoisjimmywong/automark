import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type GradingJobStatus,
  type GradingJobSummary,
  type ResultsSummary,
  type ScanFileInfo,
  type StudentResult,
} from '../api';
import ManualFill from './ManualFill';

const VERDICT_LABEL: Record<string, string> = {
  correct: '正确',
  incorrect: '错误',
  partial: '部分分',
  review: '待复核',
  pending: '待批改',
};

const JOB_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  done: '完成',
  error: '失败',
  interrupted: '已中断',
};

const TYPE_LABEL: Record<string, string> = {
  single_choice: '单选',
  multiple_choice: '多选',
  true_false: '判断',
  fill_blank: '填空',
};

export default function GradingPage({ examId }: { examId: string }) {
  const [scans, setScans] = useState<ScanFileInfo[]>([]);
  const [results, setResults] = useState<ResultsSummary | null>(null);
  const [detail, setDetail] = useState<StudentResult | null>(null);
  const [job, setJob] = useState<GradingJobStatus | null>(null);
  const [jobs, setJobs] = useState<GradingJobSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [gradeMode, setGradeMode] = useState<'auto' | 'manual_fill'>('auto');
  const [showManualFill, setShowManualFill] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(() => {
    api.listScans(examId).then((r) => setScans(r.scans)).catch(() => undefined);
    api.listResults(examId).then(setResults).catch(() => undefined);
    api.listJobs(examId).then((r) => setJobs(r.jobs)).catch(() => undefined);
  }, [examId]);

  useEffect(() => {
    refresh();
    return () => window.clearTimeout(pollTimer.current);
  }, [refresh]);

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setToast('');
    try {
      const r = await api.uploadScans(examId, Array.from(files));
      setToast(`已上传 ${r.saved.length} 个扫描件`);
      refresh();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startGrade() {
    setBusy(true);
    setToast('');
    try {
      const { jobId } = await api.startGrade(examId, gradeMode);
      const poll = async () => {
        const st = await api.gradeStatus(examId, jobId);
        setJob(st);
        if (st.status === 'running') {
          pollTimer.current = window.setTimeout(() => void poll(), 1500);
          return;
        }
        setJob(null);
        setBusy(false);
        if (st.status === 'error') setToast(`批改失败：${st.error ?? '未知错误'}`);
        else setToast(`批改完成：${st.student_count} 名学生`
          + (gradeMode === 'manual_fill' ? '（填空题待人工批改）' : ''));
        refresh();
      };
      void poll();
    } catch (e) {
      setBusy(false);
      setToast((e as Error).message);
    }
  }

  async function doExport() {
    setBusy(true);
    setToast('');
    try {
      const r = await api.exportResults(examId);
      if (r.ok) window.open(api.exportUrl(examId), '_blank');
      else setToast(r.file ? '' : '导出失败');
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openDetail(studentId: string) {
    api.loadStudentResult(examId, studentId)
      .then(setDetail)
      .catch((e) => setToast((e as Error).message));
  }

  /** 续跑：复用上次任务模式，跳过已处理学生 */
  async function resumeJob(jobId: string, mode: 'auto' | 'manual_fill') {
    setBusy(true);
    setToast('');
    try {
      const { jobId: newJobId } = await api.startGrade(examId, mode, jobId);
      setToast(`已发起续跑（跳过已批学生）`);
      const poll = async () => {
        const st = await api.gradeStatus(examId, newJobId);
        setJob(st);
        if (st.status === 'running') {
          pollTimer.current = window.setTimeout(() => void poll(), 1500);
          return;
        }
        setJob(null);
        setBusy(false);
        setToast(st.status === 'error' ? `续跑失败：${st.error ?? ''}` : '续跑完成');
        refresh();
      };
      void poll();
    } catch (e) {
      setBusy(false);
      setToast((e as Error).message);
    }
  }

  async function interruptJob(jobId: string) {
    setBusy(true);
    try {
      const r = await api.interruptJob(examId, jobId);
      setToast(`任务已中断（${r.status}，可稍后续跑）`);
      refresh();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const progress = job && job.total_pages > 0
    ? Math.round((job.processed_pages / job.total_pages) * 100)
    : 0;

  return (
    <div className="page">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>批改</h2>
        <span className="badge">M2 客观题（单选/多选/判断）</span>
        <div className="spacer" style={{ flex: 1 }} />
        <button onClick={() => fileRef.current?.click()} disabled={busy}>上传扫描件</button>
        <select
          value={gradeMode}
          onChange={(e) => setGradeMode(e.target.value as 'auto' | 'manual_fill')}
          disabled={busy}
          title="manual_fill：只自动批改选择题，填空题由人工批改"
        >
          <option value="auto">自动批改（含填空 OCR）</option>
          <option value="manual_fill">填空人工批改（仅选择题自动）</option>
        </select>
        <button className="primary" onClick={() => void startGrade()} disabled={busy || scans.length === 0}>
          开始批改
        </button>
        {results?.students.some((s) => (s.pending_fill ?? 0) > 0) && (
          <button onClick={() => setShowManualFill(true)} disabled={busy}>
            批改填空（{results.students.reduce((n, s) => n + (s.pending_fill ?? 0), 0)} 题待批）
          </button>
        )}
        <button onClick={() => void doExport()} disabled={busy || !results?.students.length}>
          导出 XLSX
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleUpload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {toast && <p className="status-line">{toast}</p>}

      {job && job.status === 'running' && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <b>批改进行中…</b>
            <span>{job.processed_pages} / {job.total_pages} 页</span>
          </div>
          <div className="progress"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>批改任务（最近 {jobs.length} 次）</h3>
          <table className="results-table">
            <thead>
              <tr>
                <th>时间</th><th>模式</th><th>状态</th><th>进度</th><th>学生</th><th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="muted">{new Date(j.created_at).toLocaleString()}</td>
                  <td>{j.mode === 'manual_fill' ? '填空人工' : '自动'}</td>
                  <td>
                    {JOB_STATUS_LABEL[j.status] ?? j.status}
                    {j.error && <span className="muted">（{j.error}）</span>}
                    {j.resumed_from && <span className="badge">续跑</span>}
                  </td>
                  <td>{j.total_pages > 0 ? `${j.processed_pages}/${j.total_pages} 页` : '—'}</td>
                  <td>{j.student_count}（已完成 {j.processed_students}）</td>
                  <td>
                    {(j.status === 'interrupted' || j.status === 'error') && (
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() => void resumeJob(j.id, j.mode)}
                      >
                        续跑
                      </button>
                    )}
                    {j.status === 'running' && (
                      <button className="ghost" disabled={busy}
                              onClick={() => void interruptJob(j.id)}>
                        中断
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h3>扫描件（{scans.length}）</h3>
          {scans.length === 0 && (
            <p className="muted">尚未上传。上传学生作答后的扫描 PDF 或图片（每份文件 = 一名学生）。</p>
          )}
          <ul className="scan-list">
            {scans.map((s) => (
              <li key={s.name}>
                <span className="badge">{s.kind === 'pdf' ? 'PDF' : 'IMG'}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                <span className="muted">{(s.size / 1024 / 1024).toFixed(2)} MB</span>
                <button
                  className="ghost"
                  onClick={() => api.deleteScan(examId, s.name).then(refresh)}
                  disabled={busy}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>批改结果（{results?.students.length ?? 0} 名学生）</h3>
          {!results?.students.length && <p className="muted">批改完成后在这里查看成绩。</p>}
          <table className="results-table">
            <thead>
              <tr>
                <th>学号</th><th>来源</th><th>得分</th><th>满分</th><th>得分率</th><th></th>
              </tr>
            </thead>
            <tbody>
              {results?.students.map((s) => (
                <tr key={s.student_id} onClick={() => openDetail(s.student_id)}>
                  <td>
                    {s.student_id}
                    {s.review_required && <span className="badge warn">复核</span>}
                    {(s.pending_fill ?? 0) > 0 && <span className="badge">待批填空 {s.pending_fill}</span>}
                  </td>
                  <td className="muted">{s.source_file}</td>
                  <td><b>{s.total_score}</b></td>
                  <td>{s.full_score}</td>
                  <td>{s.full_score > 0 ? `${Math.round((s.total_score / s.full_score) * 100)}%` : '—'}</td>
                  <td className="muted">详情 →</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="modal-mask" onClick={() => setDetail(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h2>
              学生 {detail.student.id}
              <span className="badge">{detail.student.source_file}</span>
            </h2>
            <p className="muted">
              客观题得分 <b>{detail.total_score}</b> / {detail.full_score} ·
              {detail.student.id_from_bubbles ? ' 学号由涂卡区读出' : ' 学号按扫描顺序兜底'}
            </p>
            {detail.warnings.length > 0 && (
              <ul className="warn-list">
                {detail.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <table className="results-table">
              <thead>
                <tr>
                  <th>题号</th><th>题型</th><th>学生作答</th><th>标准答案</th>
                  <th>判定</th><th>置信度</th><th>得分</th>
                </tr>
              </thead>
              <tbody>
                {detail.answers.map((a) => (
                  <tr key={a.qid} className={a.verdict === 'review' ? 'row-review' : ''}>
                    <td>{a.number}</td>
                    <td>{TYPE_LABEL[a.type] ?? a.type}</td>
                    <td>{a.student_answer || '—'}</td>
                    <td>{a.correct_answer || '—'}</td>
                    <td>{VERDICT_LABEL[a.verdict] ?? a.verdict}</td>
                    <td>{a.confidence.toFixed(2)}</td>
                    <td>{a.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.answers.some((a) => a.verdict === 'review') && (
              <div style={{ marginTop: 12 }}>
                <b>待复核项（原图核对）：</b>
                {detail.answers
                  .filter((a) => a.verdict === 'review')
                  .map((a) => (
                    <div key={a.qid} style={{ marginTop: 8 }}>
                      <span>
                        第 {a.number} 题 — {a.review_reason ?? '低置信'}
                      </span>
                      <img
                        className="page-img"
                        src={api.processedUrl(examId, `${detail.student.source_file}_p${a.page ?? 1}.png`)}
                        alt={`第${a.page ?? 1}页`}
                      />
                    </div>
                  ))}
              </div>
            )}
            <div className="actions">
              <button className="ghost" onClick={() => setDetail(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {showManualFill && (
        <ManualFill
          examId={examId}
          onClose={() => setShowManualFill(false)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
