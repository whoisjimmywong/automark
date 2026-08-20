import { useEffect, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  AMF,
  BlankSpec,
  ChoiceQuestion,
  FillBlankQuestion,
  FillScoring,
  MatchRule,
  MultipleAnswer,
  Question,
  SingleAnswer,
  TextAnswer,
  TrueFalseAnswer,
} from '../../../shared/amf.types';
import {
  BLANK_MAX,
  BLANK_MIN,
  OPTION_MAX,
  OPTION_MIN,
  blanksOf,
  isChoice,
  optionLabel,
  tfLabels,
} from '../../../shared/amf.types';
import { remapIndex, uid, updateAnswer, updateQuestion, updateSection } from '../amfUtils';
import RichTextEditor from './RichTextEditor';

export default function PropertyPanel({
  amf,
  question: q,
  onMutate,
  onDelete,
}: {
  amf: AMF;
  question: Question;
  onMutate: (amf: AMF) => void;
  onDelete: () => void;
}) {
  const patch = (p: Partial<Question>) => onMutate(updateQuestion(amf, q.id, p));

  return (
    <div>
      <h3>
        第 {q.number} 题 <span style={{ fontSize: 11, color: 'var(--muted)' }}>{q.id}</span>
      </h3>

      <label>题干（支持加粗/斜体/下划线/列表/图片）</label>
      <RichTextEditor
        value={q.prompt}
        placeholder="输入题干，可插入图片…"
        minHeight={72}
        onChange={(html) => patch({ prompt: html })}
      />

      <label>分值</label>
      <input
        type="number"
        min={0.5}
        step={0.5}
        value={q.score}
        onChange={(e) => patch({ score: Number(e.target.value) || 1 })}
        style={{ maxWidth: 120 }}
      />

      {isChoice(q) && q.answer.kind !== 'tf' && (
        <ChoiceEditor amf={amf} q={q} onMutate={onMutate} />
      )}
      {isChoice(q) && q.answer.kind === 'tf' && (
        <TrueFalseEditor amf={amf} q={q} onMutate={onMutate} />
      )}
      {!isChoice(q) && <FillBlankEditor amf={amf} q={q} onMutate={onMutate} />}

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
      <label>手动排版</label>
      <div className="row">
        <div>
          <label>题前空行 (mm)</label>
          <input
            type="number" min={0} max={200} step={1}
            value={q.gap_before_mm ?? 0}
            onChange={(e) => {
              const v = Number(e.target.value);
              patch({ ...(v > 0 ? { gap_before_mm: v } : { gap_before_mm: undefined }) });
            }}
          />
        </div>
        <div>
          <label>题前分页</label>
          <select
            value={q.page_break_before ? 'yes' : 'no'}
            onChange={(e) => patch({ page_break_before: e.target.value === 'yes' })}
          >
            <option value="no">不分页</option>
            <option value="yes">强制分页</option>
          </select>
        </div>
      </div>
      <div className="checkbox-line">
        <input
          type="checkbox"
          checked={q.hidden === true}
          onChange={(e) => patch({ hidden: e.target.checked })}
        />
        <span>隐藏题干（试卷不显示该题与题号；答题卡/答案卷/批改保留）</span>
      </div>
      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
      <button className="danger" onClick={onDelete}>删除本题</button>
    </div>
  );
}

// ------------------------------------------------------------- 客观题 ----
function ChoiceEditor({
  amf,
  q,
  onMutate,
}: {
  amf: AMF;
  q: ChoiceQuestion;
  onMutate: (amf: AMF) => void;
}) {
  const single = q.answer.kind === 'single';
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // 选项行的稳定 id（拖拽排序用），与 options 等长同步
  const [optIds, setOptIds] = useState<string[]>(() => q.options.map(() => uid('o')));
  useEffect(() => {
    setOptIds((ids) => {
      if (ids.length === q.options.length) return ids;
      if (ids.length < q.options.length) {
        return [...ids, ...Array.from({ length: q.options.length - ids.length }, () => uid('o'))];
      }
      return ids.slice(0, q.options.length);
    });
  }, [q.options.length]);

  const patchAnswer = (a: Question['answer']) => onMutate(updateAnswer(amf, q.id, a));

  /** 选项数 2..8 步进；正确答案随删减收拢 */
  function setCount(n: number) {
    const count = Math.max(OPTION_MIN, Math.min(OPTION_MAX, n));
    if (count === q.options.length) return;
    const options = [...q.options];
    while (options.length < count) options.push(`选项 ${optionLabel(options.length)}`);
    options.length = count;
    let answer = q.answer;
    if (answer.kind === 'single' && answer.correct >= count) {
      answer = { kind: 'single', correct: 0 };
    } else if (answer.kind === 'multiple') {
      const kept = answer.correct.filter((c) => c < count);
      answer = { ...answer, correct: kept.length > 0 ? kept : [0] };
    }
    onMutate(updateQuestion(amf, q.id, { options, answer } as Partial<Question>));
  }

  /** 拖拽重排选项；正确答案下标随选项走 */
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = optIds.indexOf(String(active.id));
    const newIndex = optIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    setOptIds(arrayMove(optIds, oldIndex, newIndex));
    const options = arrayMove(q.options, oldIndex, newIndex);
    let answer = q.answer;
    if (answer.kind === 'single') {
      answer = { kind: 'single', correct: remapIndex(answer.correct, oldIndex, newIndex) };
    } else if (answer.kind === 'multiple') {
      answer = {
        ...answer,
        correct: answer.correct.map((i) => remapIndex(i, oldIndex, newIndex)).sort((a, b) => a - b),
      };
    }
    onMutate(updateQuestion(amf, q.id, { options, answer } as Partial<Question>));
  }

  return (
    <>
      <label>
        选项（{single ? '点选正确答案' : '勾选全部正确答案'}；拖动 ⠿ 可重排，答案跟随）
      </label>
      <label style={{ fontSize: 12 }}>试卷选项排列（答题卡气泡等距不变）</label>
      <select
        value={q.options_layout ?? 'vertical'}
        onChange={(e) =>
          onMutate(updateQuestion(amf, q.id, { options_layout: e.target.value } as Partial<Question>))
        }
      >
        <option value="vertical">竖排（每选项一行，默认）</option>
        <option value="row">单排（一行等分宽度）</option>
        <option value="rows2">双排（第一行靠左排前若干项，其余第二行）</option>
        <option value="cols2">双列（行主序两列，最后一项靠左）</option>
      </select>
      <div className="stepper">
        <span>选项 {q.options.length} 个</span>
        {q.options.length > OPTION_MIN && (
          <button type="button" title="减少一个选项" onClick={() => setCount(q.options.length - 1)}>−</button>
        )}
        {q.options.length < OPTION_MAX && (
          <button type="button" title="增加一个选项" onClick={() => setCount(q.options.length + 1)}>＋</button>
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={optIds} strategy={verticalListSortingStrategy}>
          {q.options.map((opt, i) => (
            <SortableOptionRow
              key={optIds[i] ?? i}
              id={optIds[i] ?? `fallback_${i}`}
              label={optionLabel(i)}
              value={opt}
              single={single}
              checked={
                single
                  ? (q.answer as SingleAnswer).correct === i
                  : (q.answer as MultipleAnswer).correct.includes(i)
              }
              onToggle={() => {
                if (single) {
                  patchAnswer({ kind: 'single', correct: i });
                } else {
                  const cur = (q.answer as MultipleAnswer).correct;
                  const next = cur.includes(i)
                    ? cur.filter((c) => c !== i)
                    : [...cur, i].sort((a, b) => a - b);
                  patchAnswer({ ...q.answer, correct: next.length ? next : [0] } as MultipleAnswer);
                }
              }}
              onChange={(v) => {
                const options = [...q.options];
                options[i] = v;
                onMutate(updateQuestion(amf, q.id, { options } as Partial<Question>));
              }}
            />
          ))}
        </SortableContext>
      </DndContext>

      {!single && <MultipleScoringEditor q={q} patchAnswer={patchAnswer} />}
    </>
  );
}

function SortableOptionRow({
  id,
  label,
  value,
  single,
  checked,
  onToggle,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  single: boolean;
  checked: boolean;
  onToggle: () => void;
  onChange: (v: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      className="opt-row"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
    >
      <span className="drag-handle" {...attributes} {...listeners}>⠿</span>
      <input type={single ? 'radio' : 'checkbox'} checked={checked} onChange={onToggle} />
      <b style={{ width: 18 }}>{label}.</b>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function MultipleScoringEditor({
  q,
  patchAnswer,
}: {
  q: ChoiceQuestion;
  patchAnswer: (a: Question['answer']) => void;
}) {
  const a = q.answer as MultipleAnswer;
  const scoring = a.scoring ?? { full: q.score, partial: q.score * 0.5, wrong: 0 };
  const set = (k: 'full' | 'partial' | 'wrong', v: number) =>
    patchAnswer({ ...a, scoring: { ...scoring, [k]: v } });
  return (
    <>
      <label>记分规则（全对 / 漏选 / 错选）</label>
      <div className="row">
        <div><input type="number" min={0} step={0.5} value={scoring.full ?? q.score} onChange={(e) => set('full', Number(e.target.value))} /></div>
        <div><input type="number" min={0} step={0.5} value={scoring.partial ?? q.score * 0.5} onChange={(e) => set('partial', Number(e.target.value))} /></div>
        <div><input type="number" min={0} step={0.5} value={scoring.wrong ?? 0} onChange={(e) => set('wrong', Number(e.target.value))} /></div>
      </div>
    </>
  );
}

// ------------------------------------------------------------- 判断题 ----
function TrueFalseEditor({
  amf,
  q,
  onMutate,
}: {
  amf: AMF;
  q: ChoiceQuestion;
  onMutate: (amf: AMF) => void;
}) {
  const labels = tfLabels(amf);
  const a = q.answer as TrueFalseAnswer;
  return (
    <>
      <label>正确答案（选项标签可在「试卷设置」中改为 对/错 等）</label>
      <select
        value={a.correct}
        onChange={(e) =>
          onMutate(updateAnswer(amf, q.id, { kind: 'tf', correct: Number(e.target.value) as 0 | 1 }))
        }
      >
        <option value={0}>{labels[0]}（正确）</option>
        <option value={1}>{labels[1]}（错误）</option>
      </select>
    </>
  );
}

// ------------------------------------------------------------- 填空题 ----
function FillBlankEditor({
  amf,
  q,
  onMutate,
}: {
  amf: AMF;
  q: FillBlankQuestion;
  onMutate: (amf: AMF) => void;
}) {
  const a = q.answer as TextAnswer;
  const blanks = blanksOf(a);
  const scoring: FillScoring = a.scoring ?? 'per_blank';
  const multi = blanks.length > 1;

  function commit(next: BlankSpec[], nextScoring?: FillScoring) {
    onMutate(
      updateAnswer(amf, q.id, {
        kind: 'text',
        blanks: next,
        scoring: nextScoring ?? scoring,
        case_sensitive: a.case_sensitive === true,
      }),
    );
  }

  /** 空格数 1..5 步进（per_blank 下增减后按总分重新均分） */
  function setCount(n: number) {
    const count = Math.max(BLANK_MIN, Math.min(BLANK_MAX, n));
    if (count === blanks.length) return;
    let next = [...blanks];
    while (next.length < count) next.push({ match: { type: 'exact', value: '' } });
    next.length = count;
    if (scoring === 'per_blank' && count > 1) {
      const split = equalSplit(q.score, count);
      next = next.map((b, j) => ({ ...b, points: split[j] }));
    }
    commit(next);
  }

  function setMatch(i: number, match: MatchRule) {
    commit(blanks.map((b, j) => (j === i ? { ...b, match } : b)));
  }

  /** 每空赋分：per_blank 下保证全部空格带 points（缺省按总分均分） */
  function withPoints(list: BlankSpec[]): BlankSpec[] {
    if (list.every((b) => b.points !== undefined)) return list;
    const split = equalSplit(q.score, list.length);
    return list.map((b, j) => ({ ...b, points: b.points ?? split[j] }));
  }

  const [ptsError, setPtsError] = useState<string | null>(null);

  function setPoints(i: number, v: number) {
    const cur = withPoints(blanks);
    const candidate = cur.map((b, j) => (j === i ? { ...b, points: v } : b));
    const sum = candidate.reduce((s, b) => s + (b.points ?? 0), 0);
    // Σpoints > 总分：拒绝提交并提示（无法完成该编辑）
    if (sum - q.score > 1e-9) {
      setPtsError(`各空分数之和 ${round2(sum)} 超过题目总分 ${q.score}，未应用该修改`);
      return;
    }
    setPtsError(null);
    commit(candidate);
  }

  function equalize() {
    setPtsError(null);
    const split = equalSplit(q.score, blanks.length);
    commit(blanks.map((b, j) => ({ ...b, points: split[j] })));
  }

  function setScoringMode(mode: FillScoring) {
    setPtsError(null);
    if (mode === 'per_blank') {
      commit(withPoints(blanks), mode);
    } else {
      // 整题计分：剥离逐空分数
      commit(blanks.map((b) => ({ match: b.match })), mode);
    }
  }

  const ptsSum = blanks.reduce((s, b) => s + (b.points ?? 0), 0);
  const bonus = round2(q.score - ptsSum);

  return (
    <>
      <label>空格数（每空一个作答框，批改为逐空识别）</label>
      <div className="stepper">
        <span>空格 {blanks.length} 个</span>
        {blanks.length > BLANK_MIN && (
          <button type="button" title="减少一个空格" onClick={() => setCount(blanks.length - 1)}>−</button>
        )}
        {blanks.length < BLANK_MAX && (
          <button type="button" title="增加一个空格" onClick={() => setCount(blanks.length + 1)}>＋</button>
        )}
      </div>

      {multi && (
        <>
          <label>计分方式</label>
          <select value={scoring} onChange={(e) => setScoringMode(e.target.value as FillScoring)}>
            <option value="per_blank">分空计分（每空直接赋分，只对该空得该空分）</option>
            <option value="all_or_nothing">整题计分（任意一空错误则整题 0 分）</option>
          </select>
        </>
      )}

      {blanks.map((b, i) => (
        <div className="blank-card" key={i}>
          <div className="blank-head">
            <b>第 {i + 1} 空</b>
            {multi && scoring === 'per_blank' && (
              <span className="weight-edit">
                赋分
                <input
                  type="number"
                  min={0.5}
                  max={q.score}
                  step={0.5}
                  value={b.points ?? ''}
                  placeholder={equalSplit(q.score, blanks.length)[i].toString()}
                  onChange={(e) => setPoints(i, Math.max(0.5, Number(e.target.value) || 0.5))}
                />
                分
              </span>
            )}
          </div>
          <MatchRuleEditor m={b.match} onChange={(m) => setMatch(i, m)} />
        </div>
      ))}

      {multi && scoring === 'per_blank' && (
        <div className="weight-summary">
          <span style={{ color: ptsError ? 'var(--danger)' : bonus > 0 ? 'var(--warn)' : 'var(--ok)' }}>
            {ptsError ??
              (bonus > 0
                ? `已分配 ${round2(ptsSum)} / ${q.score} 分；全对额外得 ${bonus} 分（全对奖励）`
                : `已分配 ${round2(ptsSum)} / ${q.score} 分（无全对奖励）`)}
          </span>
          <button type="button" className="ghost" onClick={equalize}>按总分均分</button>
        </div>
      )}

      <label>作答框行数（每行 8mm）</label>
      <input
        type="number"
        min={1}
        max={10}
        value={q.layout?.lines ?? 1}
        onChange={(e) =>
          onMutate(
            updateQuestion(amf, q.id, {
              layout: { lines: Math.max(1, Math.min(10, Number(e.target.value) || 1)) },
            } as Partial<Question>),
          )
        }
        style={{ maxWidth: 120 }}
      />

      <div className="checkbox-line">
        <input
          type="checkbox"
          checked={a.case_sensitive === true}
          onChange={(e) =>
            onMutate(
              updateAnswer(amf, q.id, {
                ...a,
                case_sensitive: e.target.checked,
              } as TextAnswer),
            )
          }
        />
        <span>严格大小写判定（如标准答案 CAR，仅 CAR 算对；不勾选则 car/Car 都算对）</span>
      </div>
    </>
  );
}

/** 单个空格的答案匹配规则编辑 */
function MatchRuleEditor({ m, onChange }: { m: MatchRule; onChange: (m: MatchRule) => void }) {
  return (
    <>
      <select
        value={m.type}
        onChange={(e) => {
          const t = e.target.value as MatchRule['type'];
          if (t === 'exact') onChange({ type: 'exact', value: '' });
          else if (t === 'any_of') onChange({ type: 'any_of', values: [''] });
          else if (t === 'regex') onChange({ type: 'regex', pattern: '' });
          else onChange({ type: 'numeric', value: 0, tolerance: 0.5 });
        }}
      >
        <option value="exact">精确匹配</option>
        <option value="any_of">多答案同义（命中任一）</option>
        <option value="regex">正则表达式</option>
        <option value="numeric">数值容差</option>
      </select>

      {m.type === 'exact' && (
        <input placeholder="标准答案" value={m.value} onChange={(e) => onChange({ ...m, value: e.target.value })} />
      )}
      {m.type === 'any_of' && (
        <textarea
          rows={2}
          placeholder="可接受答案，每行一个"
          value={m.values.join('\n')}
          onChange={(e) => onChange({ ...m, values: e.target.value.split('\n') })}
        />
      )}
      {m.type === 'regex' && (
        <input placeholder="正则（全匹配，如 go(es)?）" value={m.pattern} onChange={(e) => onChange({ ...m, pattern: e.target.value })} />
      )}
      {m.type === 'numeric' && (
        <div className="row">
          <div>
            <label>标准值</label>
            <input type="number" step="any" value={m.value} onChange={(e) => onChange({ ...m, value: Number(e.target.value) })} />
          </div>
          <div>
            <label>容差 ±</label>
            <input type="number" min={0} step="any" value={m.tolerance} onChange={(e) => onChange({ ...m, tolerance: Number(e.target.value) })} />
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------- 赋分工具 ----
/** 把总分按 0.5 步进均分到 n 个空（末位吸收舍入，总和恰为 score） */
function equalSplit(score: number, n: number): number[] {
  if (n <= 1) return [score];
  const each = Math.floor((score / n) * 2) / 2;
  const pts = Array(n).fill(each) as number[];
  pts[n - 1] = round2(score - each * (n - 1));
  return pts;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ------------------------------------------------------- 分区设置面板 ----
export function SectionPanel({
  amf,
  secId,
  onMutate,
}: {
  amf: AMF;
  secId: string;
  onMutate: (amf: AMF) => void;
}) {
  const sec = amf.paper.sections.find((s) => s.id === secId)!;
  const passage = sec.passage ?? { html: '' };
  const patch = (p: Partial<typeof sec>) => onMutate(updateSection(amf, secId, p));

  return (
    <div>
      <h3>分区设置 <span style={{ fontSize: 11, color: 'var(--muted)' }}>{sec.id}</span></h3>

      <label>分区标题</label>
      <input
        value={sec.title ?? ''}
        placeholder="大题标题，如 I. Conversation"
        onChange={(e) => patch({ title: e.target.value })}
      />

      <label>板块标题（可选，如 Part 1 Listening；相邻分区相同板块只显示一次）</label>
      <input
        value={sec.part_title ?? ''}
        placeholder="Part 1 Listening"
        onChange={(e) => patch({ part_title: e.target.value })}
      />

      <label>分区说明</label>
      <textarea
        rows={2}
        value={sec.instructions ?? ''}
        placeholder="如 For each question, choose the correct answer."
        onChange={(e) => patch({ instructions: e.target.value })}
      />

      <label>手动排版</label>
      <div className="row">
        <div>
          <label>分区前空行 (mm)</label>
          <input
            type="number" min={0} max={200} step={1}
            value={sec.gap_before_mm ?? 0}
            onChange={(e) => {
              const v = Number(e.target.value);
              patch({ ...(v > 0 ? { gap_before_mm: v } : { gap_before_mm: undefined }) });
            }}
          />
        </div>
        <div>
          <label>分区前分页</label>
          <select
            value={sec.page_break_before ? 'yes' : 'no'}
            onChange={(e) => patch({ page_break_before: e.target.value === 'yes' })}
          >
            <option value="no">不分页</option>
            <option value="yes">强制分页</option>
          </select>
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
      <label style={{ fontWeight: 600 }}>阅读材料 / 完形篇章（渲染一次，题目无需重复粘贴）</label>
      <input
        value={passage.title ?? ''}
        placeholder="篇章标题（可选）"
        onChange={(e) => patch({ passage: { html: passage.html, ...(e.target.value ? { title: e.target.value } : {}) } })}
      />
      <RichTextEditor
        value={passage.html}
        placeholder="粘贴阅读文章或完形篇章；空格处可标注 (7)____ 等编号…"
        minHeight={200}
        onChange={(html) => patch({ passage: { ...(passage.title ? { title: passage.title } : {}), html } })}
      />
      <p style={{ fontSize: 12, color: 'var(--muted)' }}>
        完形/阅读题目的题干可留空——试卷上该题只显示题号与选项，正文以篇章为准，避免重复混乱。
      </p>
    </div>
  );
}
