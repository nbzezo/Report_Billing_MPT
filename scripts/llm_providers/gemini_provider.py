"""Goi Gemini qua SDK chinh thuc `google-genai` (khac package cu da bi thay the
`google-generativeai`). Hinh dang API xac minh truc tiep tu README tren PyPI
luc lap ke hoach:

    from google import genai
    client = genai.Client(api_key=...)
    client.models.generate_content(model=..., contents=..., config=...)
"""

DEFAULT_MAX_OUTPUT_TOKENS = 4096


def send(api_key, model, system, messages, client=None, **_ignored):
    if not api_key:
        raise ValueError("Thiếu API key Gemini.")
    if not model:
        raise ValueError("Thiếu tên model Gemini (vd gemini-2.5-flash).")
    if client is None:
        from google import genai
        client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=_to_contents(messages),
        config=_build_config(system),
    )
    text = (getattr(response, "text", "") or "").strip()
    if not text:
        raise RuntimeError("Gemini không trả về nội dung văn bản.")
    return text


def _to_contents(messages):
    contents = []
    for m in messages:
        role = "model" if m["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})
    return contents


def _build_config(system):
    """types.GenerateContentConfig neu SDK co san; roi ve dict thuong (SDK
    chap nhan ca hai) neu khong import duoc - khong lam gian doan test khi
    chua cai `google-genai`."""
    cfg = {"system_instruction": system} if system else {}
    cfg["max_output_tokens"] = DEFAULT_MAX_OUTPUT_TOKENS
    try:
        from google.genai import types
        return types.GenerateContentConfig(**cfg)
    except Exception:
        return cfg or None
