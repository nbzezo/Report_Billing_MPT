"""Goi cong OpenAI-compatible tuy chon cua nguoi dung: 9Router (tu host,
http://localhost:20128/v1), OpenRouter (https://openrouter.ai/api/v1), hoac
bat ky cong nao khac cung dinh dang. Khong co base URL mac dinh pho quat -
UI cau hinh LLM goi y san 2 preset nhung nguoi dung phai chon/nhap.
"""
from . import _openai_compat

LABEL = "Cổng LLM"


def send(api_key, model, system, messages, base_url=None, opener=None,
         timeout=_openai_compat.DEFAULT_TIMEOUT, **_ignored):
    return _openai_compat.chat(
        base_url, api_key, model, system, messages,
        label=LABEL, timeout=timeout, opener=opener,
    )
