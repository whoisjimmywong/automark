# AutoMark · M3 阶段文档（填空 OCR + 人工复核 + 设置框架）

> 面向协作者的阶段交接文档。前置必读：[M1_NOTES.md](M1_NOTES.md)（不变量）、
> [M2_NOTES.md](M2_NOTES.md)（客观题批改闭环）。
> 验收：M1 49/49 + M2 23/23 + M3 29/29 全绿。

## 1. M3 交付内容

M2 打通客观题批改，M3 补齐**填空 OCR 批改 + 人工复核改判 + 设置框架**：

```
填空框 ROI（positions.ocr 块）→ 裁剪 → RapidOCR 转写 → 匹配判分（per_blank/all_or_nothing）
→ 低置信进复核队列 → 教师改判（改文本/标空白/接受）→ 重算成绩 → 导出反映
```

### 1.1 填空 OCR（vision `app/ocr.py`）
- **RapidOCR v2**（`rapidocr`，onnxruntime 后端；懒加载单例，首调加载模型 ~10-20s）
- 逐空裁剪（`blank` 下标）→ 放大归一化 → OCR → 逐行文本 + 置信度（0-1）
- 多空题 (1)(2) 序号令牌从文本中剥离（标签可能在框内被裁入）
- **OCR 裁剪 pad = 0**：框线被裁入会让检测器误读（实测 0.5mm pad 即 dogs→sãop）
- 外部引擎（OpenAI 兼容视觉接口）代码就绪：`engine: external` + endpoint/key/model，
  未配置 key 时抛可读错误（需用户自备 key 才能端到端验证）

### 1.2 答案匹配与判分（server `services/scoring.ts`）
- 归一化（§8.5）：NFKC、全角→半角、小写、折叠空白、去句尾标点
- 匹配规则：`exact` / `any_of`（同义列表）/ `regex`（全匹配）/ `numeric`（±tolerance）
- **per_blank**：逐空 points（缺省均分）；全部答对且 Σpoints < 总分 → 补足总分（全对奖励）
- **all_or_nothing**：全对满分，否则 0（部分匹配 verdict = incorrect，不是 partial）
- OCR 置信度 < `ocr.min_confidence`（默认 0.6）且文本非空 → verdict `review` + 进复核队列

### 1.3 人工复核（web `ReviewPage.tsx` + server 路由）
- 复核队列：`GET /api/projects/:id/review-items`（当前 verdict=review 的条目，按置信度升序）
- 原图裁剪：`GET .../review-items/:student/:qid/crop`（vision `/scan/crop` 按 mm rect 裁矫正页图）
- 改判：`PUT .../review-items/:student/:qid`
  - `accept`（信任当前识别，解除 review）/ `override_text`（修正转写文本）/
    `mark_blank`（标空白）/ `select`（客观题改选项）
- 改判后自动重算该生成绩并写 `results/<id>.json`，`review_log` 记录审计轨迹；
  队列自然反映（该题不再 review）

### 1.4 设置框架（`data/settings.json` + web 设置弹窗）
- `ocr.engine: local|external`、`ocr.min_confidence`（复核阈值）、外部 API endpoint/key/model
- `grading.fill_selected/fill_suspicious`（涂卡阈值）、`export.include_rank`
- 启用外部引擎时 UI 显著提示「数据将发送至第三方服务」
- `GET/PUT /api/settings`；批改任务读取设置（引擎/阈值）

## 2. 新增/修改文件

| 文件 | 说明 |
|---|---|
| `vision/app/ocr.py` | 填空 OCR 管线（RapidOCR v2 + 外部引擎适配） |
| `vision/app/main.py` | +`/scan/crop`；`/scan/analyze` 支持 `do_ocr`/`ocr_config` |
| `vision/app/scan.py` | analyze_page 增加 OCR 步骤 |
| `shared/settings.types.ts` | 全局设置类型 + 默认值 + 清洗 |
| `shared/results.types.ts` | raw 增加 texts/confidences/matched/ocr_engine；ReviewItem/ReviewDecision/ReviewLog |
| `shared/amf.types.ts` | BlockPosition 补 `blank`（类型遗漏修复，数据本就有） |
| `server/src/services/scoring.ts` | 归一化/匹配/填空判分 |
| `server/src/services/gradingService.ts` | OCR 流、复核队列、改判重算 |
| `server/src/services/settingsService.ts` | 设置读写 |
| `server/src/routes/grading.ts` | 复核/设置路由 |
| `web/src/grading/ReviewPage.tsx` | 复核界面 |
| `web/src/settings/SettingsDialog.tsx` | 设置弹窗 |
| `web/src/App.tsx` / `api.ts` / `styles.css` | 复核页签 / API / 样式 |
| `scripts/acceptance_m3.py` | M3 验收（29 断言） |
| `scripts/acceptance_m1/m2.py` | api() 加连接重试；M2 填空断言随 M3 行为更新 |

vision 依赖：`rapidocr>=2.0`（替换 rapidocr_onnxruntime，其默认模型在部分机器执行异常）；
opencv 换非 headless 版（rapidocr 依赖，headless 与之文件冲突，勿换回）。

## 3. 运行与验收

```bash
pnpm dev
# 需 server(8790) + vision(8791) 已启动
vision/.venv/Scripts/python scripts/acceptance_m1.py    # 49（组卷回归）
vision/.venv/Scripts/python scripts/acceptance_m2.py    # 23（客观题回归）
vision/.venv/Scripts/python scripts/acceptance_m3.py    # 29（填空+复核+设置）
npx tsx scripts/test_remap.ts
pnpm --filter @automark/server exec tsc --noEmit && pnpm --filter @automark/web exec tsc --noEmit
```

acceptance_m3 覆盖：合成 3 名学生（印刷体填空，300 DPI）——A 全对（per_blank 奖励、
数值容差、all_or_nothing）；B 部分对（半对 0.5、超容差、一空错、错词）；C 双影凌乱字迹
（OCR 置信度 < 0.6 → review）→ 复核队列/裁剪图/override_text 改判/重算/日志 → 设置读写往返。

## 4. 踩坑记录（重要）

- **PIL 12.x `Image.fromarray` 是拷贝语义**：draw 后必须 `arr[:] = np.asarray(pil)` 写回，
  否则模型拿到空白图（曾导致误判 RapidOCR/模型损坏，实际完全正常）。
- **RapidOCR 置信度高度饱和**（可读文本 0.7-1.0，几乎不随对比度/模糊下降）：
  合成「低置信」要用双影叠印（书写凌乱）而非浅色/模糊。
- **OCR 裁剪 pad=0**：框线/序号标签被裁入会让 det 误读（dogs→sãop / (2)by 混入）。
- **onnxruntime 1.29 + rapidocr_onnxruntime(v1) 的 v3 模型在本机全零输出**（原因未明，
  疑似特定模型导出与新版 onnxruntime 算子不兼容）；改用 rapidocr v2（v6 模型，onnxruntime
  1.24.1）正常。若遇同类问题优先换模型/引擎版本而非深挖算子。
- 热重载（tsx watch / uvicorn --reload）会在运行中重启服务，**中断进行中的批改任务与连接**；
  验收前确认代码已稳定，服务用干净启动。
- 本机网络偶发瞬断（WinError 10053，GitHub/PyPI 下载也失败过）：验收脚本 api() 已加重试；
  大下载走清华镜像。

### 实战复盘补充（真实扫描件 1000159483.pdf）

- **JSON NaN 会炸整页**：角标未检出若记 `[nan, nan]`，FastAPI JSONResponse（allow_nan=False）
  序列化抛 `ValueError: Out of range float values are not JSON compliant` → 整页分析失败
  （即使 3 角标足以配准）。修复：未检出记 `None`；main.py 响应前递归清洗 NaN。
- **角标匹配分数会因二值化连通而降**：扫描页左上角标与纸边/阴影带连通后 score 从 ~0.9
  降到 0.27。阈值 0.3→0.25、搜索窗 ±20→±25mm；缺 1 角仍可 3 点配准（设计本意）。
- **det 漏检小字手写**：真实铅笔手写短词（`of`、`on` 等）RapidOCR det 常返回空 →
  `use_det=False` 整框直送 rec 兜底，12 空全部出结果。
- **降级识别置信度虚高**：use_det=False 对凌乱字迹给出虚高置信（双影文本 0.74 但内容乱码），
  高置信误判会绕过复核——降级路径置信度打 7 折，更保守（低置信更易进复核）。
- **生成 PDF 被外部程序占用**：WPS/浏览器打开 generated/*.pdf 后重新生成报
  `PermissionError: [Errno 13]`——需先关闭查看器。
- 真实作答：涂卡浅涂（q35/q36 fill≈0.6 区间）与学号个别位未涂（读 '?'）是正常数据，
  分别走复核兜底与顺序兜底，非 bug；q23 标准答案录入错误（pass by 误写 past）属人工疏漏，
  核对答案卷时应逐空对照原文。

## 5. 已知限制（M4 方向）

- 填空 OCR 依赖本地字体渲染质量：印刷体可靠，潦草手写体准确率有限（低置信进复核兜底）
- 复核改判一次一题（无批量接受/跳过快捷键；批量接受在复核列表「接受」逐条操作）
- 外部 OCR 引擎需自备 key；未配置时引擎选择 external 会批改报错（可读提示）
- 批改任务状态仍为进程内存（重启丢失）；合成样本回归规模化、任务持久化续跑属 M4
