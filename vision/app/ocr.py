"""
填空 OCR 转写管线（M3）。

流程：作答框 ROI（warped 图，mm rect）→ 裁剪 → 放大归一化 → RapidOCR
（rapidocr v2，onnxruntime 后端；懒加载单例）→ 逐行文本+置信度。
外部 OCR 引擎（OpenAI 兼容视觉接口）作为可选项，配置见 ocr_config.external。

注意：PIL 12.x 的 Image.fromarray 是拷贝语义——任何 PIL 绘制必须
`arr[:] = np.asarray(pil_img)` 写回，否则模型拿到的是空白图。
"""
from __future__ import annotations

import base64
import threading
from typing import Any

import cv2
import numpy as np

_engine = None
_engine_error: str | None = None
_engine_lock = threading.Lock()

UPSCALE_MIN_H = 120   # 低于此高度的裁剪图先放大再送 OCR（经验值）
BOX_PAD_MM = 0.0      # OCR 裁剪不外扩——框线被裁入会让检测器误读（实测 0.5mm 即导致 dogs→sãop）


def _load_engine():
    """懒加载 RapidOCR 单例（rapidocr v2，onnxruntime 后端）；线程安全（启动预热用）。"""
    global _engine, _engine_error
    if _engine is not None or _engine_error is not None:
        return _engine
    with _engine_lock:
        if _engine is not None or _engine_error is not None:
            return _engine
        try:
            from rapidocr import RapidOCR
            _engine = RapidOCR()
        except Exception as exc:  # noqa: BLE001
            _engine_error = f"{type(exc).__name__}: {exc}"
            return None
    return _engine


def _parse_result(result: Any) -> list[tuple[str, float]]:
    """统一解析 RapidOCR v2（RapidOCROutput：.txts/.scores）与 v1（列表）输出。"""
    if not result:
        return []
    if hasattr(result, "txts"):
        txts = list(result.txts or [])
        scores = list(result.scores or [])
        out = []
        for i, t in enumerate(txts):
            s = float(scores[i]) if i < len(scores) else 0.0
            if t and str(t).strip():
                out.append((str(t), s))
        return out
    if isinstance(result, (list, tuple)):
        out = []
        for item in result:
            try:
                t, s = item[1], float(item[2])
            except (IndexError, TypeError, ValueError):
                continue
            if t and str(t).strip():
                out.append((str(t), s))
        return out
    return []


def crop_box(warped: np.ndarray, scale: float, rect: list[float],
             pad_mm: float = BOX_PAD_MM) -> np.ndarray | None:
    """按 mm rect（含外扩）裁剪作答框，返回灰度图。"""
    x1, y1, x2, y2 = [v * scale for v in rect]
    pad = pad_mm * scale
    x0, y0 = max(int(x1 - pad), 0), max(int(y1 - pad), 0)
    x1c, y1c = min(int(x2 + pad), warped.shape[1]), min(int(y2 + pad), warped.shape[0])
    if x1c - x0 < 4 or y1c - y0 < 4:
        return None
    return warped[y0:y1c, x0:x1c]


def _preprocess(crop: np.ndarray) -> np.ndarray:
    """放大 + 轻微去噪，输入给 OCR。返回三通道图（RapidOCR 要求）。"""
    img = crop
    h = img.shape[0]
    if h < UPSCALE_MIN_H:
        factor = max(2.0, UPSCALE_MIN_H / max(h, 1))
        img = cv2.resize(img, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)
    img = cv2.fastNlMeansDenoising(img, None, 7, 7, 21)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def ocr_local(crop: np.ndarray) -> list[tuple[str, float]]:
    """本地 RapidOCR 转写（主路径，兼容旧调用）。返回 [(text, score)]。"""
    primary, _alts = ocr_candidates_local(crop)
    return primary


def trim_borders(crop: np.ndarray, border_ratio: float = 0.75,
                 max_frac: float = 0.20, margin: int = 2) -> np.ndarray:
    """去掉作答框描边：按行列投影找满宽/满高的连续暗带（边框线整行整列全黑，
    文字行远低于此），内缩越过线内缘并留 margin px 余量；找不到时不裁。

    实测：框线留在裁剪图里会让 rec 误读（vehicle→vehide）；本函数只裁
    真正的边框带，不依赖固定内缩量（固定 inset 会切到贴近边框的文字）。
    """
    h, w = crop.shape
    if h < 24 or w < 40:
        return crop
    dark = crop < 160
    row_ratio = dark.mean(axis=1)
    col_ratio = dark.mean(axis=0)

    def run_from(ratio, rev=False):
        seq = ratio[::-1] if rev else ratio
        i = 0
        while i < len(seq) and seq[i] >= border_ratio:
            i += 1
        return i

    t = min(run_from(row_ratio), int(h * max_frac))
    b = min(run_from(row_ratio, True), int(h * max_frac))
    l = min(run_from(col_ratio), int(w * max_frac))
    r = min(run_from(col_ratio, True), int(w * max_frac))
    t = min(t + margin, int(h * 0.45))
    b = min(b + margin, int(h * 0.45))
    l = min(l + margin, int(w * 0.45))
    r = min(r + margin, int(w * 0.45))
    return crop[t:h - b, l:w - r]


def ocr_candidates_local(crop: np.ndarray) -> tuple[list[tuple[str, float]], list[dict]]:
    """三路径候选：det(raw) / rec(raw) / rec(裁边后)，返回 (主路径, 备选列表)。

    RapidOCR v2 的 det 对输入尺寸不稳定（同图不同尺寸结果抖动、甚至空结果），
    单一路径可能高置信误读（vehicle→vehide）。这里把三条路径都跑一遍：
    主路径 = 置信度最高者；其余为备选。判分端在首选判错但备选能匹配标准答案
    时转人工复核（避免静默误判），见 server scoring.gradeFillBlank。
    rec 路径置信度 ×0.7（整体质量低于 det，保持既有降级语义）。
    """
    engine = _load_engine()
    if engine is None:
        raise RuntimeError(f"RapidOCR 不可用: {_engine_error or '未安装 rapidocr'}")
    img = _preprocess(crop)

    def normalize(lines: list[tuple[str, float]]) -> list[tuple[str, float]]:
        return [(t, s) for t, s in lines if t and str(t).strip()]

    candidates: list[dict] = []
    # 1) det(raw)
    try:
        lines = normalize(_parse_result(engine(img)))
        if lines:
            candidates.append({
                "mode": "det",
                "text": " ".join(t for t, _ in lines).strip(),
                "confidence": float(np.mean([s for _, s in lines])),
                "lines": lines,
            })
    except TypeError:
        pass
    # 2) rec(raw)
    try:
        lines = normalize(_parse_result(engine(img, use_det=False)))
        if lines:
            candidates.append({
                "mode": "rec",
                "text": " ".join(t for t, _ in lines).strip(),
                "confidence": float(np.mean([s for _, s in lines])) * 0.7,
                "lines": lines,
            })
    except TypeError:
        pass
    # 3) rec(裁边)
    trimmed = trim_borders(crop)
    if trimmed.shape != crop.shape:
        try:
            img2 = _preprocess(trimmed)
            lines = normalize(_parse_result(engine(img2, use_det=False)))
            if lines:
                candidates.append({
                    "mode": "rec-trim",
                    "text": " ".join(t for t, _ in lines).strip(),
                    "confidence": float(np.mean([s for _, s in lines])) * 0.7,
                    "lines": lines,
                })
        except TypeError:
            pass
    if not candidates:
        return [], []
    candidates.sort(key=lambda c: c["confidence"], reverse=True)
    primary = [(c["text"], c["confidence"]) for c in candidates[:1]]
    alternatives = [
        {"text": c["text"], "confidence": round(c["confidence"], 4), "mode": c["mode"]}
        for c in candidates[1:]
        if c["text"] != candidates[0]["text"]
    ]
    return primary, alternatives


def _image_b64(crop: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", crop)
    if not ok:
        raise RuntimeError("裁剪图编码失败")
    return base64.b64encode(buf.tobytes()).decode()


_PROMPT = ("Read the handwritten or printed text in this image (an exam fill-in blank). "
           "Reply with ONLY the text, no quotes, no explanation.")


def _llm_request(url: str, body: dict, headers: dict) -> dict:
    import json
    import urllib.request

    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode(),
        headers=headers, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def ocr_llm(crop: np.ndarray, cfg: dict) -> list[tuple[str, float]]:
    """通用 LLM 视觉转写（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages）。

    cfg: {provider, endpoint, api_key, model}。返回 [(text, score)]，未配置抛错。
    """
    provider = cfg.get("provider") or "none"
    endpoint = (cfg.get("endpoint") or "").rstrip("/")
    api_key = cfg.get("api_key") or ""
    model = cfg.get("model") or "gpt-4o-mini"
    if provider == "none" or not endpoint or not api_key:
        raise RuntimeError("LLM 未配置（provider/endpoint/api_key 缺失）")
    b64 = _image_b64(crop)
    data_url = f"data:image/png;base64,{b64}"

    if provider == "anthropic":
        body = {
            "model": model,
            "max_tokens": 64,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64",
                                                 "media_type": "image/png", "data": b64}},
                    {"type": "text", "text": _PROMPT},
                ],
            }],
        }
        data = _llm_request(
            f"{endpoint}/v1/messages", body,
            {"content-type": "application/json", "x-api-key": api_key,
             "anthropic-version": "2023-06-01"},
        )
        text = "".join(
            b.get("text", "") for b in (data.get("content") or []) if b.get("type") == "text"
        )
    elif provider == "openai_responses":
        body = {
            "model": model,
            "max_output_tokens": 64,
            "input": [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": _PROMPT},
                    {"type": "input_image", "image_url": data_url},
                ],
            }],
        }
        data = _llm_request(
            f"{endpoint}/responses", body,
            {"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        )
        text = "".join(
            o.get("text", "") for o in (data.get("output") or [])
            if o.get("type") in ("message", "output_text") and o.get("text")
        )
        if not text:
            text = "".join(
                c.get("text", "") for o in (data.get("output") or [])
                for c in (o.get("content") or []) if c.get("type") == "output_text"
            )
    else:  # openai_completion（默认，兼容第三方 OpenAI 兼容服务）
        body = {
            "model": model,
            "max_tokens": 64,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": _PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }],
        }
        data = _llm_request(
            f"{endpoint}/chat/completions", body,
            {"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        )
        text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")

    text = (text or "").strip().strip('"')
    if not text:
        return []
    return [(text, 0.95)]


def ocr_external(crop: np.ndarray, cfg: dict) -> list[tuple[str, float]]:
    """外部 OpenAI 兼容视觉接口转写（需 endpoint/key/model；未配置抛错）。"""
    endpoint = (cfg.get("endpoint") or "").rstrip("/")
    api_key = cfg.get("api_key") or ""
    model = cfg.get("model") or "gpt-4o-mini"
    if not endpoint or not api_key:
        raise RuntimeError("外部 OCR 未配置（endpoint/api_key 缺失）")
    b64 = _image_b64(crop)
    body = {
        "model": model,
        "max_tokens": 64,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": _PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ],
        }],
    }
    data = _llm_request(
        f"{endpoint}/chat/completions", body,
        {"content-type": "application/json", "authorization": f"Bearer {api_key}"},
    )
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    text = (content or "").strip().strip('"')
    if not text:
        return []
    return [(text, 1.0)]


def ocr_blank(warped: np.ndarray, scale: float, rect: list[float],
              engine_cfg: dict) -> dict:
    """单个作答框的 OCR 结果。返回 {text, confidence, lines, engine, alternatives?, error?}。

    local 引擎：三路径候选（det/rec/裁边 rec）；若主候选置信度低于
    min_confidence 或未识别，且 recheck_enabled（默认开）且配置了 LLM 或
    外部视觉 API → 用 API 复核同一裁剪图，结果并入候选并按置信度重排
    （API 更可信则成为主路径；本地更可信则作为备选，判分端冲突复核兜底）。
    """
    crop = crop_box(warped, scale, rect)
    if crop is None:
        return {"text": "", "confidence": 0.0, "lines": [], "engine": "none",
                "error": "裁剪区域无效"}
    engine = engine_cfg.get("engine", "local")
    alternatives: list[dict] = []
    try:
        if engine == "external":
            lines = ocr_external(crop, engine_cfg.get("external") or {})
            eng = "external"
        elif engine == "llm":
            lines = ocr_llm(crop, engine_cfg.get("llm") or {})
            eng = "llm"
        else:
            lines, alternatives = ocr_candidates_local(crop)
            eng = "local"
            # RapidOCR 低置信/未识别 → LLM/视觉 API 复核
            min_conf = float(engine_cfg.get("min_confidence") or 0.6)
            low = (not lines) or float(np.mean([s for _, s in lines])) < min_conf
            if low and engine_cfg.get("recheck_enabled", True):
                try:
                    rc = _recheck_with_api(crop, engine_cfg)
                    if rc:
                        _merge_api_candidate(lines, alternatives, rc)
                except Exception:
                    pass  # API 不可用/超时/未配置 → 保持本地结果
    except Exception as exc:  # noqa: BLE001
        return {"text": "", "confidence": 0.0, "lines": [], "engine": engine,
                "error": f"{type(exc).__name__}: {exc}"}
    text = " ".join(t for t, _s in lines).strip()
    # 多空题 (1)(2) 序号标签若被裁入框内，移除任意位置的序号令牌
    if text:
        import re
        text = re.sub(r"\(\d+\)\s*", "", text).strip()
    conf = float(np.mean([s for _t, s in lines])) if lines else 0.0
    for alt in alternatives:
        alt["text"] = re.sub(r"\(\d+\)\s*", "", alt.get("text", "")).strip()
    # 识别分歧惩罚：主候选与备选候选文本不一致（多路径各读各的）说明识别不稳定，
    # 置信度打 8 折 → 更可能跌破 min_confidence 进人工复核（防高置信静默误判）
    if text and any(a["text"] and a["text"] != text for a in alternatives):
        conf *= 0.8
    out: dict = {
        "text": text,
        "confidence": round(conf, 4),
        "lines": [{"text": t, "confidence": round(s, 4)} for t, s in lines],
        "engine": eng,
    }
    if alternatives:
        out["alternatives"] = alternatives
    return out


def _recheck_with_api(crop: np.ndarray, engine_cfg: dict) -> list[tuple[str, float]]:
    """RapidOCR 低置信复核：优先 LLM 三协议，其次外部 OpenAI 兼容视觉。未配置返回 []。"""
    llm_cfg = engine_cfg.get("llm") or {}
    ext_cfg = engine_cfg.get("external") or {}
    llm_ready = (
        (llm_cfg.get("provider") or "none") != "none"
        and llm_cfg.get("endpoint")
        and llm_cfg.get("api_key")
    )
    ext_ready = ext_cfg.get("endpoint") and ext_cfg.get("api_key")
    if llm_ready:
        return ocr_llm(crop, llm_cfg)
    if ext_ready:
        return ocr_external(crop, ext_cfg)
    return []


def _merge_api_candidate(lines: list[tuple[str, float]], alternatives: list[dict],
                         rc: list[tuple[str, float]]) -> None:
    """把 API 复核结果并入候选并按置信度重排（in-place 修改 lines/alternatives）。"""
    if not rc:
        return
    rc_txt = " ".join(t for t, _ in rc).strip()
    if not rc_txt:
        return
    rc_conf = float(np.mean([s for _, s in rc]))
    cands: list[dict] = []
    if lines:
        cands.append({"mode": "local", "text": lines[0][0],
                      "confidence": float(np.mean([s for _, s in lines]))})
    cands.extend(alternatives)
    cands.append({"mode": "api-recheck", "text": rc_txt, "confidence": rc_conf})
    cands.sort(key=lambda c: c["confidence"], reverse=True)
    lines.clear()
    lines.append((cands[0]["text"], cands[0]["confidence"]))
    alternatives.clear()
    alternatives.extend(
        {"text": c["text"], "confidence": round(c["confidence"], 4), "mode": c["mode"]}
        for c in cands[1:]
        if c["text"] != cands[0]["text"]
    )


def ocr_blocks(warped: np.ndarray, scale: float, blocks: list[dict],
               engine_cfg: dict) -> list[dict]:
    """对全部 ocr 块执行转写（含逐空 blank 下标）。

    并行处理各作答框：onnxruntime 推理释放 GIL，多框并发可显著缩短整页 OCR
    耗时（单学生全卷批改 ≤20s 目标的关键优化）。
    """
    targets = []
    for block in blocks:
        if block.get("kind") != "ocr":
            continue
        rect = block.get("rect")
        if not rect or len(rect) != 4:
            continue
        targets.append((block, rect))

    results: list[dict] = [None] * len(targets)  # type: ignore[list-item]
    if len(targets) > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(4, len(targets))) as pool:
            futs = {pool.submit(ocr_blank, warped, scale, rect, engine_cfg): i
                    for i, (_b, rect) in enumerate(targets)}
            for fut in futs:
                results[futs[fut]] = fut.result()
    else:
        for i, (_b, rect) in enumerate(targets):
            results[i] = ocr_blank(warped, scale, rect, engine_cfg)

    out = []
    for (block, _rect), res in zip(targets, results):
        if res is None:
            continue
        out.append({
            "qid": block.get("qid"),
            "blank": block.get("blank", 0),
            "lines": block.get("lines", 1),
            **res,
        })
    return out
