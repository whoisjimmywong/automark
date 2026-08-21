# M4 里程碑：合成样本回归 / 任务持久化 / 性能 / 安装包打包

> 阶段交接：M4 完成内容、关键决策、验收结果、踩坑记录。协作者请先读本文件 + [M1_NOTES.md](M1_NOTES.md) / [M2_NOTES.md](M2_NOTES.md) / [M3_NOTES.md](M3_NOTES.md) / [README_DEV.md](README_DEV.md)。

## 1. M4 完成内容

### ① 合成样本回归规模化（scripts/regression_m4.py）

- 20 名学生合成扫描，**seeded 可复现**（`random.Random(42)` + 每页噪声独立播种）
- 特征变体（按学生 i 确定性分配）：
  - 整页旋转 ±1°~2°（高分辨率 4x 旋转 + INTER_AREA 降采样，保持锐利）
  - 缩放 0.985、椒盐噪声 0.1%（CCD 量级）、浅涂（小盘→复核）、擦除残留、
    填空双影模糊（只作用于第 2 页孤立框 q20，避免污染邻框）
  - **M4 光照鲁棒性验证**：亮度梯度（左 1.0 → 右 0.75）、随机阴影带（0.8 倍）
- 断言（全部通过，14/14）：
  - 客观题识别一致率 **297/297 = 100%**（≥98%）
  - 填空 OCR 一致率 **85/85 = 100%**（"读对或已进复核"= 无静默误判）
  - 错词（人为 zqx）全部判错/部分分/复核（禁止静默判对）
  - 浅涂题全部进复核队列；全对卷满分
  - **真实案例固化**：183001200155=30/41、400237194108=24/41 且 q27 触发
    OCR 候选冲突复核（accept 后 25/41）
- 运行：`vision/.venv/Scripts/python scripts/regression_m4.py`（约 3 分钟）

### ② 批改任务持久化续跑

- job 落盘 `data/exams/:id/jobs/*.json`（创建/每学生完成/状态变化时写盘）
- 启动恢复：`restoreJobs()` 把 running → interrupted（写回磁盘），UI 手动续跑
- **学生级断点续跑**：`POST /grade {resume_from}` 跳过源 job 已处理学生（按 source_file）
- 历史任务列表：`GET /api/projects/:id/jobs`（最近 10 个摘要）
- **协作式中断**：`POST /grade/:jobId/interrupt`（学生循环检查状态后退出）+ 并发锁
  （内存 + 磁盘 running 双重检查，同卷同时只有一个 running 任务）
- UI：批改页新增"批改任务"面板（状态/进度/续跑/中断按钮）

### ③ 性能

- 基准：热启动 **11.7s/学生**、冷启动 16.8s（≤20s 目标达成）；
  **OCR 多框并行推理**后 2 学生全卷 14.1s（7s/学生）
- RapidOCR 模型**启动预热实验被撤销**（实测有害：预热线程导致每次推理慢 ~9s，
  疑似 onnxruntime 会话线程亲和问题；懒加载保持原状）
- OCR 识别分歧惩罚：主候选与备选文本不一致时置信度 ×0.8 → 更易进复核
  （防高置信静默误判，如模糊题 ddogsas）

### ④ 安装包打包（electron-builder NSIS）

- **架构**：三服务全内嵌安装包（~208MB）：
  - vision → **PyInstaller** 单目录 exe（`vision/dist/automark-vision/`，含 rapidocr 模型）
  - server → 便携 **node.exe** + tsc 编译产物（`dist/server/src/index.js` + `dist/shared/`）
    + npm 扁平 node_modules（`build/server/`）
  - web → vite build 产物，由 **server 静态托管**（`@fastify/static`，SPA fallback）
- 数据目录：打包模式 `AUTOMARK_DATA_DIR` → `app.getPath('userData')`（%APPDATA%/AutoMark）
- launcher 双模式：`app.isPackaged` 分支（exe/node/托管）vs 开发模式（venv/tsx/vite）
- 产物：`launcher/release/AutoMark Setup 0.1.0.exe`
- **验证通过**：静默安装 → 启动 → 三服务就绪 → 导入/生成/上传双卡/批改
  （30/41 + 24/41，与开发环境一致）

### ⑤ 灰阶条方案评估（用户提议，验证驱动）

- 提议：答题卡底部六段灰阶条（黑→白递减 + 两端黑）校正扫描光线
- **验证结论：不需要**。合成回归新增"亮度梯度（右端 0.75×）+ 随机阴影带（0.8×）"
  变体后识别一致率仍 **100%**——相对阈值（圆盘 vs 局部背景中位−50）天然抗光线不均；
  且灰阶条在"打印→复印→扫描"链路下中间灰度失真（复印机还原不可靠），
  加条反而可能引入误差 + 占用版面 + 旧卡不兼容
- 若未来需要更强光照鲁棒性，优先做图像预处理（背景场估计/CLAHE），不改版面

## 2. M4 关键决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 打包方式 | electron-builder NSIS（非 Tauri） | Rust 工具链未装；沿用 Electron 栈最快落地 |
| 性能目标 | 单学生 ≤20s | 实测 7-12s，远超目标 |
| 回归规模 | 20 名学生，一致率 ≥98% | 实测客观 100% / 填空 100% |
| 任务持久化 | 完整方案（落盘+续跑+历史+锁） | 用户确认 |
| 灰阶条 | 先验证再定 → 验证后不需要 | 相对阈值已覆盖，见上 |

## 3. M4 踩坑记录

1. **RapidOCR det 对输入尺寸非稳定**（同图不同高度结果抖动、空结果、跨进程不一致）——
   不依赖 det 单路径，三路径候选 + 按置信度排序（M3 已建，M4 验证）
2. **合成扫描必须先绘制后变换**：旋转/缩放前涂卡 → 绘制坐标与变换后内容错位
   （文本偏移出框 OCR 乱读）。正确顺序 = 绘制（模板坐标）→ 整页几何变换 → 噪声 → 光照
3. **旋转插值模糊**：INTER_LINEAR 直接旋转会把实心墨迹抹成浅灰（fill 骤降假象）；
   INTER_NEAREST 又让文本锯齿（OCR 失败）。方案：4x 放大旋转 + INTER_AREA 降采样
4. **QR 解码失败页码推定 bug**：`page_no` 默认恒为 1，非首页 QR 失败会用首页
   positions 采样本页 → 错误气泡覆盖首页正确读数（整卷全空）。修复：按 source.page 推定
5. **PyInstaller 打包 onnxruntime/uvicorn**：`--collect-all rapidocr --collect-all uvicorn`
   （模型与模板都进 _internal）；打包后推理性能与 venv 一致
6. **electron-builder**：extraResources 的 from 目录会被嵌套复制（from 指向子目录时
   出现双层 dist）；node_modules 默认被过滤需单独一条；electron zip 下载失败 → 
   `electronDist` 指向本地 node_modules/electron/dist；winCodeSign/nsis 下载 → 
   `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
7. **tsc 输出结构**：server tsconfig include 含 `../shared` → rootDir 上移 →
   产物为 `dist/server/src/` + `dist/shared/`（launcher 启动路径必须用 dist/server/src/index.js）
8. **Copy-Item 嵌套**：目标目录已存在时 `Copy-Item src dst -Recurse` 会创建 dst/src/
   （先 Remove 目标或复制内容）
9. **OCR 并行推理**：onnxruntime 推理释放 GIL，ThreadPoolExecutor 并行多框有效
   （2 学生 43s → 14s）；但单页 analyze 的并行收益不明显（onnx 内部线程竞争）

## 4. M4 验收

```
scripts/regression_m4.py          → 14/14（含光照变体与真实双卡案例）
scripts/acceptance_m1.py          → 54/54
scripts/acceptance_m2.py          → 23/23
scripts/acceptance_m3.py          → 32/32
scripts/acceptance_opt.py         → 14/14
scripts/acceptance_layout.py      → 13/13
scripts/test_remap.ts / test_case_sensitive.ts → 全过
server/web tsc                    → 0 错误
安装包（launcher/release/AutoMark Setup 0.1.0.exe）→ 静默安装+完整链路通过
```

## 5. 后续待办

- 安装包：自定义应用图标（.ico）、代码签名（可选）、自动更新（可选）
- 性能：多学生并行批改（当前串行，20 名学生 ~3 分钟）
- 任务持久化：中断原因记录（用户主动 vs 崩溃）细化
- 合成回归：扩展模板（多套 AMF）、极端变体（重旋转/重噪声）可选开关
