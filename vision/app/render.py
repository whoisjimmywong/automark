"""
ReportLab 渲染层：把 layout.Page 元素清单（top-left mm）绘制成 PDF（bottom-left pt）。
"""
from __future__ import annotations

import io
import os

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from . import richtext
from .layout import PAGE_H, PAGE_W, Page

FONT_REG = "AMF"
FONT_BOLD = "AMF-Bold"
_fonts_ready = False

# Windows 中文字体候选（含粗体）
_REG_CANDIDATES = [
    ("C:/Windows/Fonts/msyh.ttc", 0),
    ("C:/Windows/Fonts/simsun.ttc", 0),
    ("C:/Windows/Fonts/simhei.ttf", None),
]
_BOLD_CANDIDATES = [
    ("C:/Windows/Fonts/msyhbd.ttc", 0),
    ("C:/Windows/Fonts/simhei.ttf", None),
    ("C:/Windows/Fonts/simsun.ttc", 0),
]


def ensure_fonts() -> None:
    """注册内嵌 TTF（子集嵌入，换机不乱码）；失败回退 CID 字体。"""
    global _fonts_ready, FONT_REG, FONT_BOLD
    if _fonts_ready:
        return

    def _try(paths, name):
        for p, idx in paths:
            if os.path.exists(p):
                try:
                    if idx is not None and p.lower().endswith(".ttc"):
                        pdfmetrics.registerFont(TTFont(name, p, subfontIndex=idx))
                    else:
                        pdfmetrics.registerFont(TTFont(name, p))
                    return True
                except Exception:
                    continue
        return False

    if not _try(_REG_CANDIDATES, FONT_REG):
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        FONT_REG = "STSong-Light"
    if not _try(_BOLD_CANDIDATES, FONT_BOLD):
        FONT_BOLD = FONT_REG  # 无粗体时回退常规体
    _fonts_ready = True


def string_width_mm(text: str, size: float) -> float:
    """layout 折行用：文本在指定字号下的宽度（mm）。"""
    ensure_fonts()
    return pdfmetrics.stringWidth(text, FONT_REG, size) / mm


def _y(y_mm: float) -> float:
    """top-left mm → PDF bottom-left pt 的 y 换算。"""
    return (PAGE_H - y_mm) * mm


def _draw_lmarker(c: canvas.Canvas, x: float, y: float, corner: str) -> None:
    from .layout import CORNER_ARM, CORNER_W
    arm, w = CORNER_ARM, CORNER_W
    # top-left mm 坐标系下的两条臂
    if corner == "tl":
        rects = [(x, y, x + arm, y + w), (x, y, x + w, y + arm)]
    elif corner == "tr":
        rects = [(x - arm, y, x, y + w), (x - w, y, x, y + arm)]
    elif corner == "bl":
        rects = [(x, y - w, x + arm, y), (x, y - arm, x + w, y)]
    else:  # br
        rects = [(x - arm, y - w, x, y), (x - w, y - arm, x, y)]
    c.setFillGray(0)
    for x1, y1, x2, y2 in rects:
        c.rect(x1 * mm, _y(y2), (x2 - x1) * mm, (y2 - y1) * mm, stroke=0, fill=1)


def _draw_qr(c: canvas.Canvas, rect: list[float], payload: str) -> None:
    import qrcode
    from reportlab.lib.utils import ImageReader

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2, box_size=10)
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    x1, y1, x2, y2 = rect
    c.drawImage(ImageReader(buf), x1 * mm, _y(y2), (x2 - x1) * mm, (y2 - y1) * mm,
                mask="auto")


def render_pages(pages: list[Page], path: str) -> None:
    ensure_fonts()
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle("AutoMark")
    for page in pages:
        for el in page.elements:
            k = el["k"]
            if k == "text":
                r, g, b = el.get("color", (0, 0, 0))
                c.setFillColorRGB(r, g, b)
                font = FONT_BOLD if el.get("bold") else FONT_REG
                c.setFont(font, el["size"])
                x, y = el["x"] * mm, _y(el["y"])
                if el.get("align") == "c":
                    c.drawCentredString(x, y, el["s"])
                elif el.get("align") == "r":
                    c.drawRightString(x, y, el["s"])
                else:
                    c.drawString(x, y, el["s"])
                c.setFillGray(0)
            elif k == "line":
                c.setLineWidth(el["w"] * mm)
                c.line(el["x1"] * mm, _y(el["y1"]), el["x2"] * mm, _y(el["y2"]))
            elif k == "rect":
                x1, y1, x2, y2 = el["rect"]
                c.setLineWidth(el["w"] * mm)
                c.rect(x1 * mm, _y(y2), (x2 - x1) * mm, (y2 - y1) * mm, stroke=1, fill=0)
            elif k == "bubble":
                d = el["d"]
                c.setLineWidth(0.35 * mm)
                c.ellipse((el["cx"] - d / 2) * mm, _y(el["cy"] + d / 2),
                          (el["cx"] + d / 2) * mm, _y(el["cy"] - d / 2), stroke=1, fill=0)
            elif k == "lmarker":
                _draw_lmarker(c, el["x"], el["y"], el["corner"])
            elif k == "qr":
                _draw_qr(c, el["rect"], el["payload"])
            elif k == "para":
                # 富文本：flowable 序列自上而下堆叠（y 为顶部 mm，宽 w mm）
                y_cursor = el["y"]
                for f in richtext.to_flowables(el["html"], el["size"], el["w"]):
                    _, hpt = f.wrap(el["w"] * mm, 10000 * mm)
                    f.drawOn(c, el["x"] * mm, _y(y_cursor) - hpt)
                    y_cursor += hpt / mm
        c.showPage()
    c.save()
