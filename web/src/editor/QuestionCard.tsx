import type { HTMLAttributes } from 'react';
import type { MatchRule, Question } from '../../../shared/amf.types';
import { blanksOf, isChoice, isFillBlank, optionLabel } from '../../../shared/amf.types';

function matchText(m: MatchRule): string {
  switch (m.type) {
    case 'exact':
      return m.value.trim() || '(未设答案)';
    case 'any_of':
      return m.values.map((v) => v.trim()).filter(Boolean).join(' / ') || '(未设答案)';
    case 'regex':
      return `/${m.pattern}/`;
    case 'numeric':
      return `${m.value} ±${m.tolerance}`;
  }
}

function answerSummary(q: Question): string {
  const a = q.answer;
  if (a.kind === 'single') return optionLabel(a.correct);
  if (a.kind === 'multiple') return a.correct.map(optionLabel).join('');
  if (a.kind === 'tf') return a.correct === 0 ? 'T' : 'F';
  const blanks = blanksOf(a);
  if (blanks.length === 0) return '(未设答案)';
  return blanks.map((b) => matchText(b.match)).join('; ');
}

export default function QuestionCard({
  q,
  selected,
  onSelect,
  dragProps,
}: {
  q: Question;
  selected: boolean;
  onSelect: () => void;
  dragProps?: HTMLAttributes<HTMLSpanElement>;
}) {
  const plain = q.prompt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const hasImg = q.prompt.includes('<img');
  const blanks = isFillBlank(q) ? blanksOf(q.answer) : [];
  const incomplete =
    (!plain && !hasImg) ||
    (isChoice(q) && q.options.some((o) => !o.trim())) ||
    (isFillBlank(q) &&
      (blanks.length === 0 ||
        blanks.some(
          (b) =>
            (b.match.type === 'exact' && !b.match.value.trim()) ||
            (b.match.type === 'any_of' && b.match.values.every((v) => !v.trim())),
        )));

  return (
    <div className={`q-card${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span className="drag-handle" {...dragProps} onClick={(e) => e.stopPropagation()}>
        ⠿
      </span>
      <span className="qnum">{q.number}.</span>
      <span className="qprompt">
        {plain || (hasImg ? '[图片题干]' : <i style={{ color: '#b0b7c3' }}>（未填写题干）</i>)}
      </span>
      <span className="qmeta">
        {q.score} 分 · 答案 {answerSummary(q)}
        {incomplete && <span title="内容不完整" style={{ color: 'var(--warn)' }}> ⚠</span>}
      </span>
    </div>
  );
}
