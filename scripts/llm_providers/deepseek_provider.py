"""Goi DeepSeek. Khong co SDK Python rieng - DeepSeek tu nhan API tuong thich
OpenAI (xem https://api-docs.deepseek.com), nen dung thang HTTP qua
_openai_compat thay vi keo them dependency chi de POST 1 JSON don gian.
"""
from . import _openai_compat

DEFAULT_BASE_URL = "https://api.deepseek.com"
LABEL = "DeepSeek"


def send(api_key, model, system, messages, base_url=None, opener=None,
         timeout=_openai_compat.DEFAULT_TIMEOUT, **_ignored):
    return _openai_compat.chat(
        base_url or DEFAULT_BASE_URL, api_key, model, system, messages,
        label=LABEL, timeout=timeout, opener=opener,
    )
