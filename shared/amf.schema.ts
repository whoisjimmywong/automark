/**
 * AMF JSON Schema（draft-07）—— 运行时校验的单一事实来源。
 * 与 shared/amf.types.ts 对应；server 用 ajv 编译校验，web 通过 API 校验。
 */

const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$', minLength: 1, maxLength: 64 };

const singleAnswer = {
  type: 'object',
  required: ['kind', 'correct'],
  additionalProperties: false,
  properties: {
    kind: { const: 'single' },
    correct: { type: 'integer', minimum: 0 },
  },
};

const multipleAnswer = {
  type: 'object',
  required: ['kind', 'correct'],
  additionalProperties: false,
  properties: {
    kind: { const: 'multiple' },
    correct: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, uniqueItems: true },
    scoring: {
      type: 'object',
      additionalProperties: false,
      properties: {
        full: { type: 'number', minimum: 0 },
        partial: { type: 'number', minimum: 0 },
        wrong: { type: 'number', minimum: 0 },
      },
    },
  },
};

const trueFalseAnswer = {
  type: 'object',
  required: ['kind', 'correct'],
  additionalProperties: false,
  properties: {
    kind: { const: 'tf' },
    correct: { type: 'integer', enum: [0, 1] },
  },
};

const matchRule = {
  oneOf: [
    {
      type: 'object',
      required: ['type', 'value'],
      additionalProperties: false,
      properties: { type: { const: 'exact' }, value: { type: 'string' } },
    },
    {
      type: 'object',
      required: ['type', 'values'],
      additionalProperties: false,
      properties: {
        type: { const: 'any_of' },
        values: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    },
    {
      type: 'object',
      required: ['type', 'pattern'],
      additionalProperties: false,
      properties: { type: { const: 'regex' }, pattern: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      required: ['type', 'value', 'tolerance'],
      additionalProperties: false,
      properties: {
        type: { const: 'numeric' },
        value: { type: 'number' },
        tolerance: { type: 'number', minimum: 0 },
      },
    },
  ],
};

const blankSpec = {
  type: 'object',
  required: ['match'],
  additionalProperties: false,
  properties: {
    match: matchRule,
    points: { type: 'number', minimum: 0 },
  },
};

const textAnswer = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: { const: 'text' },
    match: matchRule,
    blanks: { type: 'array', items: blankSpec, minItems: 1, maxItems: 5 },
    scoring: { enum: ['all_or_nothing', 'per_blank'] },
    case_sensitive: { type: 'boolean' },
  },
};

const questionBase = {
  id,
  number: { type: 'integer', minimum: 1 },
  score: { type: 'number', exclusiveMinimum: 0 },
  prompt: { type: 'string' },
  page_break_before: { type: 'boolean' },
  gap_before_mm: { type: 'number', minimum: 0, maximum: 200 },
  hidden: { type: 'boolean' },
};

/** 客观题（单选/多选/判断）——answer 类型由所在 section 决定 */
function choiceQuestion(answerSchema: object, minOptions: number, maxOptions: number) {
  return {
    type: 'object',
    required: ['id', 'number', 'score', 'prompt', 'options', 'answer'],
    additionalProperties: false,
    properties: {
      ...questionBase,
      options: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: minOptions,
        maxItems: maxOptions,
      },
      options_layout: { enum: ['row', 'rows2', 'cols2', 'vertical'] },
      answer: answerSchema,
    },
  };
}

const fillBlankQuestion = {
  type: 'object',
  required: ['id', 'number', 'score', 'prompt', 'answer'],
  additionalProperties: false,
  properties: {
    ...questionBase,
    answer: textAnswer,
    layout: {
      type: 'object',
      additionalProperties: false,
      properties: { lines: { type: 'integer', minimum: 1, maximum: 10 } },
    },
  },
};

function section(type: string, questionSchema: object) {
  return {
    type: 'object',
    required: ['id', 'type', 'questions'],
    additionalProperties: false,
    properties: {
      id,
      type: { const: type },
      title: { type: 'string' },
      part_title: { type: 'string' },
      page_break_before: { type: 'boolean' },
      gap_before_mm: { type: 'number', minimum: 0, maximum: 200 },
      instructions: { type: 'string' },
      passage: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          html: { type: 'string' },
        },
      },
      questions: { type: 'array', items: questionSchema, minItems: 1 },
    },
  };
}

const rectMM = {
  type: 'array',
  items: { type: 'number' },
  minItems: 4,
  maxItems: 4,
};

export const AMF_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://automark.local/amf.schema.json',
  title: 'AutoMark File (AMF)',
  type: 'object',
  required: ['version', 'exam', 'paper'],
  additionalProperties: false,
  properties: {
    version: { const: '0.1' },
    exam: {
      type: 'object',
      required: ['id', 'title', 'subject'],
      additionalProperties: false,
      properties: {
        id,
        title: { type: 'string', minLength: 1 },
        subject: { type: 'string', minLength: 1 },
        grade: { type: 'string' },
        duration_min: { type: 'integer', minimum: 1 },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
    paper: {
      type: 'object',
      required: ['mode', 'template', 'sections'],
      additionalProperties: false,
      properties: {
        mode: { enum: ['answer_sheet', 'on_paper'] },
        template: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1 },
            subtitle: { type: 'string' },
            instructions: { type: 'string' },
            header: {
              type: 'object',
              additionalProperties: false,
              properties: {
                show_name: { type: 'boolean' },
                show_student_id: { type: 'boolean' },
              },
            },
            footer: { type: 'string' },
          },
        },
        sections: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              section('single_choice', choiceQuestion(singleAnswer, 2, 8)),
              section('multiple_choice', choiceQuestion(multipleAnswer, 2, 8)),
              section('true_false', choiceQuestion(trueFalseAnswer, 2, 2)),
              section('fill_blank', fillBlankQuestion),
            ],
          },
        },
      },
    },
    answer_sheet_config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        page_size: { const: 'A4' },
        orientation: { const: 'portrait' },
        mark_style: { enum: ['ellipse', 'circle'] },
        bubble_size_mm: { type: 'number', minimum: 2, maximum: 8 },
        bubble_pitch_mm: { type: 'number', minimum: 5, maximum: 15 },
        student_id: {
          type: 'object',
          required: ['kind', 'digits'],
          additionalProperties: false,
          properties: {
            kind: { const: 'bubble' },
            digits: { type: 'integer', minimum: 3, maximum: 12 },
          },
        },
        markers: {
          type: 'object',
          additionalProperties: false,
          properties: {
            corners: { type: 'boolean' },
            qr: { type: 'boolean' },
            barcode: { type: 'boolean' },
          },
        },
        tf_labels: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 4 },
          minItems: 2,
          maxItems: 2,
        },
        footer_note: { type: 'string' },
        absent_mark: { type: 'boolean' },
      },
    },
    positions: {
      type: 'object',
      required: ['pages'],
      additionalProperties: false,
      properties: {
        pages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['page', 'role', 'markers', 'blocks'],
            additionalProperties: false,
            properties: {
              page: { type: 'integer', minimum: 1 },
              role: { enum: ['paper', 'answer_sheet'] },
              markers: {
                type: 'object',
                required: ['corners', 'qr'],
                additionalProperties: false,
                properties: {
                  corners: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                    minItems: 4,
                    maxItems: 4,
                  },
                  qr: rectMM,
                },
              },
              blocks: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['qid', 'kind', 'rect'],
                  additionalProperties: false,
                  properties: {
                    qid: { type: 'string' },
                    kind: { enum: ['bubble', 'ocr'] },
                    rect: rectMM,
                    options: { type: 'integer', minimum: 2 },
                    lines: { type: 'integer', minimum: 1 },
                    blank: { type: 'integer', minimum: 0 },
                  },
                },
              },
              student_id_rect: rectMM,
              absent_rect: rectMM,
            },
          },
        },
      },
    },
    metadata: {
      type: 'object',
      properties: {
        generator: { type: 'string' },
        layout_engine: { type: 'string' },
      },
    },
  },
} as const;
