# -*- coding: utf-8 -*-
"""AutoMark vision 服务入口（PyInstaller 打包用）。"""
import os
import sys

# PyInstaller 冻结环境：模型等资源在 _internal 内
if getattr(sys, "frozen", False):
    os.environ.setdefault("AUTOMARK_FROZEN", "1")

from app import main as app_main  # noqa: E402
import uvicorn  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("VISION_PORT", "8791"))
    uvicorn.run(app_main.app, host="127.0.0.1", port=port, log_level="info")
