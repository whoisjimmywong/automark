"""
布局引擎：把 AMF 排版为逐页元素清单（top-left mm 坐标系），并生成 positions。

坐标约定：原点 = 页面左上角，单位 mm。渲染层负责换算到 PDF（左下角原点 pt）。

bubble 块 rect 语义（批改侧据此重建每个气泡圆心）：
  - rect 恰好包住该题全部选项气泡（含 1~1.5mm 余量），气泡在 rect 内水平等距；
  - cy = (y1+y2)/2；cx_i 在 [x1+pad, x2-pad] 内等距分布（pad ≈ d/2 + 1）。
ocr 块 rect = 作答边框本身。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import richtext
from .qrpayload import encode as qr_encode

# ---------------------------------------------------------------- 常量(mm) --
PAGE_W, PAGE_H = 210.0, 297.0
MARGIN_X = 15.0
CONTENT_X1, CONTENT_X2 = MARGIN_X, PAGE_W - MARGIN_X  # 15..195
CONTENT_W = CONTENT_X2 - CONTENT_X1                    # 180

CORNER_OFFSET = 10.0   # L 标顶点距页边
CORNER_ARM = 12.0      # L 标臂长
CORNER_W = 2.0         # L 标线宽

QR_SIZE = 15.0
QR_RECT = ((PAGE_W - QR_SIZE) / 2, 8.0)  # x=97.5, y=8（优化包：20→15mm，给题目区让位）

SHEET_TITLE_Y = 33.0
NAME_LINE_Y = 44.0

# 缺考/异常标记（首页，Name/Date 行右侧）
ABSENT_LABEL = "ABSENT/WITHDRAWN"
ABSENT_X = 152.0      # 标签起点 x（Date 栏缩至 150）
ABSENT_CX = 188.0     # 填涂圈圆心 x
ABSENT_CY = 46.5      # 填涂圈圆心 y（与 Name/Date 行对齐）
DATE_LINE_X2 = 150.0  # Date 下划线右端（原 165，让位给 ABSENT）

ID_DIGIT_BOX_Y = 52.0       # 手写数字框 top
ID_DIGIT_BOX_H = 5.0
ID_COL_PITCH = 13.0
ID_ROW_PITCH = 6.0          # 10 行气泡垂直间距（layout 常量，写入 metadata）
ID_FIRST_CY = 61.0
ID_ROWS = 10

OBJ_START_Y = 120.0         # 答题卡首页内容起始 y（学号区下方）
CONT_START_Y = 56.0         # 答题卡续页内容起始 y（续页无学号涂卡区）
ROW_H = 8.0                 # 客观题行高
COL_X = (18.0, 106.0)       # 双栏 x
NUM_W = 10.0                # 题号区宽
BUBBLE_DX = 13.0            # 行内首个气泡圆心相对栏 x 的偏移
FILL_GAP = 3.0
BOX_X1 = 28.0
BOX_W_RATIO = 0.85
FILL_COL_X = (28.0, 106.0)  # 填空双列框组左缘
FILL_COL_W = 73.0           # 填空单列框组宽
FILL_COL_MAX_BLANKS = 3     # 可入列的最大空格数（>3 空占整行）
BOX_PAD_V = 3.0             # 作答框内上下留白
LINE_H = 8.0                # 作答框每行高
PAGE_BOTTOM = 276.0         # 内容下限（页脚上方）

PAPER_TOP_Y = 36.0          # 试卷续页内容起点（避开页首 QR 区 y 8..28）
FOOTER_Y = 283.0            # 页脚基线（避开底部 L 标 y≥285 的横臂）

FONT = "AMF"


@dataclass
class Page:
    role: str                       # 'paper' | 'answer_sheet' | 'answer_key'
    number: int
    elements: list[dict] = field(default_factory=list)
    blocks: list[dict] = field(default_factory=list)
    student_id_rect: list[float] | None = None
    absent_rect: list[float] | None = None


def _text(x, y, s, size=10.5, bold=False, align="l", color=(0, 0, 0)):
    return {"k": "text", "x": x, "y": y, "s": s, "size": size,
            "bold": bold, "align": align, "color": color}


def _line(x1, y1, x2, y2, w=0.4):
    return {"k": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2, "w": w}


def _rect(x1, y1, x2, y2, w=0.5):
    return {"k": "rect", "rect": [x1, y1, x2, y2], "w": w}


def _bubble(cx, cy, d, label=None):
    return {"k": "bubble", "cx": cx, "cy": cy, "d": d, "label": label}


def _markers(page: Page, exam_id: str, cfg: dict, total_pages_hint: int = 99):
    markers_cfg = (cfg or {}).get("markers", {})
    if markers_cfg.get("corners", True):
        for corner, (vx, vy) in {
            "tl": (CORNER_OFFSET, CORNER_OFFSET),
            "tr": (PAGE_W - CORNER_OFFSET, CORNER_OFFSET),
            "bl": (CORNER_OFFSET, PAGE_H - CORNER_OFFSET),
            "br": (PAGE_W - CORNER_OFFSET, PAGE_H - CORNER_OFFSET),
        }.items():
            page.elements.append({"k": "lmarker", "x": vx, "y": vy, "corner": corner})
    if markers_cfg.get("qr", True):
        x, y = QR_RECT
        page.elements.append({
            "k": "qr", "rect": [x, y, x + QR_SIZE, y + QR_SIZE],
            "payload": qr_encode(exam_id, page.number),
        })


def _footer(page: Page, total: int, template: dict, note: str | None):
    text = (template.get("footer") or "Page {page} of {pages}")
    text = text.replace("{page}", str(page.number)).replace("{pages}", str(total))
    page.elements.append(_text(CONTENT_X2, FOOTER_Y, text, size=8.5, align="r"))
    if note:
        page.elements.append(_text(CONTENT_X1, FOOTER_Y, note, size=8.5))


def _markers_positions(page: Page) -> dict:
    x, y = QR_RECT
    return {
        "corners": [
            [CORNER_OFFSET, CORNER_OFFSET],
            [PAGE_W - CORNER_OFFSET, CORNER_OFFSET],
            [CORNER_OFFSET, PAGE_H - CORNER_OFFSET],
            [PAGE_W - CORNER_OFFSET, PAGE_H - CORNER_OFFSET],
        ],
        "qr": [x, y, x + QR_SIZE, y + QR_SIZE],
    }


# ------------------------------------------------------------- 学号涂卡区 ----
def _student_id_grid(page: Page, digits: int, bubble_d: float):
    """绘制学号涂卡区（整页宽居中，随位数自适应）并返回气泡网格外接矩形。"""
    grid_w = digits * ID_COL_PITCH
    x0 = (PAGE_W - grid_w) / 2
    centers_x = [x0 + ID_COL_PITCH * i + ID_COL_PITCH / 2 for i in range(digits)]
    first_cy = ID_FIRST_CY
    last_cy = first_cy + ID_ROW_PITCH * (ID_ROWS - 1)

    page.elements.append(_text(x0 - 4, ID_DIGIT_BOX_Y + 4, "ID", size=8, align="r"))
    # 手写数字框
    for cx in centers_x:
        bw = 7.0
        page.elements.append(_rect(cx - bw / 2, ID_DIGIT_BOX_Y, cx + bw / 2,
                                   ID_DIGIT_BOX_Y + ID_DIGIT_BOX_H, w=0.4))
    # 行号 0-9 + 气泡
    for r in range(ID_ROWS):
        cy = first_cy + ID_ROW_PITCH * r
        page.elements.append(_text(x0 - 4, cy + 1.5, str(r), size=7.5, align="r"))
        for cx in centers_x:
            page.elements.append(_bubble(cx, cy, bubble_d))

    pad = bubble_d / 2 + 1.0
    rect = [centers_x[0] - pad, first_cy - pad,
            centers_x[-1] + pad, last_cy + pad]
    page.student_id_rect = [round(v, 2) for v in rect]


def _sheet_header(page: Page, amf: dict, cfg: dict, first: bool):
    bubble_d = cfg.get("bubble_size_mm", 3.0)
    digits = (cfg.get("student_id") or {}).get("digits", 6)
    template = amf["paper"]["template"]

    _markers(page, amf["exam"]["id"], cfg)
    page.elements.append(_text(PAGE_W / 2, SHEET_TITLE_Y, template.get("title", amf["exam"]["title"]),
                               size=13, bold=True, align="c"))
    page.elements.append(_text(PAGE_W / 2, SHEET_TITLE_Y + 6, "ANSWER SHEET",
                               size=9, align="c"))
    # 姓名/日期栏（同一行，首页需避开下方的学号涂卡区 y≥52）
    page.elements.append(_text(20.0, NAME_LINE_Y, "Name:", size=10))
    page.elements.append(_line(42.0, NAME_LINE_Y + 1.5, 85.0, NAME_LINE_Y + 1.5, w=0.4))
    page.elements.append(_text(100.0, NAME_LINE_Y, "Date:", size=10))
    page.elements.append(_line(122.0, NAME_LINE_Y + 1.5, DATE_LINE_X2, NAME_LINE_Y + 1.5, w=0.4))
    # 缺考/异常标记（首页）：ABSENT/WITHDRAWN + 填涂圈
    if first and cfg.get("absent_mark", True):
        page.elements.append(_text(ABSENT_X, NAME_LINE_Y + 1.0, ABSENT_LABEL, size=7.5))
        page.elements.append(_bubble(ABSENT_CX, ABSENT_CY, bubble_d))
        d = bubble_d
        page.absent_rect = [round(ABSENT_CX - d / 2 - 1.0, 2), round(ABSENT_CY - d / 2 - 1.0, 2),
                            round(ABSENT_CX + d / 2 + 1.0, 2), round(ABSENT_CY + d / 2 + 1.0, 2)]
    # 学号涂卡区仅首页
    if first:
        _student_id_grid(page, digits, bubble_d)


# --------------------------------------------------------------- 答题卡 ------
def layout_answer_sheet(amf: dict) -> list[Page]:
    """
    答题卡排版：题目顺序与试卷一致，按题号 1→N 流式排布。
    双列采用**列主序**（先排满左列、再排右列）——避免左右横跳；
    例如 5 道题：左列 1,2,3 / 右列 4,5，即第一行 1,4、第二行 2,5、第三行靠左 3。
    分区标题与其后首个答题区保证同页（标题不孤行跨页）。
    """
    cfg = amf.get("answer_sheet_config") or {}
    bubble_d = cfg.get("bubble_size_mm", 3.0)
    pitch = cfg.get("bubble_pitch_mm", 8.0)
    template = amf["paper"]["template"]
    GAP = 1.5  # 行间距

    pages: list[Page] = []

    def new_page() -> Page:
        p = Page(role="answer_sheet", number=len(pages) + 1)
        _sheet_header(p, amf, cfg, first=(p.number == 1))
        pages.append(p)
        return p

    page = new_page()
    y = OBJ_START_Y if page.number == 1 else CONT_START_Y

    def reset_y():
        nonlocal y
        y = CONT_START_Y if page.number > 1 else OBJ_START_Y

    def unit_h(q: dict) -> float:
        if q["answer"]["kind"] != "text":
            return ROW_H
        n = max(len(blanks_of(q["answer"])), 1)
        lines = (q.get("layout") or {}).get("lines", 1)
        return lines * LINE_H + BOX_PAD_V * 2 + (4.0 if n > 1 else 0.0)

    def fits_col(q: dict) -> bool:
        if q["answer"]["kind"] != "text":
            return True
        return max(len(blanks_of(q["answer"])), 1) <= FILL_COL_MAX_BLANKS

    def emit_cell(q: dict, x0: float, ry: float, col_w: float):
        """渲染一个单元：客观题=气泡行；填空=作答框组（label_inside）。"""
        if q["answer"]["kind"] != "text":
            n_opts = len(q["options"]) if q["answer"]["kind"] != "tf" else 2
            labels = (cfg.get("tf_labels") or ["T", "F"]) if q["answer"]["kind"] == "tf" else None
            page.elements.append(_text(x0 + NUM_W - 1, ry + 6.6, f'{q["number"]}.',
                                       size=9, align="r"))
            first_cx = x0 + BUBBLE_DX
            cxs = [first_cx + pitch * i for i in range(n_opts)]
            cy = ry + 5.6
            for i, cx in enumerate(cxs):
                lab = labels[i] if labels else chr(65 + i)
                page.elements.append(_text(cx, ry + 2.2, lab, size=6.5, align="c"))
                page.elements.append(_bubble(cx, cy, bubble_d))
            pad = bubble_d / 2 + 1.0
            page.blocks.append({
                "qid": q["id"], "kind": "bubble",
                "rect": [round(cxs[0] - pad, 2), round(cy - pad, 2),
                         round(cxs[-1] + pad, 2), round(cy + pad, 2)],
                "options": n_opts,
            })
        else:
            _fill_box_row(page, q, ry, x0, col_w, -2.0, label_inside=True)

    def emit_title(title: str, next_h: float):
        """渲染分区标题；确保标题与其后首个答题区同页（不孤行跨页）。"""
        nonlocal page, y
        if y + ROW_H + GAP + next_h > PAGE_BOTTOM:
            page = new_page()
            reset_y()
        page.elements.append(_text(CONTENT_X1 + 3, y + 5.5, title, size=9, bold=True))
        y += ROW_H + GAP

    def flush_col_block(units: list[dict]):
        """列主序渲染一批可双列单元：左列 = 前 ceil(n/2) 个，右列 = 剩余。"""
        nonlocal page, y
        if not units:
            return
        n = len(units)
        left = units[: (n + 1) // 2]
        right = units[(n + 1) // 2:]
        for i in range(len(left)):
            l = left[i]
            r = right[i] if i < len(right) else None
            h = max(unit_h(l), unit_h(r) if r else 0.0)
            if y + h > PAGE_BOTTOM:
                page = new_page()
                reset_y()
            emit_cell(l, FILL_COL_X[0] if l["answer"]["kind"] == "text" else COL_X[0],
                      y, FILL_COL_W)
            if r is not None:
                emit_cell(r, FILL_COL_X[1] if r["answer"]["kind"] == "text" else COL_X[1],
                          y, FILL_COL_W)
            y += h + GAP

    def emit_full_row(q: dict):
        """整行单元（多空填空 >FILL_COL_MAX_BLANKS 空）。"""
        nonlocal page, y
        h = unit_h(q)
        if y + h > PAGE_BOTTOM:
            page = new_page()
            reset_y()
        emit_cell(q, BOX_X1, y, CONTENT_W * BOX_W_RATIO)
        y += h + GAP

    # 按试卷题目顺序流式排布（列主序双列）
    block_units: list[dict] = []
    for sec in amf["paper"]["sections"]:
        if sec.get("title"):
            flush_col_block(block_units)
            block_units = []
            part = sec.get("part_title")
            title = f"{part} · {sec['title']}" if part else sec["title"]
            # 预判首个答题区高度，保证标题与答题区同页
            first_h = unit_h(sec["questions"][0]) if sec["questions"] else ROW_H
            emit_title(title, first_h)
        for q in sec["questions"]:
            if fits_col(q):
                block_units.append(q)
            else:
                flush_col_block(block_units)
                block_units = []
                emit_full_row(q)
    flush_col_block(block_units)

    total = len(pages)
    note = cfg.get("footer_note")
    for p in pages:
        _footer(p, total, template, note)
    return pages


# ----------------------------------------------------------------- 试卷 ------
def _wrap(text: str, size: float, width_mm: float, string_width) -> list[str]:
    """按渲染宽度贪心折行（词优先，长词按字符断）。"""
    if not text:
        return [""]
    lines: list[str] = []
    cur = ""
    for token in text.split(" "):
        trial = token if not cur else cur + " " + token
        if string_width(trial, size) <= width_mm:
            cur = trial
            continue
        if cur:
            lines.append(cur)
            cur = ""
        # 单词本身超宽 → 按字符断
        while string_width(token, size) > width_mm and len(token) > 1:
            cut = len(token)
            while cut > 1 and string_width(token[:cut], size) > width_mm:
                cut -= 1
            lines.append(token[:cut])
            token = token[cut:]
        cur = token
    lines.append(cur)
    return lines


def blanks_of(answer: dict) -> list[dict]:
    """归一化取空格列表（兼容旧版 match 单空格式）。"""
    if answer.get("blanks"):
        return answer["blanks"]
    if answer.get("match"):
        return [{"match": answer["match"]}]
    return []


def _match_text(m: dict) -> str:
    if m["type"] == "exact":
        return m["value"]
    if m["type"] == "any_of":
        return " / ".join(m["values"])
    if m["type"] == "regex":
        return f"regex: {m['pattern']}"
    return f"{m['value']} ±{m['tolerance']}"


def _answer_text(q: dict, cfg: dict) -> str:
    a = q["answer"]
    if a["kind"] == "single":
        return chr(65 + a["correct"])
    if a["kind"] == "multiple":
        return "".join(chr(65 + i) for i in sorted(a["correct"]))
    if a["kind"] == "tf":
        labels = cfg.get("tf_labels") or ["T", "F"]
        return labels[a["correct"]]
    return "; ".join(_match_text(b["match"]) for b in blanks_of(a))


def _fill_box_row(page: Page, q: dict, y: float, x1: float, total_w: float,
                  label_dx: float, label_inside: bool = False) -> float:
    """
    在页面上绘制一道填空题的作答框组（1~5 空，横排），并登记 ocr blocks。
    x1/total_w：框组左缘与总宽；label_dx：题号标签相对 x1 的偏移（负值）。
    label_inside=True 时在 total_w 内预留 8mm 题号条（双列模式下避免
    右列题号触碰左列框）。返回占用总高（mm）。多空时每空上方加 4mm 序号标注条。
    """
    blanks = blanks_of(q["answer"])
    n = max(len(blanks), 1)
    lines = (q.get("layout") or {}).get("lines", 1)
    box_h = lines * LINE_H + BOX_PAD_V * 2
    label_strip = 4.0 if n > 1 else 0.0

    if label_inside:
        page.elements.append(_text(x1 + 7.0, y + 6.5, f'{q["number"]}.', size=9, align="r"))
        x1 += 8.0
        total_w -= 8.0
    else:
        page.elements.append(_text(x1 + label_dx, y + 6.5, f'{q["number"]}.', size=9, align="r"))
    gap = 4.0
    bw = (total_w - gap * (n - 1)) / n
    by = y + label_strip
    for i in range(n):
        bx = x1 + i * (bw + gap)
        if n > 1:
            page.elements.append(_text(bx, y + 3.0, f"({i + 1})", size=6.5))
        page.elements.append(_rect(bx, by, bx + bw, by + box_h, w=0.6))
        for li in range(1, lines):
            ly = by + BOX_PAD_V + LINE_H * li
            page.elements.append(_line(bx + 1.5, ly, bx + bw - 1.5, ly, w=0.2))
        page.blocks.append({
            "qid": q["id"], "kind": "ocr", "blank": i,
            "rect": [round(bx, 2), round(by, 2), round(bx + bw, 2), round(by + box_h, 2)],
            "lines": lines,
        })
    return label_strip + box_h


def layout_paper(amf: dict, string_width) -> list[Page]:
    """试卷 PDF 排版（题干/选项为富文本段落，题块不跨页）。"""
    cfg = amf.get("answer_sheet_config") or {}
    template = amf["paper"]["template"]
    on_paper = amf["paper"]["mode"] == "on_paper"
    bubble_d = cfg.get("bubble_size_mm", 4.0)
    pitch = cfg.get("bubble_pitch_mm", 8.0)
    role = "paper"

    pages: list[Page] = []

    def new_page(first: bool) -> Page:
        p = Page(role=role, number=len(pages) + 1)
        _markers(p, amf["exam"]["id"], cfg)
        pages.append(p)
        if first:
            y = 36.0  # QR 占据 y 8..28，标题让位
            p.elements.append(_text(PAGE_W / 2, y, template.get("title", amf["exam"]["title"]),
                                    size=16, bold=True, align="c"))
            y += 8
            if template.get("subtitle"):
                p.elements.append(_text(PAGE_W / 2, y, template["subtitle"], size=10.5, align="c"))
                y += 7
            exam = amf["exam"]
            info = "   ·   ".join(x for x in [exam.get("subject"), exam.get("grade"),
                                              f'{exam["duration_min"]} min' if exam.get("duration_min") else None] if x)
            if info:
                p.elements.append(_text(PAGE_W / 2, y, info, size=9.5, align="c"))
                y += 7
            header_cfg = template.get("header") or {}
            if header_cfg.get("show_name", True):
                p.elements.append(_text(CONTENT_X1, y, "Name: ____________________", size=10))
                p.elements.append(_text(CONTENT_X2, y, "Class: ____________", size=10, align="r"))
                y += 7
            if template.get("instructions"):
                for ln in _wrap(template["instructions"], 9.5, CONTENT_W, string_width):
                    p.elements.append(_text(CONTENT_X1, y, ln, size=9.5))
                    y += 5.0
                y += 2
            p.elements.append(_line(CONTENT_X1, y, CONTENT_X2, y, w=0.7))
            y += 6
            return_y = y
        else:
            return_y = PAPER_TOP_Y
        p.elements.append({"k": "_y", "y": return_y})  # 游标（渲染层忽略）
        return p

    def cursor(p: Page) -> float:
        return p.elements[-1]["y"] if p.elements and p.elements[-1]["k"] == "_y" else PAPER_TOP_Y

    def set_cursor(p: Page, y: float):
        p.elements.append({"k": "_y", "y": y})

    page = new_page(first=True)
    y = cursor(page)

    last_part = None
    for sec_idx, sec in enumerate(amf["paper"]["sections"]):
        # 分区前：手动分页/空行
        if sec.get("page_break_before"):
            page = new_page(first=False)
            y = cursor(page)
        gap = sec.get("gap_before_mm") or 0.0
        if gap > 0:
            y += gap
        # 分区标题
        sec_head_h = 0.0
        head_lines: list[tuple[str, float, bool]] = []
        part_title = sec.get("part_title")
        if part_title and part_title != last_part:
            head_lines.append((part_title, 13.0, True))
            sec_head_h += 8.5
        if sec.get("title"):
            head_lines.append((sec["title"], 11.0, True))
            sec_head_h += 7.0
        if sec.get("instructions"):
            for ln in _wrap(sec["instructions"], 9.0, CONTENT_W, string_width):
                head_lines.append((ln, 9.0, False))
                sec_head_h += 5.0
            sec_head_h += 1.5
        if y + sec_head_h > PAGE_BOTTOM:
            page = new_page(first=False)
            y = cursor(page)
        for text, size, bold in head_lines:
            page.elements.append(_text(CONTENT_X1, y + (6.5 if bold else 4.5), text,
                                       size=size, bold=bold))
            y += 7.5 if bold else 5.0
        if part_title:
            last_part = part_title
        y += 1.5

        # 阅读材料/完形篇章（section.passage，富文本按段落流式渲染，可跨页）
        passage = sec.get("passage") or {}
        if passage.get("html"):
            import re as _re
            if passage.get("title"):
                pass_para = f'<b>{passage["title"]}</b>'
                ph = richtext.measure(pass_para, 11, CONTENT_W)
                if y + ph > PAGE_BOTTOM:
                    page = new_page(first=False)
                    y = cursor(page)
                page.elements.append({"k": "para", "x": CONTENT_X1, "y": y,
                                      "w": CONTENT_W, "html": pass_para, "size": 11})
                y += ph + 1.0
            # 按段落拆分（双换行 / <br><br>），逐段放置，允许在段落之间分页
            paras = _re.split(r"\n\s*\n|<br\s*/?>\s*<br\s*/?>", passage["html"])
            for para in paras:
                para = para.strip()
                if not para:
                    continue
                ph = richtext.measure(para, 10.5, CONTENT_W)
                if y + ph > PAGE_BOTTOM:
                    page = new_page(first=False)
                    y = cursor(page)
                page.elements.append({"k": "para", "x": CONTENT_X1, "y": y,
                                      "w": CONTENT_W, "html": para, "size": 10.5})
                y += ph + 1.0
            # 段落下方分隔线
            page.elements.append(_line(CONTENT_X1, y + 1.0, CONTENT_X2, y + 1.0, w=0.4))
            y += 3.0

        for q in sec["questions"]:
            # 隐藏题干：试卷上不显示该题（答题卡/答案卷/批改照常）
            if q.get("hidden"):
                continue
            # 题目前：手动分页/空行
            if q.get("page_break_before"):
                page = new_page(first=False)
                y = cursor(page)
            qgap = q.get("gap_before_mm") or 0.0
            if qgap > 0:
                y += qgap

            # ---- 预算题块高度（题块不跨页；富文本按段落实测高度） ----
            block: list[dict] = []
            bh = 0.0
            # prompt 为空（完形填空只保留选项）时仅显示题号
            prompt_html = (f'{q["number"]}. {q["prompt"]}' if str(q.get("prompt", "")).strip()
                           else f'{q["number"]}.')
            ph = richtext.measure(prompt_html, 10.5, CONTENT_W)
            block.append({"k": "para", "x": CONTENT_X1, "y": 0.0, "w": CONTENT_W,
                          "html": prompt_html, "size": 10.5})
            bh += ph + 1.0

            if q["answer"]["kind"] in ("single", "multiple", "tf"):
                labels = (cfg.get("tf_labels") or ["T", "F"]) if q["answer"]["kind"] == "tf" else None
                n_opts = 2 if q["answer"]["kind"] == "tf" else len(q["options"])
                opt_texts = [labels[i] if labels else f"{chr(65 + i)}. {q['options'][i]}"
                             for i in range(n_opts)]
                if on_paper:
                    # 模式 B：每选项一行文本 + 内联气泡行（保持原行为）
                    for t in opt_texts:
                        oh = richtext.measure(t, 10.5, CONTENT_W - 8)
                        block.append({"k": "para", "x": CONTENT_X1 + 8, "y": bh,
                                      "w": CONTENT_W - 8, "html": t, "size": 10.5})
                        bh += oh + 0.4
                    bh += 1.5
                    row_top = bh
                    first_cx = CONTENT_X1 + 8 + BUBBLE_DX
                    cxs = [first_cx + pitch * i for i in range(n_opts)]
                    cy = row_top + 5.6
                    for i, cx in enumerate(cxs):
                        lab = labels[i] if labels else chr(65 + i)
                        block.append(_text(cx, row_top + 2.2, lab, size=6.5, align="c"))
                        block.append(_bubble(cx, cy, bubble_d))
                    pad = bubble_d / 2 + 1.0
                    block_rect = [round(cxs[0] - pad, 2), None, round(cxs[-1] + pad, 2), None]
                    bh += 9.0
                    block.append({"k": "_block", "qid": q["id"], "kind": "bubble",
                                  "options": n_opts, "cy_offset": 5.6 + row_top,
                                  "rect_partial": block_rect})
                else:
                    # 模式 A：按 options_layout 排布选项文本（row 单排等分 / rows2 双排 /
                    # cols2 双列 / vertical 竖排，默认 vertical）
                    layout_kind = q.get("options_layout", "vertical")
                    opt_w = CONTENT_W - 8
                    if layout_kind == "row":
                        # 单排：按选项个数等分整行宽度（每选项一列，均分）
                        col_w = opt_w / n_opts
                        row_h = 0.0
                        for i, t in enumerate(opt_texts):
                            oh = richtext.measure(t, 10.5, col_w - 2)
                            block.append({"k": "para", "x": CONTENT_X1 + 8 + i * col_w, "y": bh,
                                          "w": col_w - 2, "html": t, "size": 10.5})
                            row_h = max(row_h, oh)
                        bh += row_h + 0.4
                    elif layout_kind == "rows2":
                        first = (n_opts + 1) // 2
                        for group in (opt_texts[:first], opt_texts[first:]):
                            if not group:
                                continue
                            row_html = "　　".join(group)
                            oh = richtext.measure(row_html, 10.5, opt_w)
                            block.append({"k": "para", "x": CONTENT_X1 + 8, "y": bh,
                                          "w": opt_w, "html": row_html, "size": 10.5})
                            bh += oh + 0.4
                    elif layout_kind == "cols2":
                        left = [opt_texts[i] for i in range(0, n_opts, 2)]
                        right = [opt_texts[i] for i in range(1, n_opts, 2)]
                        half_w = opt_w / 2 - 4
                        l_html = "<br/>".join(left)
                        l_h = richtext.measure(l_html, 10.5, half_w)
                        block.append({"k": "para", "x": CONTENT_X1 + 8, "y": bh,
                                      "w": half_w, "html": l_html, "size": 10.5})
                        r_h = 0.0
                        if right:
                            r_html = "<br/>".join(right)
                            r_h = richtext.measure(r_html, 10.5, half_w)
                            block.append({"k": "para", "x": CONTENT_X1 + 8 + half_w + 4,
                                          "y": bh, "w": half_w, "html": r_html, "size": 10.5})
                        bh += max(l_h, r_h) + 0.4
                    else:  # vertical 竖排
                        for t in opt_texts:
                            oh = richtext.measure(t, 10.5, opt_w)
                            block.append({"k": "para", "x": CONTENT_X1 + 8, "y": bh,
                                          "w": opt_w, "html": t, "size": 10.5})
                            bh += oh + 0.4
            else:
                if on_paper:
                    # 模式 B：填空作答框组（1~5 空横排，逐空登记 ocr block）
                    blanks = blanks_of(q["answer"])
                    nb = max(len(blanks), 1)
                    lines = (q.get("layout") or {}).get("lines", 1)
                    box_h = lines * LINE_H + BOX_PAD_V * 2
                    label_strip = 4.0 if nb > 1 else 0.0
                    bh += 1.5
                    total_w = CONTENT_W * BOX_W_RATIO
                    gap = 4.0
                    bw = (total_w - gap * (nb - 1)) / nb
                    for i in range(nb):
                        bx = CONTENT_X1 + 8 + i * (bw + gap)
                        by = bh + label_strip
                        if nb > 1:
                            block.append(_text(bx, bh + 3.0, f"({i + 1})", size=6.5))
                        block.append(_rect(bx, by, bx + bw, by + box_h, w=0.6))
                        for li in range(1, lines):
                            ly = by + BOX_PAD_V + LINE_H * li
                            block.append(_line(bx + 1.5, ly, bx + bw - 1.5, ly, w=0.2))
                        block.append({"k": "_block", "qid": q["id"], "kind": "ocr",
                                      "blank": i, "lines": lines,
                                      "rect_rel": [round(bx, 2), round(by, 2),
                                                   round(bx + bw, 2), round(by + box_h, 2)]})
                    bh += label_strip + box_h
            bh += 3.0  # 题间距

            # ---- 分页 ----
            if y + bh > PAGE_BOTTOM and y > PAPER_TOP_Y + 5:
                page = new_page(first=False)
                y = cursor(page)
            # ---- 落元素（按元素类型平移 y） ----
            for el in block:
                if el["k"] == "_block":
                    if el["kind"] == "bubble":
                        cy_abs = y + el["cy_offset"]
                        rp = el["rect_partial"]
                        page.blocks.append({
                            "qid": el["qid"], "kind": "bubble",
                            "rect": [rp[0], round(cy_abs - bubble_d / 2 - 1, 2),
                                     rp[2], round(cy_abs + bubble_d / 2 + 1, 2)],
                            "options": el["options"],
                        })
                    else:
                        rr = el["rect_rel"]
                        page.blocks.append({
                            "qid": el["qid"], "kind": "ocr", "blank": el.get("blank", 0),
                            "rect": [rr[0], round(rr[1] + y, 2), rr[2], round(rr[3] + y, 2)],
                            "lines": el["lines"],
                        })
                    continue
                el2 = dict(el)
                if el2["k"] == "bubble":
                    el2["cy"] = el["cy"] + y
                elif el2["k"] == "rect":
                    r = el["rect"]
                    el2["rect"] = [r[0], r[1] + y, r[2], r[3] + y]
                elif el2["k"] == "line":
                    el2["y1"] = el["y1"] + y
                    el2["y2"] = el["y2"] + y
                else:
                    el2["y"] = el["y"] + y
                page.elements.append(el2)
            y += bh

        set_cursor(page, y)

    total = len(pages)
    for p in pages:
        _footer(p, total, template, None)
        # 移除游标元素
        p.elements = [e for e in p.elements if e["k"] != "_y"]
    return pages


# --------------------------------------------------------------- 答案卷 ------
def layout_answer_key(amf: dict, string_width) -> list[Page]:
    """答案 PDF：仅答案紧凑表（不含原题、无定位标记，供教师查阅）。"""
    cfg = amf.get("answer_sheet_config") or {}
    template = amf["paper"]["template"]
    exam = amf["exam"]

    pages: list[Page] = []

    def new_page() -> tuple[Page, float]:
        p = Page(role="answer_key", number=len(pages) + 1)
        pages.append(p)
        if p.number == 1:
            y = 20.0
            p.elements.append(_text(PAGE_W / 2, y,
                                    f'{template.get("title", exam["title"])} — 答案 ANSWER KEY',
                                    size=14, bold=True, align="c"))
            y += 8
            n_q = sum(len(s["questions"]) for s in amf["paper"]["sections"])
            full = sum(q["score"] for s in amf["paper"]["sections"] for q in s["questions"])
            info = "   ·   ".join(x for x in [exam.get("subject"), exam.get("grade"),
                                              f"满分 {full:g}", f"共 {n_q} 题"] if x)
            p.elements.append(_text(PAGE_W / 2, y, info, size=9.5, align="c"))
            y += 5
            p.elements.append(_line(CONTENT_X1, y, CONTENT_X2, y, w=0.7))
            y += 6
            return p, y
        return p, 20.0

    page, y = new_page()
    for sec in amf["paper"]["sections"]:
        entries = [(q["number"], _answer_text(q, cfg)) for q in sec["questions"]]
        if not entries:
            continue
        # 分区标题
        if sec.get("title"):
            if y + 8 > PAGE_BOTTOM:
                page, y = new_page()
            part = sec.get("part_title")
            page.elements.append(_text(CONTENT_X1, y + 5.5,
                                       f"{part} · {sec['title']}" if part else sec["title"],
                                       size=11, bold=True))
            y += 8
        ncols = 2 if sec["type"] == "fill_blank" else 4
        col_w = CONTENT_W / ncols
        # 行优先排布，行高取该行最高条目
        for row_start in range(0, len(entries), ncols):
            row = entries[row_start:row_start + ncols]
            cell_lines = [_wrap(f"{num}. {ans}", 10, col_w - 6, string_width) for num, ans in row]
            row_h = max(len(ls) for ls in cell_lines) * 5.2 + 1.2
            if y + row_h > PAGE_BOTTOM:
                page, y = new_page()
            for ci, (num, ans) in enumerate(row):
                for li, ln in enumerate(cell_lines[ci]):
                    page.elements.append(_text(CONTENT_X1 + ci * col_w, y + 4.6 + li * 5.2,
                                               ln, size=10))
            y += row_h
        y += 3.0

    total = len(pages)
    for p in pages:
        _footer(p, total, template, None)
    return pages


# ----------------------------------------------------------------- 入口 ------
def build_positions(pages: list[Page], role: str) -> dict:
    out = []
    for p in pages:
        if p.role != role:
            continue
        entry = {
            "page": p.number,
            "role": role,
            "markers": _markers_positions(p),
            "blocks": p.blocks,
        }
        if p.student_id_rect:
            entry["student_id_rect"] = p.student_id_rect
        if p.absent_rect:
            entry["absent_rect"] = p.absent_rect
        out.append(entry)
    return {"pages": out}
