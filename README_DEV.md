> **本文件为开发参考文档**（验收套件、数据格式、不可变约定、踩坑记录、路线图），
> 供作者与后续协作者开发使用；面向用户的项目说明见 [README.md](README.md)。

# AutoMark 试卷批改软件

面向个人教师的本地试卷批改软件：组卷（GUI 编辑器 / AMF JSON 导入 → 试卷+答题卡+答案 PDF）→ 打印考试 → 扫描回收 → 自动批改 → 导出 XLSX。

> 当前进度：**M1 组卷闭环 + M2 客观题批改闭环 + M3 填空 OCR/人工复核已完成**（里程碑 M1–M3）。
> 合成样本回归、任务持久化、Tauri 打包（M4）待开发。
> 协作者请先读 **[M1_NOTES.md](M1_NOTES.md)**（阶段交接：已实现功能、
> 不可轻易改动的不变量、可复用轮子清单、后续待办与踩坑记录）、
> **[M2_NOTES.md](M2_NOTES.md)**（M2 客观题批改闭环）与
> **[M3_NOTES.md](M3_NOTES.md)**（M3 填空 OCR/复核/设置：管线、判分、踩坑记录）。

## 快速开始

要求：Node ≥ 20、pnpm、Python 3.11+（首启自动创建 `vision/.venv`）。

**点击即开（Windows）**：双击根目录 **`AutoMark.bat`**（或 `AutoMark.vbs` 无窗口版）——
自动检查/安装依赖（首次），拉起 web/server/vision 三服务并打开 Electron 应用窗口
（托盘常驻，关闭窗口最小化到托盘）。

**命令行方式**：

```bash
pnpm install
pnpm dev
```

一条命令拉起三个进程：

| 进程 | 地址 | 职责 |
| --- | --- | --- |
| web | http://127.0.0.1:5173 | 前端 SPA（试卷编辑器） |
| server | http://127.0.0.1:8790 | 主后端（Fastify）：项目/AMF/生成编排 |
| vision | http://127.0.0.1:8791 | 识别服务（FastAPI）：布局引擎 + PDF 生成 + OCR |

浏览器打开 http://127.0.0.1:5173 即可使用。「导入 AMF JSON」可直接选用
[`examples/amf_english_unit3.json`](examples/amf_english_unit3.json)（4 种题型示例）。

## 仓库结构

```
AutoMark/
├─ server/          # Node + TS + Fastify 主后端
│  └─ src/
│     ├─ amf/validator.ts        # AMF 校验（schema + 语义，可读错误）
│     ├─ routes/api.ts           # 项目/AMF/生成 REST API
│     ├─ routes/grading.ts       # 批改路由（扫描件/任务/结果/导出）
│     └─ services/               # 项目管理 / vision 客户端 / 批改编排 / 判分 / 导出
├─ vision/          # Python + FastAPI 识别/文档服务
│  └─ app/
│     ├─ layout.py               # 布局引擎（流式排版、分页、positions 回填）
│     ├─ render.py               # ReportLab 渲染（字体子集嵌入）
│     ├─ qrpayload.py            # 页码二维码负载编解码（11 位 base36）
│     ├─ scan.py                 # M2 识别管线（L标配准/透视矫正/涂卡/学号/QR）
│     └─ ocr.py                  # M3 填空 OCR（RapidOCR + 外部引擎适配）
├─ web/             # React 18 + Vite + dnd-kit 前端
│  ├─ src/editor/                # 编辑器（拖拽画布/属性面板/试卷设置/阅读材料）
│  ├─ src/grading/               # 批改页（上传/进度/结果/复核看原图/导出）
│  ├─ src/grading/ReviewPage.tsx # 人工复核（队列/原图裁剪/改判）
│  └─ src/settings/              # 设置（OCR/LLM 引擎、阈值、API Key 脱敏）
├─ launcher/         # Electron 桌面启动器（拉起三服务 + 窗口 + 托盘）
├─ shared/          # AMF 类型 + JSON Schema + 批改结果类型 + 设置类型（前后端单一事实来源）
├─ examples/        # AMF 示例
├─ data/exams/      # 考试项目目录（AMF、generated/、scans/、processed/、results/、exports/）
└─ scripts/
   ├─ dev.mjs                    # 一键 dev 启动
   ├─ acceptance_m1.py           # M1 验收（54 项断言，组卷闭环）
   ├─ acceptance_m2.py           # M2 验收（23 项断言，客观题批改闭环）
   ├─ acceptance_m3.py           # M3 验收（32 项断言，填空 OCR + 复核 + 设置）
   ├─ acceptance_opt.py          # 优化包验收（14 项：气泡 3mm/QR 15mm/缺考标记/LLM mock/passage/脱敏）
   ├─ test_remap.ts              # 选项重排映射单测
   └─ test_case_sensitive.ts     # 填空严格大小写判定单测
```

## 验证

```bash
# 需 server 与 vision 已启动
vision/.venv/Scripts/python scripts/acceptance_m1.py    # M1：54 项断言（组卷闭环）
vision/.venv/Scripts/python scripts/acceptance_m2.py    # M2：23 项断言（客观题批改）
vision/.venv/Scripts/python scripts/acceptance_m3.py    # M3：32 项断言（填空 OCR+复核+设置）
vision/.venv/Scripts/python scripts/acceptance_opt.py   # 优化包：14 项断言
npx tsx scripts/test_remap.ts && npx tsx scripts/test_case_sensitive.ts
```

M1 覆盖：AMF 导入/校验可读错误、三件套页数、positions 回填（含逐空 blank
下标与相邻不重叠）、QR 解码、角标墨迹、positions 与印刷气泡的几何对齐
（M2 前提）、模式 B 生成、答案卷紧凑单页、续页避让 QR、多空权重校验、
富文本题干渲染、答题卡题号顺序与试卷一致。M2 覆盖：扫描上传 → 配准
（L标+QR）→ 涂卡识别（相对阈值：圆盘墨迹 vs 局部背景中位−50，自适应
浅涂/扫描亮度）→ 学号读取（3 名学生：全对/错选漏选未涂/浅涂）→
判分（含部分分与 review）→ 结果 JSON 落盘 → XLSX 四工作表断言。
M3 覆盖：填空 OCR（印刷体全对/per_blank 奖励/数值容差/all_or_nothing/
半对/超容差/错词）→ 复核队列/裁剪图/accept+override_text 改判重算 →
设置读写往返。优化包覆盖：气泡 3mm、二维码 15mm、缺考 ABSENT 标记、
passage（完形/阅读）渲染、LLM 引擎 mock 批改、API Key 脱敏、时长可空。
真实扫描调优（183001200155 / 400237194108 双卷回归）：涂卡填充率改
**相对阈值**（圆盘墨迹 vs 局部背景中位−50，自适应浅涂与扫描亮度）；
填空 OCR 改**三路径候选**（det / rec / 自适应裁边 rec——裁掉作答框描边，
消除框线干扰误读如 vehicle→vehide），首选判错但备选可匹配标准答案时转
复核（reason「OCR 候选冲突」，复核页一键「采纳备选答案」）。
批改增强：RapidOCR 低置信/未识别时可自动调用 **LLM/视觉 API 复核**
（设置 `ocr.recheck_enabled` 默认开，未配置 API 则跳过，结果并入多候选）；
批改界面可选 **manual_fill 模式**（只自动批改选择题，填空题逐空人工批改：
裁剪图 + 期望答案 + 对/错/空白，独立组件，未批完标「待批改」、导出留待批改）。
布局优化覆盖：选项排列（单排/双排/双列/竖排，默认竖排；单排按选项数等分）、
板块标题（part_title）、答题卡列主序（先左列再右列）、分区标题与答题区同页、
长 passage 段间分页、题目/分区手动分页与空行、填空题干隐藏（hidden）。
另 `npx tsx scripts/test_remap.ts`、`npx tsx scripts/test_case_sensitive.ts` 单测。

## 关键数据格式

- **AMF**（`shared/amf.types.ts` + `amf.schema.ts`）：组卷工程/答案权威来源。
  坐标单位 mm（页面左上角原点），与 DPI 解耦。
- **富文本题干**：`prompt`/`options` 承载 HTML 子集（`<b><i><u><ul><ol><li><br><img>`），
  图片以 data URI 内嵌随 AMF 打包；编辑器为 contentEditable 轻量富文本
  （`web/src/editor/RichTextEditor.tsx`），PDF 侧由 `vision/app/richtext.py`
  白名单净化后转 ReportLab flowables 渲染。
- **positions**：生成后由布局引擎回填，`bubble` 块 rect 恰好包住全部选项气泡
  （等距），`ocr` 块 rect 即作答框；批改侧据此重建每个 ROI。
- **QR 负载**：11 位 base36 = 版本1 + 考试短码6 + 页码2 + 校验2。
- **答题卡**：全英文标识（ANSWER SHEET / Name / Date / ID / ABSENT-WITHDRAWN）；
  学号涂卡区默认 12 位、整页宽居中、**仅首页**；缺考/异常标记圈（首页）；
  **题目顺序与试卷完全一致**（客观题气泡与填空作答框按题号流式混合，带标题的分区
  各自成双列块；**列主序**——先读左列自上而下、再读右列，避免左右横跳；分区标题
  与首个答题区强制同页；多空填空占整行）；气泡默认 3.0mm、二维码 15mm。
- **答案 PDF**：仅答案紧凑分栏表（不含原题、无定位标记）。
- **阅读材料（passage）**：section 级 `passage.{title,html}` 富文本，完形/阅读篇章
  渲染一次，题目 prompt 可留空（仅显示题号+选项），避免文章与题目重复混乱。
- **板块标题**：`section.part_title`（如 "Part 1 Listening"）——相邻分区共享同一
  板块标题时只显示一次，大题标题用 `title`（如 "I. Conversation"）。
- **选项排列**：`question.options_layout` = `row`（单排一行，按选项个数等分宽度）/
  `rows2`（双排）/ `cols2`（双列）/ `vertical`（竖排，**默认**）；答题卡气泡等距不变。
- **手动排版**：题目/分区级 `page_break_before`（强制分页）与 `gap_before_mm`（空行）。
- **题干隐藏**：`question.hidden`——试卷不显示该题（含题号），答题卡/答案卷/批改保留。
- **填空严格大小写**：`answer.case_sensitive`（默认 false）——非严格下 CAR≈car≈Car
  都判对；严格下仅大小写完全一致（编辑器勾选开关）。
- **选择题选项数 2–8**：属性面板步进器增减（到达上下限按钮消失）；
  选项支持拖拽重排，正确答案下标随选项走（`remapIndex`，单选/多选均映射）。
- **填空题多空 1–5**：`answer.blanks[]` 逐空匹配规则 + `points` 分空赋分；
  `scoring: per_blank`（只对该空得该空分；Σpoints < 总分时差值为
  全对奖励分，Σpoints > 总分则编辑器拒绝提交并提示）或
  `all_or_nothing`（整题计分）。答题卡每空一个作答框（多空横排、
  序号 (1)(2) 标注），positions 逐空记录 `blank` 下标；
  旧版单空 `match` 格式保持兼容（编辑器打开即迁移）。

## 路线图

- [x] M1 组卷闭环（AMF→PDF 三件套、编辑器、导入校验）
- [x] M2 客观题批改闭环（扫描导入、定位配准、涂卡识别、学号读取、判分、XLSX 导出）
- [x] M3 填空 OCR（RapidOCR）、人工复核改判界面、外部 OCR / LLM API 配置框架
- [x] 优化包：答题卡顺序与试卷一致、气泡 3mm、QR 15mm、ABSENT 缺考标记、
      阅读材料（passage）结构化支持、填空严格大小写、作答时长可空、Electron 启动器
- [x] 排版优化：答题卡列主序（先左列再右列）、分区标题与答题区同页、长 passage
      段间分页、row 单排等分宽度、默认选项排列改竖排（vertical）
- [ ] M4 合成样本回归、批改任务持久化续跑、性能、Tauri/安装包打包
