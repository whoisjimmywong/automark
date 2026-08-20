"""
页面二维码负载编码/解码。

格式（11 字符，base36 字符集 0-9A-Z）：
  [0]    版本（'1'）
  [1:7]  考试 ID 短码（exam.id 的 sha256 派生 6 位 base36）
  [7:9]  页码（2 位十进制，01..99）
  [9:11] 校验（前 9 字符的加权和 mod 1296 的 2 位 base36）
"""
import hashlib

CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
VERSION = "1"


def _to_base36(n: int, width: int) -> str:
    out = []
    for _ in range(width):
        out.append(CHARSET[n % 36])
        n //= 36
    return "".join(reversed(out))


def _from_base36(s: str) -> int:
    n = 0
    for ch in s:
        n = n * 36 + CHARSET.index(ch)
    return n


def exam_short_code(exam_id: str) -> str:
    digest = hashlib.sha256(exam_id.encode("utf-8")).digest()
    n = int.from_bytes(digest[:4], "big") % (36 ** 6)
    return _to_base36(n, 6)


def _checksum(body: str) -> str:
    total = sum((i + 1) * CHARSET.index(ch) for i, ch in enumerate(body))
    return _to_base36(total % (36 ** 2), 2)


def encode(exam_id: str, page: int) -> str:
    """生成 11 位 QR 负载。"""
    if not (1 <= page <= 99):
        raise ValueError(f"page out of range: {page}")
    body = f"{VERSION}{exam_short_code(exam_id)}{page:02d}"
    return body + _checksum(body)


def decode(payload: str) -> dict | None:
    """解码并校验；失败返回 None。"""
    if len(payload) != 11:
        return None
    try:
        body, check = payload[:9], payload[9:]
        if _checksum(body) != check:
            return None
        return {
            "version": body[0],
            "exam_code": body[1:7],
            "page": int(body[7:9]),
        }
    except (ValueError, IndexError):
        return None
