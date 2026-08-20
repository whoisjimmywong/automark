import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AmfError, type ProjectSummary } from './api';
import EditorPage from './editor/EditorPage';
import GradingPage from './grading/GradingPage';
import ReviewPage from './grading/ReviewPage';
import SettingsDialog from './settings/SettingsDialog';

type View = { kind: 'home' } | { kind: 'project'; id: string; tab: 'editor' | 'grading' | 'review' };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'home' });
  const [showSettings, setShowSettings] = useState(false);
  return (
    <>
      <div className="topbar">
        <div className="brand">
          Auto<em>Mark</em> <span style={{ fontSize: 12, color: 'var(--muted)' }}>试卷批改 · v0.1</span>
        </div>
        <div className="spacer" />
        {view.kind === 'project' && (
          <>
            <div className="tabs-inline">
              <button
                className={view.tab === 'editor' ? 'active' : ''}
                onClick={() => setView({ ...view, tab: 'editor' })}
              >
                组卷
              </button>
              <button
                className={view.tab === 'grading' ? 'active' : ''}
                onClick={() => setView({ ...view, tab: 'grading' })}
              >
                批改
              </button>
              <button
                className={view.tab === 'review' ? 'active' : ''}
                onClick={() => setView({ ...view, tab: 'review' })}
              >
                复核
              </button>
            </div>
            <button className="ghost" onClick={() => setView({ kind: 'home' })}>
              ← 返回项目列表
            </button>
          </>
        )}
        <button className="ghost" onClick={() => setShowSettings(true)} title="设置">⚙</button>
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {view.kind === 'home' ? (
        <HomePage onOpen={(id) => setView({ kind: 'project', id, tab: 'editor' })} />
      ) : view.tab === 'editor' ? (
        <EditorPage examId={view.id} />
      ) : view.tab === 'grading' ? (
        <GradingPage examId={view.id} />
      ) : (
        <ReviewPage examId={view.id} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- 首页 ----
function HomePage({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [importErrors, setImportErrors] = useState<AmfError[] | null>(null);
  const [toast, setToast] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api.listProjects().then(setProjects).catch((e) => setToast(String(e.message ?? e)));
  }, []);
  useEffect(refresh, [refresh]);

  async function handleImportFile(file: File) {
    setImportErrors(null);
    try {
      const text = await file.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setImportErrors([{ path: '(file)', message: '不是合法的 JSON 文件' }]);
        return;
      }
      const check = await api.validateAmf(json);
      if (!check.valid) {
        setImportErrors(check.errors);
        return;
      }
      const res = await api.importAmf(json);
      refresh();
      onOpen(res.id);
    } catch (e) {
      const err = e as Error & { details?: AmfError[] };
      if (err.details) setImportErrors(err.details);
      else setToast(err.message);
    }
  }

  return (
    <div className="page">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>考试项目</h2>
        <div className="spacer" style={{ flex: 1 }} />
        <button onClick={() => fileRef.current?.click()}>导入 AMF JSON</button>
        <button className="primary" onClick={() => setShowNew(true)}>
          + 新建考试
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {toast && <p className="status-line err">{toast}</p>}
      {importErrors && (
        <div className="error-list" style={{ marginTop: 12 }}>
          <b>AMF 校验未通过（{importErrors.length} 个问题）：</b>
          <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
            {importErrors.map((e, i) => (
              <li key={i}>
                <code>{e.path}</code> — {e.message}
              </li>
            ))}
          </ul>
          <button className="ghost" onClick={() => setImportErrors(null)}>关闭</button>
        </div>
      )}

      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className="card project-card" onClick={() => onOpen(p.id)}>
            <h3>{p.title}</h3>
            <div className="meta">
              <span className="badge">{p.subject}</span>
              {p.grade && <span className="badge">{p.grade}</span>}
              {p.generated && <span className="badge ok">已生成 PDF</span>}
            </div>
            <div className="meta" style={{ marginTop: 8 }}>
              {p.questionCount} 题 · {p.id}
            </div>
          </div>
        ))}
        {projects.length === 0 && (
          <div className="card" style={{ color: 'var(--muted)' }}>
            还没有考试项目。点击「新建考试」开始组卷，或导入 AMF JSON（可参考
            examples/amf_english_unit3.json）。
          </div>
        )}
      </div>

      {showNew && (
        <NewProjectDialog
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
              setShowNew(false);
              onOpen(id);
          }}
        />
      )}
    </div>
  );
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('English');
  const [grade, setGrade] = useState('');
  const [mode, setMode] = useState<'answer_sheet' | 'on_paper'>('answer_sheet');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    if (!title.trim() || !subject.trim()) {
      setErr('请填写考试标题与学科');
      return;
    }
    setBusy(true);
    try {
      const res = await api.createProject({ title: title.trim(), subject: subject.trim(), grade: grade.trim() || undefined, mode });
      onCreated(res.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新建考试</h2>
        <label>考试标题 *</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：English Unit 3 Quiz" />
        <div className="row" style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label>学科 *</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label>年级</label>
            <input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="如：Grade 7" />
          </div>
        </div>
        <label>作答方式</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'answer_sheet' | 'on_paper')}>
          <option value="answer_sheet">模式 A：标准化答题卡作答（推荐）</option>
          <option value="on_paper">模式 B：直接在试卷上作答</option>
        </select>
        {err && <p className="status-line err">{err}</p>}
        <div className="actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
