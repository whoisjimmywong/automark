# AutoMark · M2 阶段文档（客观题批改闭环）

> 面向协作者的阶段交接文档：M2 已实现什么、怎么跑、哪些不变量在延续、
> 哪些轮子新增可用、已知限制与后续事项。
> 前置必读：[M1_NOTES.md](M1_NOTES.md)（M1 的坐标系/QR/positions/角标等不变量依旧生效）。
> 验收：M1 49/49 + M2 23/23 全绿。

## 1. M2 交付内容

M1 完成「组卷闭环」，M2 打通**客观题批改闭环**（对应 product_dev 里程碑 2）：

```
扫描件上传 → 逐页配准（L 标+QR+透视矫正）→ 涂卡识别 → 学号读取 → 判分 → 结果 JSON → XLSX 导出
```

### 1.1 扫描导入
- `POST /api/projects/:id/scans`（multipart，字段 `files`，PDF/图片均可，单文件 ≤200MB）
- `GET /api/projects/:id/scans`、`DELETE /api/projects/:id/scans/:name`
- 落盘 `data/exams/<id>/scans/`；重名自动加时间戳前缀

### 1.2 定位配准（vision `app/scan.py`）
- 灰度 → Otsu 二值化 → **四角 L 标模板匹配**（按角位生成 4 种朝向模板 × ±6° 旋转变体，
  在期望位置 ±20mm 窗口内搜索；`CORNER_MIN_SCORE=0.3`）
- L 顶点（两臂交汇内角）→ 模板坐标**单应**；≤3 角时平行四边形补齐（容忍污损 1 角）
- **QR 解码归属**：`cv2.QRCodeDetector` → `qrpayload.decode` 校验版本/考试短码/页码；
  失败回退按扫描顺序推定页码
- 矫正图落盘 `processed/<file>_p<n>.png`（复核/目检用）

### 1.3 涂卡识别
- 按 positions 的 bubble rect **等距重建**每个气泡圆心（与 layout.py 的 pad/间距公式一致）
- 采样圆盘半径 = 气泡半径 × 0.75；填充率 = 暗像素占比
- 判定阈值：`≥0.5` 涂选 / `[0.25, 0.5)` 低置信 / `<0.25` 未涂（常量 `FILL_SELECTED/FILL_SUSPICIOUS`，
  vision 侧与判分侧一致）

### 1.4 学号识别
- `student_id_rect` 网格切格（digits 列 × 10 行）逐列取填充率最大行；`≥0.5` 认定该位数字
- 读不出 → server 按扫描顺序兜底 `S<序号>`，标记 `id_from_bubbles=false` + warning

### 1.5 判分（server `services/scoring.ts`）
- 单选/判断：正确满分、错误/未涂 0 分；组内多涂 → `review`
- 多选：全对满分；漏选部分分（默认满分×0.5）；错选/多选/未涂 0 分（`scoring.full/partial/wrong` 可配）
- 低置信气泡（浅涂/擦除残留）→ `review`（得分按最佳猜测计但标记）
- 置信度 = `1 - exp(-6·(最高涂选填充率 - 次高))`
- 填空 M2 不批改：verdict=`pending`、得分 0（M3 由 OCR 接管）

### 1.6 结果与导出
- 逐学生 `results/<student_id>.json`（结构对齐 product_dev §9.2）；`GET /api/projects/:id/results` 汇总
- **XLSX 四工作表**（server 侧 exceljs，`services/exportService.ts`）：
  Metadata / StudentAnswers / StudentScores / ClassReport，列名英文固定
- `POST /api/projects/:id/export` + `GET /api/projects/:id/files/export` 下载

### 1.7 Web 批改 UI
- 项目页新增「组卷 / 批改」页签（`App.tsx` + `web/src/grading/GradingPage.tsx`）
- 上传扫描件、批改进度条（轮询 job）、结果表、学生详情（逐题判定/置信度）、
  待复核项看矫正原图、导出 XLSX

## 2. 新增/修改文件

| 文件 | 说明 |
|---|---|
| `vision/app/scan.py` | 识别管线（配准/涂卡/学号/QR） |
| `vision/app/main.py` | +`/scan/info`、`/scan/render`、`/scan/analyze` |
| `shared/results.types.ts` | 判分结果类型（前后端共享） |
| `server/src/services/scanManager.ts` | 扫描件/processed/results/exports 目录管理 |
| `server/src/services/scoring.ts` | 判分引擎 |
| `server/src/services/gradingService.ts` | 批改编排（后台 job + 进度） |
| `server/src/services/exportService.ts` | exceljs 四工作表导出 |
| `server/src/routes/grading.ts` | scans/grade/results/export 路由 |
| `server/src/index.ts` | 注册 multipart 与批改路由 |
| `web/src/grading/GradingPage.tsx` | 批改页 |
| `web/src/App.tsx` / `api.ts` / `styles.css` | 页签 / API / 样式 |
| `scripts/acceptance_m2.py` | M2 验收（23 断言） |

server 新增依赖：`exceljs`、`@fastify/multipart`。

## 3. 运行与验收

```bash
pnpm dev                      # 一键拉起三进程
# 需 server(8790) + vision(8791) 已启动；acceptance_m2 从仓库根目录运行
vision/.venv/Scripts/python scripts/acceptance_m2.py    # 23 项断言
# 回归闸门（M1 侧不变量）：
cd vision && ../vision/.venv/Scripts/python ../scripts/acceptance_m1.py   # 49 项
npx tsx scripts/test_remap.ts                            # 4 项
pnpm --filter @automark/server exec tsc --noEmit
pnpm --filter @automark/web exec tsc --noEmit
```

acceptance_m2 覆盖：导入生成 → 合成 3 名学生作答（全对/错选漏选未涂/浅涂）→
上传批改 → 学号读取、判分（含 partial/review）、results 落盘、XLSX 四工作表。

## 4. 关键约定与踩坑记录

- **scale 由图像实际尺寸推导**（`scale = 图像宽 px / 210mm`），**不要信任请求里的 dpi**——
  上传图片的 DPI 元数据不可靠，按 dpi 算坐标会把右/下角标算出图外（已踩坑）。
  PDF 页按请求 dpi 渲染后同样适用。
- **L 标顶点 = 两臂交汇内角**，即 `positions.markers.corners` 记录的点；
  模板顶点偏移必须按角位取 `(v|v+arm, v|v+arm)`，否则单应差一个臂长（已踩坑）。
- **单应源点/目标点都要是像素**（mm × scale），混用会把整页缩放（已踩坑）。
- 判定阈值在 vision（识别）与 server（判分）各有一份常量，改阈值需双端同步。
- positions/QR/角标几何/坐标系等 M1 不变量**未改动**；M1 回归 49/49 保持。
- Windows 控制台跑 python 脚本输出中文乱码：设 `PYTHONIOENCODING=utf-8` 或重定向到文件。

## 5. 已知限制（M2 边界，M3/M4 处理）

- 一份扫描文件 = 一名学生（多页答题卡在文件内按顺序合并；多学生合一个 PDF 的切分不支持，见 F-2）
- 批改 job 状态在**进程内存**：server 重启后进度丢失，需重新批改（任务持久化/续跑列 M4）
- 同一学号重复出现时结果互相覆盖（未做去重/合并确认）
- 页面方向假设为正立（倒置页自动翻转未实现；±3°~±6° 内倾斜由模板旋转覆盖）
- 红笔/批注颜色通道过滤未实现（仅分析标记块 ROI，天然规避大部分干扰）
- 人工复核**改判**界面、填空 OCR、外部 OCR API 配置属 M3

## 6. M3 待办（路线图延续）

填空 OCR（RapidOCR，vision 进程已预留）、逐空裁切 + match 规则判定 + per_blank 赋分、
低置信人工复核改判界面、外部 OCR/视觉 LLM API 配置（OpenAI 兼容）、
合成样本回归规模化（M4）。
