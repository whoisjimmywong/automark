"""
M2 批改识别管线：扫描页配准 + 涂卡识别 + 学号读取 + QR 解码。

流程（单页）：
  1. 渲染/读入页面灰度图（PDF 用 pymupdf，图片直接读）
  2. Otsu 二值化 → 四角 L 标模板匹配（含 ±6° 旋转变体）得顶点
  3. 顶点 → 模板坐标 单应（≤3 角用平行四边形补齐）→ 透视矫正
  4. 矫正图上按 positions 的 bubble rect 等距重建气泡圆心，算填充率
  5. student_id_rect 网格切格读学号（每列 0-9 十行）
  6. QR 解码（矫正图优先，回退原图），qrpayload 校验归属

坐标约定：mm、页面左上角原点，与 layout.py 常量一致（勿改）。
"""
from __future__ import annotations

import math
import os
from typing import Any

import cv2
import numpy as np
import pymupdf

from .layout import CORNER_ARM, CORNER_OFFSET, CORNER_W, PAGE_H, PAGE_W
from .qrpayload import decode as qr_decode

# ---------------------------------------------------------------- 常量 ----
FILL_SELECTED = 0.50     # 填充率 ≥ 此值判定为涂选
FILL_SUSPICIOUS = 0.25   # 填充率落入 [此值, FILL_SELECTED) 为低置信
ID_FILL_SELECTED = 0.50  # 学号列内最大填充率 ≥ 此值才认定该位
FILL_BG_DELTA = 50       # 墨迹相对阈值：圆盘内像素 < 局部背景中位 - 此值 计为墨迹
FILL_ANN_IN = 1.5        # 背景环内半径（× 采样半径，须落在气泡外缘之外）
FILL_ANN_OUT = 2.1       # 背景环外半径（× 采样半径）
CORNER_MIN_SCORE = 0.25  # 模板匹配最低分（干净印刷通常 ≥ 0.8；二值化使角标与纸边/阴影连通时会下降）
CORNER_WIN_MM = 25.0     # 每角搜索窗半宽（容忍平移/旋转；实测扫描纸偏移可达 ~7mm）
ROT_ANGLES = (-6, -4, -2, 0, 2, 4, 6)

TEMPLATE_VERTS_MM = [
    [CORNER_OFFSET, CORNER_OFFSET],
    [PAGE_W - CORNER_OFFSET, CORNER_OFFSET],
    [CORNER_OFFSET, PAGE_H - CORNER_OFFSET],
    [PAGE_W - CORNER_OFFSET, PAGE_H - CORNER_OFFSET],
]


# ------------------------------------------------------------ 页渲染 ----
def load_page_gray(source: dict, dpi: int) -> tuple[np.ndarray | None, str]:
    """按 source 渲染/读入一页灰度图。返回 (gray, err)。"""
    kind = source.get("kind", "image")
    path = source.get("path", "")
    if not path or not os.path.exists(path):
        return None, f"文件不存在: {path}"
    try:
        if kind == "pdf":
            doc = pymupdf.open(path)
            page = doc[source.get("page", 0)]
            pix = page.get_pixmap(dpi=dpi)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, pix.n)
            doc.close()
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) if pix.n >= 3 else img
            return gray, ""
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return None, f"无法读取图片: {path}"
        if kind == "image_pdf" or path.lower().endswith(".pdf"):
            # 容错：按 pdf 处理
            return load_page_gray({"kind": "pdf", "path": path, "page": source.get("page", 0)}, dpi)
        return img, ""
    except Exception as exc:  # noqa: BLE001
        return None, f"渲染失败: {type(exc).__name__}: {exc}"


def page_count(path: str) -> int:
    """PDF 页数；图片为 1。"""
    if path.lower().endswith(".pdf"):
        try:
            doc = pymupdf.open(path)
            n = doc.page_count
            doc.close()
            return n
        except Exception:  # noqa: BLE001
            return 0
    return 1


# ------------------------------------------------------------ 角标检测 ----
def _draw_l(img: np.ndarray, v: int, arm: int, w: int, corner: str) -> None:
    """在模板图上画 L 标（top-left 原点，y 向下；v = 顶点坐标）。"""
    if corner == "tl":
        cv2.rectangle(img, (v, v), (v + arm, v + w), 255, -1)
        cv2.rectangle(img, (v, v), (v + w, v + arm), 255, -1)
    elif corner == "tr":
        cv2.rectangle(img, (v, v), (v + arm, v + w), 255, -1)
        cv2.rectangle(img, (v + arm - w, v), (v + arm, v + arm), 255, -1)
    elif corner == "bl":
        cv2.rectangle(img, (v, v), (v + w, v + arm), 255, -1)
        cv2.rectangle(img, (v, v + arm - w), (v + arm, v + arm), 255, -1)
    else:  # br
        cv2.rectangle(img, (v + arm - w, v), (v + arm, v + arm), 255, -1)
        cv2.rectangle(img, (v, v + arm - w), (v + arm, v + arm), 255, -1)


def _make_l_template(scale: float, angle_deg: float, corner: str) -> tuple[np.ndarray, float, float]:
    """生成 L 标模板（255=墨迹）及顶点相对模板中心偏移 (ox, oy)（px，y 向下）。

    L 的顶点 = 两臂交汇的内角（即 positions.markers.corners 记录的点）：
    tl=(v,v) tr=(v+arm,v) bl=(v,v+arm) br=(v+arm,v+arm)，v=margin。
    """
    arm = max(int(round(CORNER_ARM * scale)), 8)
    w = max(int(round(CORNER_W * scale)), 3)
    margin = 12
    size = arm + 2 * margin
    img = np.zeros((size, size), np.uint8)
    _draw_l(img, margin, arm, w, corner)
    cx = cy = size / 2.0
    vpos = {
        "tl": (margin, margin),
        "tr": (margin + arm, margin),
        "bl": (margin, margin + arm),
        "br": (margin + arm, margin + arm),
    }[corner]
    ox, oy = vpos[0] - cx, vpos[1] - cy
    if angle_deg:
        M = cv2.getRotationMatrix2D((cx, cy), angle_deg, 1.0)
        img = cv2.warpAffine(img, M, (size, size), borderValue=0,
                             flags=cv2.INTER_LINEAR)
        a = math.radians(angle_deg)
        ox, oy = ox * math.cos(a) - oy * math.sin(a), ox * math.sin(a) + oy * math.cos(a)
    return img, ox, oy


def _detect_corners(gray: np.ndarray, scale: float) -> tuple[list[list[float] | None], list[str]]:
    """检测四角 L 标顶点（mm 坐标）。scale = px per mm（由图像实际尺寸推导）。

    未检出的角标记 None（JSON 序列化为 null）——缺 1 角仍可由 3 点配准，
    不要让 NaN 破坏响应序列化（FastAPI allow_nan=False 会抛 ValueError）。
    """
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    templates: dict[str, list[tuple[np.ndarray, float, float]]] = {}
    for kind in ("tl", "tr", "bl", "br"):
        templates[kind] = [_make_l_template(scale, a, kind) for a in ROT_ANGLES]

    warnings: list[str] = []
    verts: list[list[float] | None] = []
    win = int(CORNER_WIN_MM * scale)
    for idx, (ex, ey, kind) in enumerate(
        [(CORNER_OFFSET, CORNER_OFFSET, "tl"),
         (PAGE_W - CORNER_OFFSET, CORNER_OFFSET, "tr"),
         (CORNER_OFFSET, PAGE_H - CORNER_OFFSET, "bl"),
         (PAGE_W - CORNER_OFFSET, PAGE_H - CORNER_OFFSET, "br")]
    ):
        cx, cy = int(ex * scale), int(ey * scale)
        x0, y0 = max(cx - win, 0), max(cy - win, 0)
        x1, y1 = min(cx + win, bw.shape[1]), min(cy + win, bw.shape[0])
        window = bw[y0:y1, x0:x1]
        best_loc, best_score, best_off, best_shape = None, -1.0, (0.0, 0.0), (0, 0)
        for tmpl, ox, oy in templates[kind]:
            if window.shape[0] < tmpl.shape[0] or window.shape[1] < tmpl.shape[1]:
                continue
            res = cv2.matchTemplate(window, tmpl, cv2.TM_CCOEFF_NORMED)
            _, mx, _, ml = cv2.minMaxLoc(res)
            if mx > best_score:
                best_score, best_loc, best_off, best_shape = mx, ml, (ox, oy), tmpl.shape
        if best_loc is None or best_score < CORNER_MIN_SCORE:
            warnings.append(f"第 {idx + 1} 个角标未检出（score={best_score:.2f}）")
            verts.append(None)
            continue
        vx = x0 + best_loc[0] + best_shape[1] / 2.0 + best_off[0]
        vy = y0 + best_loc[1] + best_shape[0] / 2.0 + best_off[1]
        verts.append([round(vx / scale, 2), round(vy / scale, 2)])
    return verts, warnings


def _complete_homography_src(verts: list[list[float] | None]) -> np.ndarray | None:
    """顶点 → 4×2 单应源点（mm）。缺角时用平行四边形补齐；<3 个返回 None。"""
    pts = [v for v in verts if v is not None]
    if len(pts) < 3:
        return None
    tl, tr, bl = pts[0], pts[1], pts[2]
    if len(pts) == 4:
        br = pts[3]
    else:
        br = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1]]
    return np.array([tl, tr, bl, br], dtype=np.float32)


def warp_page(gray: np.ndarray, scale: float,
              verts: list[list[float] | None]) -> tuple[np.ndarray | None, list[str]]:
    """透视矫正到标准模板坐标系（210×297mm @ scale）。返回 (warped, warnings)。

    源点/目标点都换算为像素（mm × scale）：单应是 源px→模板px 的近恒等映射。
    """
    src = _complete_homography_src(verts)
    if src is None:
        return None, ["角标不足 3 个，无法配准"]
    dst = np.array(TEMPLATE_VERTS_MM, dtype=np.float32) * scale
    try:
        H = cv2.getPerspectiveTransform(src * scale, dst)
    except cv2.error:
        return None, ["单应矩阵求解失败"]
    warped = cv2.warpPerspective(gray, H,
                                 (int(round(PAGE_W * scale)), int(round(PAGE_H * scale))),
                                 flags=cv2.INTER_LINEAR)
    return warped, []


# ------------------------------------------------------------ 采样读取 ----
def _fill_at(img: np.ndarray, scale: float, cx_mm: float, cy_mm: float, r_mm: float) -> float:
    """圆盘内墨迹占比（mm 坐标 → px）。

    墨迹判定用**相对阈值**：像素 < 局部背景中位 − FILL_BG_DELTA 计为墨迹；
    局部背景取采样圆外 1.5–2.1 倍半径的环形中位数。相比固定阈值 128，
    对浅涂/铅笔轻重/扫描亮度差异自适应（实测真实扫描：空泡 ≤0.13，
    浅涂 ≥0.55，分离度远大于 0.5/0.25 阈值带）。
    """
    r_px = max(int(round(r_mm * scale)), 2)
    x, y = int(round(cx_mm * scale)), int(round(cy_mm * scale))
    h, w = img.shape
    span = int(round(FILL_ANN_OUT * r_px))
    if x - span < 0 or y - span < 0 or x + span >= w or y + span >= h:
        return 0.0
    roi = img[y - span:y + span + 1, x - span:x + span + 1]
    yy, xx = np.ogrid[: 2 * span + 1, : 2 * span + 1]
    disk = (xx - span) ** 2 + (yy - span) ** 2 <= r_px * r_px
    ann = ((xx - span) ** 2 + (yy - span) ** 2 >= (FILL_ANN_IN * r_px) ** 2) & \
          ((xx - span) ** 2 + (yy - span) ** 2 <= (FILL_ANN_OUT * r_px) ** 2)
    bg = float(np.median(roi[ann])) if roi[ann].size else 255.0
    ink = disk & (roi < bg - FILL_BG_DELTA)
    return float(ink.sum() / disk.sum())


def read_bubble_block(warped: np.ndarray, scale: float, block: dict,
                      bubble_d: float) -> list[float]:
    """按 bubble 块 rect 等距重建各选项气泡圆心，返回填充率列表。"""
    x1, y1, x2, y2 = block["rect"]
    n = int(block.get("options", 0))
    if n < 1:
        return []
    pad = bubble_d / 2.0 + 1.0
    step = (x2 - x1 - 2 * pad) / (n - 1) if n > 1 else 0.0
    cy = (y1 + y2) / 2.0
    r_sample = bubble_d / 2.0 * 0.75
    return [_fill_at(warped, scale, x1 + pad + i * step, cy, r_sample) for i in range(n)]


def read_student_id(warped: np.ndarray, scale: float, rect: list[float],
                    digits: int, bubble_d: float) -> dict:
    """学号涂卡网格（digits 列 × 10 行）切格读取。"""
    x1, y1, x2, y2 = rect
    pad = bubble_d / 2.0 + 1.0
    cxs = [x1 + pad + i * (x2 - x1 - 2 * pad) / max(digits - 1, 1) for i in range(digits)]
    cys = [y1 + pad + r * (y2 - y1 - 2 * pad) / 9.0 for r in range(10)]
    r_sample = bubble_d / 2.0 * 0.75
    grid = [[_fill_at(warped, scale, cx, cy, r_sample) for cx in cxs] for cy in cys]

    read: list[int | None] = []
    confidence = 0.0
    for d in range(digits):
        col = [grid[r][d] for r in range(10)]
        best = max(range(10), key=lambda r: col[r])
        confidence = max(confidence, col[best])
        read.append(best if col[best] >= ID_FILL_SELECTED else None)
    ok = all(d is not None for d in read)
    return {
        "ok": ok,
        "digits": read,
        "read": "".join(str(d) if d is not None else "?" for d in read),
        "confidence": round(confidence, 3),
        "grid": [[round(v, 3) for v in row] for row in grid],
    }


def decode_qr(warped: np.ndarray, gray: np.ndarray | None = None) -> str | None:
    """QR 解码：矫正图优先，回退原图。返回原始负载或 None。"""
    det = cv2.QRCodeDetector()
    for img in (warped, gray):
        if img is None or img.size == 0:
            continue
        try:
            data, _, _ = det.detectAndDecode(img)
            if data:
                return data
        except cv2.error:
            continue
    return None


# ------------------------------------------------------------ 主入口 ----
def analyze_page(source: dict, dpi: int, exam_id: str, positions: dict,
                 config: dict, out_png: str | None = None,
                 do_ocr: bool = False, ocr_config: dict | None = None) -> dict:
    """单页完整分析。positions = AMF positions（全部页），config 含 bubble_size_mm/digits/role。

    do_ocr=True 时对 ocr 块执行填空转写（engine: local|external，见 app/ocr.py）。
    scale 由图像实际尺寸推导（A4 宽 210mm）——上传图片 DPI 未知时也正确；
    PDF 页按请求 dpi 渲染，结果一致。
    """
    gray, err = load_page_gray(source, dpi)
    if gray is None:
        return {"ok": False, "error": err}

    scale = gray.shape[1] / PAGE_W
    bubble_d = float(config.get("bubble_size_mm", 4.0))
    digits = int((config.get("student_id") or {}).get("digits", 12))
    role = config.get("role", "answer_sheet")

    warnings: list[str] = []
    verts, warn = _detect_corners(gray, scale)
    warnings.extend(warn)
    import os as _os
    if _os.environ.get("AUTOMARK_DEBUG_ANALYZE"):
        import sys as _sys
        print(f"[DBG] analyze {source.get('path','')} page={source.get('page')} "
              f"shape={gray.shape} verts={[[round(v[0],1),round(v[1],1)] if v else None for v in verts]} "
              f"corner_warn={warn}", file=_sys.stderr, flush=True)

    warped, warp_warn = warp_page(gray, scale, verts)
    warnings.extend(warp_warn)
    if warped is None:
        return {"ok": False, "error": "页面配准失败（角标不足）", "warnings": warnings}

    if out_png:
        try:
            cv2.imwrite(out_png, warped)
        except cv2.error:
            pass

    # ---- QR：解码 + 归属校验 ----
    payload = decode_qr(warped, gray)
    qr_info: dict = {"ok": False, "payload": None, "decoded": None, "error": "未检测到二维码"}
    # 页码推定：QR 成功用负载页码；失败按扫描顺序（source.page 0 起）——不能恒为 1，
    # 否则非首页 QR 失败会用首页 positions 采样本页图像，错误结果覆盖首页读数
    page_no = int(source.get("page", 0)) + 1
    import os as _os2
    if _os2.environ.get("AUTOMARK_DEBUG_ANALYZE"):
        import sys as _sys2
        print(f"[DBG] page={source.get('page')} qr_payload={payload!r}", file=_sys2.stderr, flush=True)
    if payload:
        dec = qr_decode(payload)
        if dec is None:
            warnings.append("QR 校验失败（负载非法）")
        else:
            qr_info = {"ok": True, "payload": payload, "decoded": dec}
            page_no = dec.get("page", 1)
            expected_code = _exam_short_code(exam_id)
            if dec.get("exam_code") != expected_code:
                warnings.append(f"QR 考试短码不符（{dec.get('exam_code')} ≠ {expected_code}）")
    else:
        warnings.append("QR 解码失败，按扫描顺序推定页码")

    # ---- 取本页 positions ----
    page_pos = None
    for pp in positions.get("pages", []):
        if pp.get("page") == page_no and pp.get("role") == role:
            page_pos = pp
            break
    if page_pos is None:
        # 回退：按扫描顺序第一份 positions
        page_pos = positions.get("pages", [{}])[0] if positions.get("pages") else None
        if page_pos is not None:
            warnings.append(f"未找到页码 {page_no} 的 positions，回退到第 1 页")

    # ---- 涂卡 ----
    bubbles: list[dict] = []
    blocks = (page_pos or {}).get("blocks", []) or []
    for block in blocks:
        if block.get("kind") != "bubble":
            continue
        fills = read_bubble_block(warped, scale, block, bubble_d)
        selected = [i for i, f in enumerate(fills) if f >= FILL_SELECTED]
        suspicious = [i for i, f in enumerate(fills) if FILL_SUSPICIOUS <= f < FILL_SELECTED]
        bubbles.append({
            "qid": block.get("qid"),
            "options": block.get("options", len(fills)),
            "fill": [round(f, 4) for f in fills],
            "selected": selected,
            "suspicious": suspicious,
        })

    # ---- 学号 ----
    sid_rect = (page_pos or {}).get("student_id_rect")
    student_id: dict | None = None
    if sid_rect:
        student_id = read_student_id(warped, scale, sid_rect, digits, bubble_d)
    else:
        warnings.append("本页无学号涂卡区（非首页），学号以同文件首页为准")

    # ---- 缺考/异常标记（首页 ABSENT/WITHDRAWN 圈）----
    absent = False
    absent_rect = (page_pos or {}).get("absent_rect")
    if absent_rect:
        x1, y1, x2, y2 = absent_rect
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        r = (x2 - x1) / 2.0 - 0.6  # 采样半径略小于圈半径（避开描边）
        absent = _fill_at(warped, scale, cx, cy, max(r, 1.0)) >= FILL_SELECTED

    # ---- 填空 OCR（M3，可选）----
    ocr_out: list[dict] = []
    if do_ocr:
        from . import ocr as ocr_mod
        ocr_out = ocr_mod.ocr_blocks(warped, scale, blocks, ocr_config or {})

    return {
        "ok": True,
        "page": page_no,
        "qr": qr_info,
        "corners": {"found": sum(1 for v in verts if v is not None),
                    "points_mm": verts},
        "bubbles": bubbles,
        "student_id": student_id,
        "absent": absent,
        "ocr": ocr_out,
        "warnings": warnings,
    }


def _exam_short_code(exam_id: str) -> str:
    """与 qrpayload.exam_short_code 一致（避免循环导入的镜像实现）。"""
    import hashlib
    digest = hashlib.sha256(exam_id.encode("utf-8")).digest()
    n = int.from_bytes(digest[:4], "big") % (36 ** 6)
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    out = []
    for _ in range(6):
        out.append(chars[n % 36])
        n //= 36
    return "".join(reversed(out))
