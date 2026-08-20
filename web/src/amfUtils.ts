/** 编辑器内的 AMF 操作工具（不可变更新） */
import type {
  AMF,
  ChoiceQuestion,
  FillBlankQuestion,
  Question,
  Section,
  SectionType,
} from '../../shared/amf.types';
import { allQuestions } from '../../shared/amf.types';

let uidCounter = 0;
export function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

/** 按题型创建新题目（默认值） */
export function newQuestion(type: SectionType, number: number): Question {
  const base = { id: uid('q'), number, score: 1, prompt: '' };
  switch (type) {
    case 'single_choice':
      return {
        ...base,
        options: ['选项 A', '选项 B', '选项 C', '选项 D'],
        answer: { kind: 'single', correct: 0 },
      } satisfies ChoiceQuestion;
    case 'multiple_choice':
      return {
        ...base,
        score: 2,
        options: ['选项 A', '选项 B', '选项 C', '选项 D'],
        answer: { kind: 'multiple', correct: [0], scoring: { full: 2, partial: 1, wrong: 0 } },
      } satisfies ChoiceQuestion;
    case 'true_false':
      return {
        ...base,
        options: ['T', 'F'],
        answer: { kind: 'tf', correct: 0 },
      } satisfies ChoiceQuestion;
    case 'fill_blank':
      return {
        ...base,
        answer: {
          kind: 'text',
          blanks: [{ match: { type: 'exact', value: '' } }],
          scoring: 'per_blank',
        },
        layout: { lines: 1 },
      } satisfies FillBlankQuestion;
  }
}

/**
 * arrayMove 语义下的下标映射：选项从 oldIndex 移到 newIndex 后，
 * 原下标 i 的新位置（正确答案随选项走）。
 */
export function remapIndex(i: number, oldIndex: number, newIndex: number): number {
  if (i === oldIndex) return newIndex;
  if (oldIndex < newIndex) {
    if (i > oldIndex && i <= newIndex) return i - 1;
  } else if (i >= newIndex && i < oldIndex) {
    return i + 1;
  }
  return i;
}

export function newSection(type: SectionType, index: number): Section {
  const labels: Record<SectionType, string> = {
    single_choice: 'Section: Multiple Choice',
    multiple_choice: 'Section: Multiple Answers',
    true_false: 'Section: True or False',
    fill_blank: 'Section: Fill in the Blanks',
  };
  return {
    id: uid('sec'),
    type,
    title: labels[type],
    questions: [newQuestion(type, index)],
  };
}

/** 题号全卷重排（按 sections 顺序 1..n） */
export function renumber(amf: AMF): AMF {
  let n = 1;
  return {
    ...amf,
    paper: {
      ...amf.paper,
      sections: amf.paper.sections.map((sec) => ({
        ...sec,
        questions: sec.questions.map((q) => ({ ...q, number: n++ })),
      })),
    },
  };
}

/** 更新指定题目 */
export function updateQuestion(amf: AMF, qid: string, patch: Partial<Question>): AMF {
  return {
    ...amf,
    paper: {
      ...amf.paper,
      sections: amf.paper.sections.map((sec) => ({
        ...sec,
        questions: sec.questions.map((q) => (q.id === qid ? ({ ...q, ...patch } as Question) : q)),
      })),
    },
  };
}

/** 更新指定题目的 answer */
export function updateAnswer(amf: AMF, qid: string, answer: Question['answer']): AMF {
  return updateQuestion(amf, qid, { answer } as Partial<Question>);
}

/** 更新分区 */
export function updateSection(amf: AMF, secId: string, patch: Partial<Section>): AMF {
  return {
    ...amf,
    paper: {
      ...amf.paper,
      sections: amf.paper.sections.map((s) => (s.id === secId ? { ...s, ...patch } : s)),
    },
  };
}

/** 向分区末尾追加题目 */
export function appendQuestion(amf: AMF, secId: string, q: Question): AMF {
  return renumber({
    ...amf,
    paper: {
      ...amf.paper,
      sections: amf.paper.sections.map((s) =>
        s.id === secId ? { ...s, questions: [...s.questions, q] } : s,
      ),
    },
  });
}

/** 删除题目 */
export function removeQuestion(amf: AMF, qid: string): AMF {
  return renumber({
    ...amf,
    paper: {
      ...amf.paper,
      sections: amf.paper.sections.map((s) => ({
        ...s,
        questions: s.questions.filter((q) => q.id !== qid),
      })),
    },
  });
}

/** 分区内题目排序（按 id 列表） */
export function reorderQuestions(amf: AMF, secId: string, orderedIds: string[]): AMF {
  return renumber(
    updateSection(amf, secId, {
      questions: orderedIds
        .map((id) => amf.paper.sections.find((s) => s.id === secId)?.questions.find((q) => q.id === id))
        .filter((q): q is Question => q !== undefined),
    }),
  );
}

/** 上移/下移分区 */
export function moveSection(amf: AMF, secId: string, dir: -1 | 1): AMF {
  const secs = [...amf.paper.sections];
  const i = secs.findIndex((s) => s.id === secId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= secs.length) return amf;
  [secs[i], secs[j]] = [secs[j], secs[i]];
  return renumber({ ...amf, paper: { ...amf.paper, sections: secs } });
}

export function questionCount(amf: AMF): number {
  return allQuestions(amf).length;
}

export function totalScore(amf: AMF): number {
  return allQuestions(amf).reduce((s, q) => s + q.score, 0);
}
