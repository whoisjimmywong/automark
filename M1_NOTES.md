# AutoMark · M1 阶段文档（组卷闭环）

> 面向协作者的阶段交接文档：M1 已实现什么、怎么跑、哪些不能轻易改、
> 哪些轮子已经造好直接用、后续阶段做什么。
> 最后更新：M1 三轮优化收尾（验收 49/49）。

## 1. 项目速览

AutoMark 是面向个体教师的**本地化阅卷应用**，闭环链路：
**组卷 → 打印 → 扫描 → 批改 → 成绩 XLSX**。

M1 交付的是前半段「组卷闭环」：AMF 工程 ↔ 可视化编辑器 ↔ 校验 ↔
一键生成打印级 PDF 三件套（试卷 / 答题卡 / 答案卷），并回填机器可读的
positions 坐标。M2/M3 的批改侧将**完全依赖 M1 产出的 AMF+positions**，
因此本阶段的若干数据约定是后续工作的几何与语义前提，改动需格外谨慎
（见 §5）。

## 2. M1 已实现功能

### 2.1 基础闭环
- 项目管理：列表 / 新建（空白或导入示例）/ 删除 / 重命名；数据落盘
  `data/exams/<exam_id>/project.amf.json`
- AMF 导入导出：导入前强制校验，错误为**可读中文**（schema + 语义两层）
- 一键生成三件套 PDF：
  - **试卷**：流式排版、题块不跨页、续页内容避让页首 QR（起点 36mm）
  - **答题卡**：全英文标识；学号涂卡区仅首页；页数最少化排版
  - **答案卷**：仅答案紧凑分栏（无原题、无定位标记），20 题仅 1 页
- positions 回填：每个 `bubble` 块 rect 恰好包住选项气泡组；每个 `ocr`
  块 rect 即作答框、逐空带 `blank` 下标；`student_id_rect` 为涂卡网格外接矩形
- 双作答模式：A 答题卡作答（`answer_sheet`）/ B 试卷直接作答（`on_paper`，
  不生成答题卡，气泡与作答框内联进试卷）

### 2.2 编辑器（web）
- 画布：section 分组、题目卡片拖拽排序（跨区自动迁移题型）、模板插入
  （单选/多选/判断/填空）、实时 AMF 校验状态、导出 AMF、字数统计与
  ⚠ 不完整提示
- 题干**富文本**：加粗/斜体/下划线/有序无序列表/插图（自动压缩至
  1200px 转 data URI 随 AMF 打包）；`RichTextEditor.tsx` 自研轻量实现
- 选择题：选项数 2–8 步进器（到界按钮消失）；**选项拖拽重排且正确答案
  跟随**（`remapIndex`，单选/多选均映射）；多选可配全对/漏选/错选分值
- 判断题：正确/错误选择；选项标签全局可配（T/F、对/错……）
- 填空题：空格数 1–5 步进器；逐空匹配规则（精确/多同义/正则/数值容差）；
  计分方式二选一：
  - `per_blank` 分空计分：每空直接赋 `points` 分，只对该空得该空分；
    **Σpoints < 总分 → 差值为全对奖励分**；输入导致 Σpoints > 总分时
    **拒绝提交并红字提示**；一键按总分均分（0.5 步进、末位吸收舍入）
  - `all_or_nothing` 整题计分：任一空错则整题 0 分
- 试卷设置：标题/副标题/说明、作答模式、学号位数（默认 12）、气泡尺寸
  与间距、页脚说明、判断题标签

### 2.3 排版引擎要点（vision）
- 答题卡页数最少化：客观题**区内两列并行**（列主序分块）；填空 ≤3 空的
  题**两两双列配对**、>3 空占整行；续页无学号区、内容起点 56mm。
  效果：示例 20 题答题卡 1 页，54 题大卷恰好 2 页
- 富文本渲染：HTML 子集白名单净化 → ReportLab flowables；**图片独立成行**
  （行高自适应，不可内联——定行高会溢叠）；`<b>` 映射 AMF-Bold
- 字体：微软雅黑 msyh/msyhbd（subfontIndex=0），simsun 兜底；
  对勾用 `√`（U+221A），**不要用 `✓`**（字体内缺字形会变豆腐块）

## 3. 架构与运行

三进程本地架构（Windows）：

| 进程 | 技术 | 端口 | 启动 | 职责 |
|---|---|---|---|---|
| web | React 18 + Vite + dnd-kit | 5173 | `npx vite`（web/） | 编辑器，`/api` 代理到 8790 |
| server | Node + TS + Fastify | 8790 | `npx tsx watch src/index.ts`（server/） | 项目 CRUD、AMF 校验、生成编排 |
| vision | Python 3.14 + FastAPI | 8791 | `.venv\Scripts\python -m uvicorn app.main:app --port 8791 --reload`（vision/） | 排版/渲染/QR/（未来 OCR） |

- 一键启动：`pnpm dev`（根目录，`scripts/dev.mjs` 同时拉起三者）
- vision 依赖装在 `vision/.venv`（fastapi/uvicorn/reportlab/qrcode/pillow/
  pymupdf/opencv-python-headless/numpy）
- API 一览：`GET/POST /api/projects`、`GET/PUT/DELETE /api/projects/:id`、
  `POST /api/amf/validate`、`POST /api/amf/import`、
  `POST /api/projects/:id/generate`、`GET /api/projects/:id/amf`、
  `GET /api/projects/:id/files/:kind`（paper|answer_sheet|answer_key）
- **typecheck**：`pnpm --filter @automark/web exec tsc --noEmit` 与
  `... @automark/server ...`（改了 shared/ 后两端都要跑）

### 验收（回归闸门）

```bash
# 需 server + vision 已启动；必须从 vision/ 目录运行（脚本用相对路径）
vision/.venv/Scripts/python scripts/acceptance_m1.py   # 49 项断言
npx tsx scripts/test_remap.ts                          # 选项重排映射单测
```

任何对布局、AMF 模型、校验规则的改动，**跑绿验收才算完成**。改动是有意
为之的行为变化时，同步更新验收断言（它编码了当前的不变量）。

## 4. 核心数据模型（AMF）

单一事实来源：`shared/amf.types.ts`（TS 类型 + 助手函数）与
`shared/amf.schema.ts`（JSON Schema draft-07）。**两处必须同步改**；
Python 侧（vision/app/layout.py）消费 JSON，有自己的 `blanks_of` 等镜像
助手，语义保持一致。

关键约定：

- **坐标系**：单位 mm、**页面左上角原点**、与 DPI 解耦。渲染层 `_y()`
  负责 mm→pt 的 y 轴翻转。positions 里的所有 rect 都是 `[x1,y1,x2,y2]` mm
- **QR 负载**：11 位 base36 = 版本1 + 考试短码6 + 页码2 + 校验2
  （`vision/app/qrpayload.py`，`encode/decode/exam_short_code`）
- **富文本**：`prompt`/`options` 承载 HTML 子集
  `<b><i><u><br><ul><ol><li><img src="data:…">`；纯文本是合法输入
  （净化器会转义）。schema 层它们仍是 string，无结构变更
- **填空答案**：`answer.blanks[]`（1–5 空，各带 `match` + 可选 `points`）+
  `scoring: per_blank|all_or_nothing`。**旧版单空 `match` 格式保持兼容**，
  归一化入口永远是 `blanksOf()`（TS）/ `blanks_of()`（Py），不要直接读
  `.match`/`.blanks`
- **positions**：生成时由布局引擎回填进 AMF（`amf.positions`）。
  `bubble` 块：rect 紧包全部选项气泡（等距，cy=rect 中心），`options`
  为选项数；`ocr` 块：rect 即作答框，`blank` 为空格下标（单空为 0），
  `lines` 为行数；页级 `markers.corners/qr` 与首页 `student_id_rect`

## 5. 不能轻易改的内容

| 项 | 原因 | 改动前提 |
|---|---|---|
| 坐标系（mm、左上原点） | positions/渲染/未来配准全链路依赖 | 永远不要改 |
| QR 负载格式与 `exam_short_code` | 已打印流出的答题卡要靠它解码归属 | 版本位 +1 且解码器向后兼容 |
| positions 块语义（rect 紧包气泡/框、blank 下标） | M2/M3 按 rect+等距假设重建每个气泡/空 ROI | 同步改验收 §4/§7 并重跑 |
| 旧版单空 `match` 兼容 | 存量 AMF 文件 | 永久保留，走 `blanksOf` 归一化 |
| 角标几何（L 标顶点 (10,10) 等）与页首 QR 位置 | M2 定位配准的锚点 | 同步改验收 §6 与 PAPER_TOP_Y |
| 答题卡页首布局（首页学号区 y 52–117、内容起点 120/56） | 学号识别将按网格外接矩形切格 | 同步改 constants + 验收 |
| 字体与 `√` 字形选择 | 缺字形豆腐块、字体子集嵌入 | 目检 PDF |
| 满分等**自由文本**（副标题）不与分数联动 | 模板文本由用户书写 | 改示例总分时手改 subtitle |

## 6. 必须遵守的原则

1. **AMF 先行**：任何试卷内容/布局语义的变化，先改 shared 类型+Schema，
   再改校验器，再改布局/编辑器；不要反过来。
2. **校验前置**：所有外部 AMF 进入系统（导入、生成前）必经
   `/api/amf/validate`；用户可见错误必须是可读中文——ajv oneOf 分支噪音
   由 `validator.ts` 的 SEC_BRANCH/MATCH_BRANCH 映射过滤，新增 oneOf
   结构时同步扩展过滤逻辑。
3. **双端同步**：TS 与 Python 存在镜像逻辑（blanksOf、sanitize 白名单、
   答案文本拼装）；改一侧必须改另一侧。
4. **生成即验证**：`POST /generate` 内部先校验再调 vision；positions 以
   布局返回值为准（不要相信客户端算的几何）。
5. **验收驱动**：先想清楚不变量，写成断言，再实现；完成标准 = 验收全绿
   + web/server 双端 tsc 通过 + 关键页面 modlens 目检。
6. **Windows 环境**：HTTP 测试用 `curl.exe --data-binary @file`（PowerShell
   的 Invoke-RestMethod 有 UTF-8/Content-Length bug）；长驻服务必须带
   热重载（tsx watch / uvicorn --reload / vite），否则改了不生效。
7. **本地优先**：不引入云端依赖；字体等系统资源要有兜底路径。

## 7. 已造好的轮子（直接复用，勿重造）

| 轮子 | 位置 | 用途 |
|---|---|---|
| AMF 类型+Schema | `shared/` | 一切数据结构的唯一事实来源 |
| 校验器（含 oneOf 降噪、错误合成） | `server/src/amf/validator.ts` | 所有校验入口复用 |
| `blanksOf/blanks_of` | shared、vision/layout.py | 新旧填空答案归一化 |
| 富文本净化+排版 | `web/.../RichTextEditor.tsx`（TS sanitize）、`vision/app/richtext.py`（Py sanitize + `to_flowables/measure`） | 任何富文本渲染/输入 |
| QR 负载编解码 | `vision/app/qrpayload.py` | 页归属、考试识别 |
| 流式布局+分页+positions 回填 | `vision/app/layout.py` | 新文档类型照抄其模式 |
| ReportLab 渲染器（字体注册/元素绘制） | `vision/app/render.py` | 新元素类型在此加分支 |
| `remapIndex` | `web/src/amfUtils.ts` | "答案随选项走"类重排映射 |
| 步进器/多空卡片样式 | `web/src/styles.css` | 编辑器 UI 一致性 |
| 验收脚手架 | `scripts/acceptance_m1.py`（`pdf_page_image`、`fill_ratio`、`mm2px` 等） | M2/M3 验收直接在此基础上加 section |
| 一键 dev 启动 | `scripts/dev.mjs` | 本地运行 |
| 图像 QA | `modlens_read_image`（渲染 PDF 页为 PNG 后目检） | 布局回归确认 |

## 8. 后续阶段待办

### M2 客观题批改闭环（下一里程碑）
1. 扫描导入：图片/PDF 批量上传，存入 `data/exams/<id>/scans/`
2. 定位配准：四角 L 标定位 + 透视矫正；QR 解码得考试与页码归属
   （positions.markers 即锚点）
3. 涂卡识别：按 positions 的 bubble rect 等距重建每个气泡 ROI，
   填充率阈值判定（空卡 <0.15 / 填涂 ≥0.5 的几何已被验收 §7 锁定）
4. 学号识别：首页 student_id_rect 网格切格读 12 位考号
5. 判分：单选/多选（全对/漏选/错选规则）/判断；逐学生 result JSON
6. XLSX 导出：学生 × 题目得分矩阵 + 总分

### M3 填空 OCR + 复核
- RapidOCR 本地推理（服务已预留 vision 进程；依赖未装）
- 逐空裁剪（positions 的 `blank` 下标）→ match 规则判定 →
  per_blank 赋分（含全对奖励分）/ all_or_nothing
- 低置信人工复核界面；可选外部 OCR API 配置

### M4 工程化
- 合成样本回归（打印→扫描仿真管线）、批量性能
- Tauri 启动器打包（需 Rust 工具链；当前以 `scripts/dev.mjs` 代替）

## 9. 踩过的坑（避免重蹈）

- **ajv oneOf 噪音**：未过滤时一个 schema 错误炸出 17 条无用分支错误
- **ReportLab**：`str.strip("<br/>")` 是按字符集剥离（吃掉 img 闭合标签
  导致 paraparser 崩溃）——已改正则；图片必须独立成行 flowable
- **热重载**：server 用裸 `tsx` 启动不自动重载；vision 不带 `--reload`
  必须重启——排查"改了没生效"先查这个
- **会话/窗口重启会杀掉后台 dev 进程**：验收报 ECONNREFUSED 先确认
  8790/8791 存活
- **示例 AMF 的总分与副标题是手工同步的**（副标题是自由文本）
- 存量 `data/exams/` 项目在 AMF 结构变更后是旧数据，演示前重新导入示例
