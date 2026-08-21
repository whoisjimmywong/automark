---
name: pdf-to-amf
description: Convert existing exam PDFs (printed or scanned) into AutoMark AMF JSON for direct import into the AutoMark grading software, so teachers don't have to rebuild exams in the editor. Use when given an exam PDF and asked to import/convert it for AutoMark, or to create an AMF file from a paper.
license: MIT
---

# PDF 试卷 → AutoMark AMF

把老师手头的现成试卷 PDF（印刷版或扫描件）转成 AutoMark 的 AMF JSON，
导入软件后即可生成答题卡、自动批改——无需在编辑器里重新组卷。

## 1. 工作流总览

1. **读试卷**：提取 PDF 全部文本（逐页、按阅读顺序）。
   - 文本型 PDF：直接用 `pymupdf`/`pdftotext` 提取。
   - 扫描件（无文本层）：逐页渲染后 OCR / 视觉识别成文本（可用多模态视觉模型逐页读，
     或本机 AutoMark vision 服务 `/scan/ocr`），**保留 OCR 原始拼写并标注不确定处**。
   - 多栏版面按阅读顺序拼接（先左栏后右栏），不按视觉行序打散；
     **跨页的正文/文章段落要完整拼接**（同一 passage 可能从页尾延续到下一页）。
2. **结构化**：识别题型、题号、题干、选项、分值、答案，映射为 AMF（见 §2/§3）。
3. **输出**：写 `<试卷名>.amf.json`（+ 交付说明，见 §5），并做导入前自检（§4）。

## 2. AMF 最小模板（严格按此结构）

```json
{
  "version": "0.1",
  "exam": {
    "id": "exam_xxx_01",
    "title": "试卷标题",
    "subject": "English",
    "grade": "Grade 7",
    "duration_min": 40,
    "created_at": "2026-08-21T10:00:00+08:00"
  },
  "paper": {
    "mode": "answer_sheet",
    "template": {
      "title": "试卷标题",
      "subtitle": "Time: 40 min    Full score: 24",
      "instructions": "Read each question carefully. Write your answers on the ANSWER SHEET.",
      "header": { "show_name": true, "show_student_id": true },
      "footer": "Page {page} of {pages}"
    },
    "sections": [
      {
        "id": "sec_1",
        "type": "single_choice",
        "title": "Part 1 · I. Listening",
        "instructions": "Choose ONE best answer.",
        "questions": [
          {
            "id": "q1",
            "number": 1,
            "score": 1,
            "prompt": "题干文本",
            "options": ["A 文本", "B 文本", "C 文本", "D 文本"],
            "answer": { "kind": "single", "correct": 1 }
          }
        ]
      }
    ]
  },
  "answer_sheet_config": {
    "page_size": "A4",
    "orientation": "portrait",
    "mark_style": "ellipse",
    "bubble_size_mm": 4.0,
    "bubble_pitch_mm": 8.0,
    "student_id": { "kind": "bubble", "digits": 12 },
    "markers": { "corners": true, "qr": true, "barcode": false },
    "footer_note": "Use a pencil. Rub out any answer you want to change with an eraser."
  }
}
```

参考完整示例：`examples/amf_english_unit3.json`（5 种题型齐备）。

### 各题型 answer 写法

| 题型 | section.type | options | answer |
| --- | --- | --- | --- |
| 单选 | `single_choice` | 2–8 项 | `{"kind":"single","correct":<下标>}` |
| 多选 | `multiple_choice` | 2–8 项 | `{"kind":"multiple","correct":[<下标>,…]}`（可加 `"scoring":{"full":2,"partial":1,"wrong":0}`） |
| 判断 | `true_false` | `["T","F"]` | `{"kind":"tf","correct":0\|1}` |
| 填空（单空） | `fill_blank` | 无 | `{"kind":"text","match":{"type":"exact","value":"since"}}` |
| 填空（多空） | `fill_blank` | 无 | `{"kind":"text","blanks":[{"match":{…},"points":1},{"match":{…}}],"scoring":"per_blank"}` |

- `match.type`：`exact`（精确）/ `any_of`（`{"values":["a","b"]}`）/ `numeric`（`{"value":23.5,"tolerance":0.5}`）/ `regex`（`{"pattern":"…"}`）。
- 多空 `scoring`：`per_blank`（逐空给分，Σpoints 可小于题分=全对奖励）或 `all_or_nothing`（整题对错）。
- `answer.case_sensitive: true` 可要求填空严格大小写（一般不加，默认忽略大小写）。

### 其他常用字段

- 完形/阅读文章：放 section 级 `"passage": {"title":"…","html":"<p>文章段落…</p>"}`，该 section 的题目 `prompt` 可留空。
- 板块标题（如 "Part 2 Use of Language"）：`"part_title"`；大题标题用 `"title"`。
- 选项排列：`"options_layout": "row"|"rows2"|"cols2"|"vertical"`（不写默认竖排）。
- 隐藏题（试卷不显示但答题卡/批改保留）：`"hidden": true`。
- 富文本：prompt/options 支持 `<b><i><u><br><img src="data:image/png;base64,…">` 子集。

## 3. 转换规则（务必遵守）

1. **题号**：全卷连续编号（1..N），与 PDF 顺序一致；听力/笔试分节用 section 划分。
2. **分值**：PDF 标注（如 "(10分)"、"1.5'"、"each 2 pts"）照抄；未标注默认 `1`；
   若 PDF 给了总分，检查 Σscore 是否一致，不一致时在交付说明里提示。
3. **题型判定**：有 A/B/C/D 选项 → 单选；提示 "multiple/Choose all/多选" → 多选；
   选项为 T/F（或 对/错）→ 判断；题干含 `____`、`___`、括号空 → 填空。
   一个填空空位含提示词（如 `____(go)`）时，括号内容作为 `match` 参考并保留在 prompt。
4. **选项编号**：AMF 的 `options` 只存文本，`correct` 存**下标**（0 起）；原卷 A→0, B→1, C→2, D→3。
   ⚠ **选项必须按 A→B→C→D 重排**：PDF 双栏/双列排布时文本提取顺序可能是 A,C,B,D（或 B,D,A,C），
   务必按字母恢复顺序后再存 options、再算 correct 下标——否则批改会把选项张冠李戴。
5. **听力题**：音频无法入库；仍按普通题录入（考试时老师自行放音频），section 标题注明 Listening。
6. **图片/图表题**：无法可靠转换。遇到依赖图片的题，题干保留文字描述，
   并在交付说明中列出「需人工补充图片的题号」（编辑器支持粘贴图片）。
7. **数学公式**：不输出 LaTeX（软件不渲染），转为纯文本描述（如 "x 的平方"）。

## 4. 导入前自检清单（输出前逐项核对）

- [ ] JSON 合法（可 `json.load`）
- [ ] `exam.id` 形如 `exam_xxx_01`（字母数字下划线）
- [ ] 每个 section 至少 1 题；`id` 唯一（q1..qN）；`number` 全卷连续无重复
- [ ] **每个 section 内题型一致**：`section.type` 与该节所有题的 `answer.kind` 匹配
      （single_choice↔single、multiple_choice↔multiple、true_false↔tf、fill_blank↔text）；
      同一卷中不同题型必须拆成不同 section
- [ ] `score > 0`；选项数 2–8；`correct` 下标都在选项范围内
- [ ] 填空 `blanks` 每空有 `match`；多空题 `scoring` 已指定
- [ ] 文字是**原始试卷内容**，没有自行改写/翻译/增删（OCR 误识别的明显错误可修正，需在说明中注明）
- [ ] 无答案时（见 §5）已在交付说明中列明「待补答案题号」

## 5. 标准答案缺失（最常见情况）

现成试卷 PDF 大多**不含答案**。处理策略：

- **PDF 内有答案**（教师版标注 / 末尾答案页 / 选项旁画圈）→ 直接提取填入 `correct`。
- **无答案** →
  1. 正确项用占位：单选 `correct: 0`、多选 `correct: [0]`、判断 `correct: 0`、
     填空 `"match": {"type": "exact", "value": "__TODO__"}`（多空题每空同样占位）；
  2. **必须**在交付说明中醒目列出「⚠ 待补答案题号清单」（题号 + 题干摘要 + 选项），
     并告知老师：导入后在编辑器里逐题选择正确答案即可（或提供答案页后重新转换）；
  3. 不要编造答案，也不要猜测正确项。

## 6. 交付说明（每次转换必须输出）

简短 markdown，包含：

```
- 源文件、题型统计（单选 n / 多选 n / 判断 n / 填空 n）、总分
- ⚠ 待补答案题号清单（若适用）
- ⚠ 需人工补充图片的题号（若适用）
- 疑似 OCR 不确定处（扫描件）
- 导入步骤：AutoMark「组卷」页 → 导入 AMF → 选择该文件 → 生成三件套
```

AMF 文件命名：`<试卷名>.amf.json`，与说明一起交付。
