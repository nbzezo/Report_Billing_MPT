"""Helper HTTP dung chung cho cac cong noi theo dinh dang OpenAI-compatible
(POST /chat/completions). Dung noi bo boi deepseek_provider.py va
gateway_provider.py - hai provider nay chi khac nhau o base URL/model mac
dinh va thong bao loi, khong khac nhau ve hinh dang request/response.

Khong dung SDK: day chi la 1 POST JSON don gian, dung `urllib.request` giong
pattern `MptClient` da co trong mpt_dashboard_server.py.
"""
import json
import urllib.error
import urllib.request

CHAT_PATH = "/chat/completions"
DEFAULT_TIMEOUT = 60


def chat(base_url, api_key, model, system, messages, label,
         timeout=DEFAULT_TIMEOUT, opener=None):
    if not base_url:
        raise ValueError(f"Thiếu Base URL của {label}.")
    if not api_key:
        raise ValueError(f"Thiếu API key của {label}.")
    if not model:
        raise ValueError(f"Thiếu tên model của {label}.")
    base = base_url.rstrip("/")
    url = base if base.endswith("/chat/completions") else base + CHAT_PATH
    payload = {
        "model": model,
        "messages": _build_messages(system, messages),
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {api_key}")
    request_opener = opener or urllib.request
    try:
        res = request_opener.urlopen(req, timeout=timeout)
        raw = res.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else ""
        raise RuntimeError(f"{label} trả lỗi HTTP {exc.code}: {detail[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Không kết nối được {label}: {exc.reason}") from exc
    data = json.loads(raw.decode("utf-8"))
    text = _extract_text(data)
    if not text:
        raise RuntimeError(f"{label} không trả về nội dung văn bản.")
    return text


def _build_messages(system, messages):
    out = []
    if system:
        out.append({"role": "system", "content": system})
    for m in messages:
        out.append({"role": m["role"], "content": m["content"]})
    return out


def _extract_text(data):
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return (message.get("content") or "").strip()
