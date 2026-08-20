import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AMF, Question, SectionType } from '../../../shared/amf.types';
import { SECTION_TYPE_LABEL } from '../../../shared/amf.types';
import { api, type AmfError } from '../api';
import {
  appendQuestion,
  moveSection,
  newQuestion,
  newSection,
  questionCount,
  renumber,
  removeQuestion,
  reorderQuestions,
  totalScore,
  updateSection,
} from '../amfUtils';
import QuestionCard from './QuestionCard';
import PropertyPanel, { SectionPanel } from './PropertyPanel';
import TemplateDialog from './TemplateDialog';

const PALETTE: SectionType[] = ['single_choice', 'multiple_choice', 'true_false', 'fill_blank'];

export default function EditorPage({ examId }: { examId: string }) {
  const [amf, setAmf] = useState<AMF | null>(null);
  const [selectedQid, setSelectedQid] = useState<string | null>(null);
  const [selectedSecId, setSelectedSecId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [errors, setErrors] = useState<AmfError[]>([]);
  const [showTemplate, setShowTemplate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [activeDrag, setActiveDrag] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    api.loadProject(examId).then((a) => {
      setAmf(a);
      api.validateAmf(a).then((v) => setErrors(v.errors)).catch(() => undefined);
    }).catch((e) => setStatus({ kind: 'err', text: `加载失败：${(e as Error).message}` }));
  }, [examId]);

  const mutate = useCallback((next: AMF) => {
    setAmf(next);
    setDirty(true);
    setGenerated(false);
  }, []);

  const selectedQuestion = useMemo(
    () => amf?.paper.sections.flatMap((s) => s.questions).find((q) => q.id === selectedQid) ?? null,
    [amf, selectedQid],
  );

  // ------------------------------------------------------------ 操作 ----
  function addToSection(secId: string, type: SectionType) {
    if (!amf) return;
    const sec = amf.paper.sections.find((s) => s.id === secId);
    if (!sec || sec.type !== type) return;
    const q = newQuestion(type, 0);
    mutate(appendQuestion(amf, secId, q));
    setSelectedQid(q.id);
  }

  function addNewSection(type: SectionType) {
    if (!amf) return;
    const sec = newSection(type, 0);
    mutate(renumber({ ...amf, paper: { ...amf.paper, sections: [...amf.paper.sections, sec] } }));
    setSelectedQid(sec.questions[0]?.id ?? null);
  }

  /** 点击题型：加入首个同型分区，否则新建分区 */
  function quickAdd(type: SectionType) {
    if (!amf) return;
    const sec = amf.paper.sections.find((s) => s.type === type);
    if (sec) addToSection(sec.id, type);
    else addNewSection(type);
  }

  async function save(): Promise<boolean> {
    if (!amf) return false;
    setBusy(true);
    setStatus(null);
    try {
      const check = await api.validateAmf(amf);
      setErrors(check.errors);
      if (!check.valid) {
        setStatus({ kind: 'err', text: `校验未通过（${check.errors.length} 个问题），请修正后再保存` });
        return false;
      }
      await api.saveProject(amf);
      setDirty(false);
      setStatus({ kind: 'ok', text: '已保存' });
      return true;
    } catch (e) {
      const err = e as Error & { details?: AmfError[] };
      if (err.details) setErrors(err.details);
      setStatus({ kind: 'err', text: `保存失败：${err.message}` });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!amf) return;
    const ok = await save();
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.generate(amf.exam.id);
      setGenerated(true);
      setStatus({
        kind: 'ok',
        text: `生成完成：试卷 ${res.pages.paper} 页 / 答题卡 ${res.pages.answer_sheet} 页 / 答案 ${res.pages.answer_key} 页`,
      });
    } catch (e) {
      setStatus({ kind: 'err', text: `生成失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ 拖拽 ----
  function onDragStart(e: DragStartEvent) {
    setActiveDrag(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    if (!amf || !e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    const fromPalette = e.active.data.current?.from === 'palette';

    if (fromPalette) {
      const type = e.active.data.current?.qtype as SectionType;
      if (overId === 'dz_new_section') {
        addNewSection(type);
        return;
      }
      if (overId.startsWith('dz_')) {
        const secId = overId.slice(3);
        const sec = amf.paper.sections.find((s) => s.id === secId);
        if (sec?.type === type) addToSection(secId, type);
        else setStatus({ kind: 'err', text: `该分区是「${SECTION_TYPE_LABEL[sec?.type ?? 'single_choice']}」，请拖到同类型分区或底部新建区` });
      }
      return;
    }

    // 题目排序：over 是同分区另一题
    const sec = amf.paper.sections.find((s) => s.questions.some((q) => q.id === activeId));
    if (!sec) return;
    const ids = sec.questions.map((q) => q.id);
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) {
      mutate(reorderQuestions(amf, sec.id, arrayMove(ids, oldIndex, newIndex)));
    }
  }

  if (!amf) {
    return <div className="page">{status ? status.text : '加载中…'}</div>;
  }

  const modeA = amf.paper.mode === 'answer_sheet';

  return (
    <>
      <div className="topbar" style={{ position: 'sticky' }}>
        <b>{amf.exam.title}</b>
        <span className="badge">{modeA ? '模式 A · 答题卡' : '模式 B · 试卷作答'}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {questionCount(amf)} 题 · 满分 {totalScore(amf)}
          {dirty ? ' · 未保存' : ''}
        </span>
        <div className="spacer" />
        {status && <span className={`status-line ${status.kind}`}>{status.text}</span>}
        <button onClick={() => setShowTemplate(true)}>试卷设置</button>
        <button disabled={busy} onClick={() => void save()}>保存</button>
        <button className="primary" disabled={busy} onClick={() => void generate()}>
          生成 PDF
        </button>
      </div>

      {errors.length > 0 && (
        <div style={{ padding: '8px 16px 0' }}>
          <div className="error-list">
            <b>校验问题（{errors.length}）：</b>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              {errors.slice(0, 8).map((e, i) => (
                <li key={i}><code>{e.path}</code> — {e.message}</li>
              ))}
              {errors.length > 8 && <li>… 共 {errors.length} 条</li>}
            </ul>
            <button className="ghost" onClick={() => setErrors([])}>收起</button>
          </div>
        </div>
      )}

      {generated && (
        <div style={{ padding: '8px 16px 0' }}>
          <div className="card gen-links">
            <a href={api.fileUrl(amf.exam.id, 'paper')} target="_blank" rel="noreferrer">📄 试卷 PDF</a>
            {modeA && (
              <a href={api.fileUrl(amf.exam.id, 'answer_sheet')} target="_blank" rel="noreferrer">✅ 答题卡 PDF</a>
            )}
            <a href={api.fileUrl(amf.exam.id, 'answer_key')} target="_blank" rel="noreferrer">🔑 答案 PDF</a>
          </div>
        </div>
      )}

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="editor-wrap">
          {/* 左：题型面板 */}
          <div className="palette">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>题型</div>
            {PALETTE.map((t) => (
              <PaletteItem key={t} type={t} onClick={() => quickAdd(t)} />
            ))}
            <div className="hint">拖拽到分区，或点击快速添加</div>
          </div>

          {/* 中：画布 */}
          <div className="canvas-col">
            {amf.paper.sections.map((sec, si) => (
              <SectionBlock
                key={sec.id}
                amf={amf}
                secId={sec.id}
                index={si}
                selectedQid={selectedQid}
                selectedSecId={selectedSecId}
                onSelect={setSelectedQid}
                onSelectSection={(sid) => {
                  setSelectedSecId(sid);
                  setSelectedQid(null);
                }}
                onMutate={mutate}
                onDelete={() => {
                  mutate({
                    ...amf,
                    paper: { ...amf.paper, sections: amf.paper.sections.filter((s) => s.id !== sec.id) },
                  });
                  if (selectedQid && sec.questions.some((q) => q.id === selectedQid)) setSelectedQid(null);
                  if (selectedSecId === sec.id) setSelectedSecId(null);
                }}
              />
            ))}
            <NewSectionDropzone />
          </div>

          {/* 右：属性面板 */}
          <div className="props card">
            {selectedQuestion ? (
              <PropertyPanel
                key={selectedQuestion.id}
                amf={amf}
                question={selectedQuestion as Question}
                onMutate={mutate}
                onDelete={() => {
                  mutate(removeQuestion(amf, selectedQuestion.id));
                  setSelectedQid(null);
                }}
              />
            ) : selectedSecId ? (
              <SectionPanel key={selectedSecId} amf={amf} secId={selectedSecId} onMutate={mutate} />
            ) : (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                <h3>题目属性</h3>
                在画布中选择一道题或点选分区标题进行编辑。
                <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />
                <p>操作提示：</p>
                <p>· 左侧点击/拖拽题型添加题目<br />· 点选分区标题可编辑「阅读材料/完形篇章」<br />· 拖动题目卡片调整顺序<br />· 题号自动重排</p>
              </div>
            )}
          </div>
        </div>

        <DragOverlay>
          {activeDrag?.startsWith('palette_') ? (
            <div className="palette item" style={{ width: 160 }}>
              {SECTION_TYPE_LABEL[activeDrag.replace('palette_', '') as SectionType]}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {showTemplate && (
        <TemplateDialog
          amf={amf}
          onClose={() => setShowTemplate(false)}
          onMutate={(next) => {
            mutate(next);
            setShowTemplate(false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------- 题型面板项 ----
function PaletteItem({ type, onClick }: { type: SectionType; onClick: () => void }) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `palette_${type}`,
    data: { from: 'palette', qtype: type },
  });
  return (
    <div ref={setNodeRef} className="item" {...listeners} {...attributes} onClick={onClick}>
      {SECTION_TYPE_LABEL[type]}
    </div>
  );
}

// ------------------------------------------------------------- 分区块 ----
function SectionBlock({
  amf,
  secId,
  index,
  selectedQid,
  selectedSecId,
  onSelect,
  onSelectSection,
  onMutate,
  onDelete,
}: {
  amf: AMF;
  secId: string;
  index: number;
  selectedQid: string | null;
  selectedSecId: string | null;
  onSelect: (qid: string) => void;
  onSelectSection: (secId: string) => void;
  onMutate: (amf: AMF) => void;
  onDelete: () => void;
}) {
  const sec = amf.paper.sections.find((s) => s.id === secId)!;
  const { setNodeRef, isOver } = useDroppable({ id: `dz_${secId}` });

  return (
    <div
      className={`card section-block${selectedSecId === secId ? ' sec-selected' : ''}`}
      onClick={() => onSelectSection(secId)}
      style={{ cursor: 'pointer' }}
    >
      <div className="section-head" onClick={(e) => e.stopPropagation()}>
        <span className="type-tag">{SECTION_TYPE_LABEL[sec.type]}</span>
        <input
          value={sec.title ?? ''}
          placeholder="分区标题（如 Section A: Multiple Choice）"
          style={{ flex: 1, border: 'none', background: 'transparent', fontWeight: 600 }}
          onChange={(e) => onMutate(updateSection(amf, secId, { title: e.target.value }))}
        />
        <button className="ghost" title="上移分区" onClick={() => onMutate(moveSection(amf, secId, -1))}>↑</button>
        <button className="ghost" title="下移分区" onClick={() => onMutate(moveSection(amf, secId, 1))}>↓</button>
        <button className="ghost danger" title="删除分区" onClick={onDelete}>✕</button>
      </div>
      <input
        value={sec.instructions ?? ''}
        placeholder="分区说明（可选，如 Choose ONE best answer.）"
        style={{ border: 'none', background: 'transparent', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}
        onChange={(e) => onMutate(updateSection(amf, secId, { instructions: e.target.value }))}
      />
      {sec.passage?.html && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
          📖 阅读材料：{(sec.passage.title || sec.passage.html.slice(0, 40)).length > 40
            ? `${(sec.passage.title || sec.passage.html.slice(0, 40)).slice(0, 40)}…` : sec.passage.title || '已设置'}
        </div>
      )}
      <SortableContext items={sec.questions.map((q) => q.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className={`dropzone${isOver ? ' over' : ''}`} onClick={(e) => e.stopPropagation()}>
          {sec.questions.length === 0 && <div className="empty">拖拽题型到这里，或点击下方「+ 添加题目」</div>}
          {sec.questions.map((q) => (
            <SortableQuestionCard
              key={q.id}
              q={q}
              selected={q.id === selectedQid}
              onSelect={() => onSelect(q.id)}
            />
          ))}
        </div>
      </SortableContext>
      <button
        className="ghost"
        style={{ fontSize: 12 }}
        onClick={(e) => {
          e.stopPropagation();
          const q = newQuestion(sec.type, 0);
          onMutate(appendQuestion(amf, secId, q));
          onSelect(q.id);
        }}
      >
        + 添加题目
      </button>
      <span style={{ float: 'right', fontSize: 11, color: 'var(--muted)' }}>分区 {index + 1}</span>
    </div>
  );
}

function SortableQuestionCard({ q, selected, onSelect }: { q: Question; selected: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: q.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
    >
      <QuestionCard q={q} selected={selected} onSelect={onSelect} dragProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

// -------------------------------------------------------- 新建分区投放区 ----
function NewSectionDropzone() {
  const { setNodeRef, isOver } = useDroppable({ id: 'dz_new_section' });
  return (
    <div
      ref={setNodeRef}
      className={`dropzone${isOver ? ' over' : ''}`}
      style={{ border: '1px dashed var(--border)', borderRadius: 8, textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 14 }}
    >
      把题型拖到这里可新建分区
    </div>
  );
}
