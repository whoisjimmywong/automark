"""
AutoMark vision 服务（FastAPI）——布局/PDF 生成/批改识别/填空 OCR。
"""
from __future__ import annotations

import math
import os
import traceback
from typing import Any

import cv2
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import layout, render, richtext, scan

app = FastAPI(title="AutoMark Vision", version="0.1.0")


def _sanitize(o: Any) -> Any:
    """递归把非有限浮点（NaN/Inf）替换为 None——JSON 不允许 NaN，
    Starlette 的 JSONResponse 用 allow_nan=False，遇 NaN 会抛 ValueError 炸掉整页分析。"""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_sanitize(v) for v in o]
    return o


def _json(content: Any) -> JSONResponse:
    return JSONResponse(content=_sanitize(content))


class RenderRequest(BaseModel):
    amf: dict[str, Any]
    out_dir: str


class AnalyzeRequest(BaseModel):
    source: dict[str, Any]        # {"kind": "pdf"|"image", "path": str, "page": int}
    dpi: int = 300
    exam_id: str
    positions: dict[str, Any]     # AMF positions（全部页）
    config: dict[str, Any] = {}   # answer_sheet_config 子集
    out_png: str | None = None    # 可选：矫正页图落盘路径
    do_ocr: bool = False          # M3：是否执行填空 OCR
    ocr_config: dict[str, Any] = {}  # {engine: local|external, min_confidence, external:{endpoint,api_key,model}}


class CropRequest(BaseModel):
    path: str
    rect: list[float]             # mm [x1,y1,x2,y2]
    pad_mm: float = 2.0


class RenderPageRequest(BaseModel):
    path: str
    page: int = 0
    dpi: int = 150
    out_png: str | None = None


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "automark-vision", "version": "0.1.0"}


@app.post("/scan/info")
def scan_info(req: RenderPageRequest) -> JSONResponse:
    """扫描文件信息：类型 + 页数。"""
    try:
        return JSONResponse({"ok": True, "path": req.path,
                             "kind": "pdf" if req.path.lower().endswith(".pdf") else "image",
                             "pages": scan.page_count(req.path)})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=200, content={"ok": False,
                                                      "error": f"{type(exc).__name__}: {exc}"})


@app.post("/scan/render")
def scan_render(req: RenderPageRequest) -> JSONResponse:
    """把扫描 PDF/图片的一页渲染为 PNG（UI 预览用）。"""
    try:
        gray, err = scan.load_page_gray({"kind": "pdf" if req.path.lower().endswith(".pdf") else "image",
                                         "path": req.path, "page": req.page}, req.dpi)
        if gray is None:
            return JSONResponse(status_code=200, content={"ok": False, "error": err})
        if req.out_png:
            import os
            os.makedirs(os.path.dirname(req.out_png), exist_ok=True)
            cv2.imwrite(req.out_png, gray)
        import base64
        ok, buf = cv2.imencode(".png", gray)
        if not ok:
            return JSONResponse(status_code=200, content={"ok": False, "error": "PNG 编码失败"})
        return JSONResponse(content={"ok": True, "png_b64": base64.b64encode(buf.tobytes()).decode()})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=200, content={"ok": False,
                                                      "error": f"{type(exc).__name__}: {exc}"})


@app.post("/scan/analyze")
def scan_analyze(req: AnalyzeRequest) -> JSONResponse:
    """单页批改分析：配准 + 涂卡 + 学号 + QR +（可选）填空 OCR。"""
    try:
        if req.out_png:
            import os
            os.makedirs(os.path.dirname(req.out_png), exist_ok=True)
        result = scan.analyze_page(req.source, req.dpi, req.exam_id,
                                   req.positions, req.config, req.out_png,
                                   do_ocr=req.do_ocr, ocr_config=req.ocr_config)
        return _json(result)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        return JSONResponse(status_code=200, content={
            "ok": False, "error": f"{type(exc).__name__}: {exc}"})


@app.post("/scan/crop")
def scan_crop(req: CropRequest) -> JSONResponse:
    """按 mm rect 从矫正页图裁剪 ROI（复核界面用），返回 PNG base64。"""
    try:
        import base64
        from . import ocr as ocr_mod
        if not os.path.exists(req.path):
            return JSONResponse(status_code=200, content={"ok": False, "error": "文件不存在"})
        img = cv2.imread(req.path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return JSONResponse(status_code=200, content={"ok": False, "error": "图片读取失败"})
        scale = img.shape[1] / 210.0
        crop = ocr_mod.crop_box(img, scale, req.rect, req.pad_mm)
        if crop is None:
            return JSONResponse(status_code=200, content={"ok": False, "error": "裁剪区域无效"})
        ok, buf = cv2.imencode(".png", crop)
        if not ok:
            return JSONResponse(status_code=200, content={"ok": False, "error": "PNG 编码失败"})
        return JSONResponse(content={"ok": True,
                                     "png_b64": base64.b64encode(buf.tobytes()).decode()})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=200, content={"ok": False,
                                                      "error": f"{type(exc).__name__}: {exc}"})


@app.post("/render")
def render_project(req: RenderRequest) -> JSONResponse:
    try:
        amf = req.amf
        os.makedirs(req.out_dir, exist_ok=True)
        mode = amf["paper"]["mode"]

        # 字体与富文本字体族（<b>/<i> 映射）
        render.ensure_fonts()
        richtext.register_family()

        # 试卷 + 答案（所有模式都有）
        paper_pages = layout.layout_paper(amf, string_width=render.string_width_mm)
        key_pages = layout.layout_answer_key(amf, string_width=render.string_width_mm)
        pdfs: dict[str, str] = {}
        paper_path = os.path.join(req.out_dir, "paper.pdf")
        key_path = os.path.join(req.out_dir, "answer_key.pdf")
        render.render_pages(paper_pages, paper_path)
        render.render_pages(key_pages, key_path)
        pdfs["paper"] = paper_path
        pdfs["answer_key"] = key_path

        # 答题卡（仅模式 A）
        sheet_pages: list[layout.Page] = []
        if mode == "answer_sheet":
            sheet_pages = layout.layout_answer_sheet(amf)
            sheet_path = os.path.join(req.out_dir, "answer_sheet.pdf")
            render.render_pages(sheet_pages, sheet_path)
            pdfs["answer_sheet"] = sheet_path

        # positions：模式 A 取自答题卡页，模式 B 取自试卷页
        pos_role = "answer_sheet" if mode == "answer_sheet" else "paper"
        src_pages = sheet_pages if mode == "answer_sheet" else paper_pages
        positions = layout.build_positions(src_pages, pos_role)

        return JSONResponse({
            "ok": True,
            "pdfs": pdfs,
            "positions": positions,
            "pages": {
                "paper": len(paper_pages),
                "answer_sheet": len(sheet_pages),
                "answer_key": len(key_pages),
            },
        })
    except Exception as exc:  # noqa: BLE001 - 返回可读错误给主后端
        traceback.print_exc()
        return JSONResponse(status_code=200, content={
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "pdfs": {},
            "positions": {"pages": []},
            "pages": {"paper": 0, "answer_sheet": 0, "answer_key": 0},
        })
