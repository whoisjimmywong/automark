"""
富文本（HTML 子集）→ ReportLab Paragraph 转换层。

AMF 中 prompt/options 承载的 HTML 子集：
  <b>/<strong>  <i>/<em>  <u>  <br>  <p>/<div>  <ul>/<ol>/<li>  <img src="data:...">
未知标签一律剥除（保留文本），文本节点转义，保证任何输入都不致崩溃。
图片：data URI 解码落临时缓存目录，按显示宽度（默认 96dpi 换算，上限为栏宽）等比缩放。
"""
from __future__ import annotations

import base64
import hashlib
import html
import os
import re
import tempfile
from html.parser import HTMLParser

from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import Paragraph

_IMG_CACHE = os.path.join(tempfile.gettempdir(), "automark_imgcache")
_IMG_RE = re.compile(r"^data:image/(png|jpeg|jpg|gif|webp);base64,(.+)$", re.S)

# ReportLab Paragraph 支持的行内标签
_INLINE = {"b", "i", "u"}


def _ensure_cache() -> str:
    os.makedirs(_IMG_CACHE, exist_ok=True)
    return _IMG_CACHE


def _decode_image(data_uri: str) -> tuple[str, int, int] | None:
    """data URI → (缓存文件路径, 宽px, 高px)；失败返回 None。"""
    m = _IMG_RE.match(data_uri.strip())
    if not m:
        return None
    ext, b64 = m.group(1).replace("jpg", "jpeg"), m.group(2)
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return None
    digest = hashlib.sha1(raw).hexdigest()[:16]
    path = os.path.join(_ensure_cache(), f"{digest}.{ext}")
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(raw)
    try:
        from PIL import Image
        with Image.open(path) as im:
            return path, im.width, im.height
    except Exception:
        return None


class _Sanitizer(HTMLParser):
    """白名单净化 + 列表展开为文本前缀。"""

    def __init__(self, avail_w_mm: float):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.list_stack: list[tuple[str, int]] = []  # ('ul'|'ol', 序号)
        self.avail_w_mm = avail_w_mm
        self.pending_break = False  # p/div/li 前需要换行

    # -- 工具 --
    def _break(self):
        if self.out and not self.out[-1].endswith("<br/>"):
            self.out.append("<br/>")

    # -- 标签 --
    def handle_starttag(self, tag: str, attrs):
        a = dict(attrs)
        if tag in ("b", "strong"):
            self.out.append("<b>")
        elif tag in ("i", "em"):
            self.out.append("<i>")
        elif tag == "u":
            self.out.append("<u>")
        elif tag == "br":
            self.out.append("<br/>")
        elif tag in ("p", "div"):
            self._break()
        elif tag in ("ul", "ol"):
            self._break()
            self.list_stack.append((tag, 0))
        elif tag == "li":
            self._break()
            if self.list_stack:
                kind, n = self.list_stack[-1]
                n += 1
                self.list_stack[-1] = (kind, n)
                self.out.append("• " if kind == "ul" else f"{n}. ")
            else:
                self.out.append("• ")
        elif tag == "img":
            src = a.get("src", "")
            info = _decode_image(src) if src.startswith("data:") else None
            if info:
                path, w_px, h_px = info
                # 显示宽度：attr width（px，96dpi）→ mm；缺省自然宽度；上限栏宽
                try:
                    w_mm = float(a.get("width", w_px)) * 25.4 / 96
                except (TypeError, ValueError):
                    w_mm = w_px * 25.4 / 96
                w_mm = min(w_mm, self.avail_w_mm)
                h_mm = w_mm * h_px / max(w_px, 1)
                self.out.append(
                    f'<img src="{path}" width="{w_mm * mm:.0f}" height="{h_mm * mm:.0f}" valign="-2" />'
                )
            else:
                self.out.append("[图片]")
        # 其余标签：剥除

    def handle_endtag(self, tag: str):
        if tag in ("b", "strong"):
            self.out.append("</b>")
        elif tag in ("i", "em"):
            self.out.append("</i>")
        elif tag == "u":
            self.out.append("</u>")
        elif tag in ("p", "div", "li"):
            self._break()
        elif tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
            self._break()

    def handle_data(self, data: str):
        self.out.append(html.escape(data, quote=False))

    def result(self) -> str:
        text = "".join(self.out)
        text = re.sub(r"(<br/>){3,}", "<br/><br/>", text)
        # 只去首尾的完整 <br/>（strip() 会按字符集误吃标签）
        text = re.sub(r"^(<br/>)+", "", text)
        text = re.sub(r"(<br/>)+$", "", text)
        return text


def sanitize(html_text: str, avail_w_mm: float) -> str:
    """HTML 子集 → ReportLab Paragraph 兼容标记。纯文本输入也安全（会被转义）。"""
    if not html_text:
        return ""
    s = _Sanitizer(avail_w_mm)
    try:
        s.feed(html_text)
        s.close()
        return s.result()
    except Exception:
        return html.escape(html_text, quote=False)


_style_cache: dict[float, ParagraphStyle] = {}


def _style(size: float) -> ParagraphStyle:
    if size not in _style_cache:
        _style_cache[size] = ParagraphStyle(
            name=f"AMF{size}",
            fontName="AMF",
            fontSize=size,
            leading=size * 1.45,
            wordWrap="CJK",
        )
    return _style_cache[size]


def register_family() -> None:
    """让 Paragraph 的 <b>/<i> 映射到已注册字体（在 render.ensure_fonts 后调用）。"""
    from . import render
    pdfmetrics.registerFontFamily(
        render.FONT_REG,
        normal=render.FONT_REG,
        bold=render.FONT_BOLD,
        italic=render.FONT_REG,   # 中文字体无斜体字面，M1 降级为常规
        boldItalic=render.FONT_BOLD,
    )


_IMG_TAG_RE = re.compile(r'<img src="([^"]+)" width="(\d+)" height="(\d+)" valign="-2" />')


def _text_flow(chunk: str, size: float) -> Paragraph | None:
    """非图片片段 → Paragraph；空片段返回 None。"""
    stripped = re.sub(r"^(<br/>)+", "", chunk)
    stripped = re.sub(r"(<br/>)+$", "", stripped)
    if not stripped:
        return None
    return Paragraph(stripped, _style(size))


def to_flowables(html_text: str, size: float, avail_w_mm: float):
    """HTML 子集 → flowable 列表（图片独立成行，行高自适应）。"""
    from reportlab.platypus import Image

    markup = sanitize(html_text, avail_w_mm)
    flows: list = []
    pos = 0
    for m in _IMG_TAG_RE.finditer(markup):
        if m.start() > pos:
            f = _text_flow(markup[pos:m.start()], size)
            if f is not None:
                flows.append(f)
        flows.append(Image(m.group(1), width=int(m.group(2)), height=int(m.group(3))))
        pos = m.end()
    if pos < len(markup):
        f = _text_flow(markup[pos:], size)
        if f is not None:
            flows.append(f)
    return flows or [Paragraph(" ", _style(size))]


def measure(html_text: str, size: float, avail_w_mm: float) -> float:
    """渲染总高度（mm）：各 flowable 高度之和。"""
    total_pt = 0.0
    for f in to_flowables(html_text, size, avail_w_mm):
        _, h = f.wrap(avail_w_mm * mm, 10000 * mm)
        total_pt += h
    return total_pt / mm
