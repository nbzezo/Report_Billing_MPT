"""Goi Claude qua SDK chinh thuc `anthropic` (khong tu dung HTTP cho Claude -
SDK chinh thuc la mac dinh bat buoc khi con)."""

DEFAULT_MAX_TOKENS = 4096


def send(api_key, model, system, messages, client=None, max_tokens=DEFAULT_MAX_TOKENS,
         **_ignored):
    if not api_key:
        raise ValueError("Thiếu API key Anthropic (Claude).")
    if not model:
        raise ValueError("Thiếu tên model Claude (vd claude-sonnet-5).")
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system or "",
        messages=[{"role": m["role"], "content": m["content"]} for m in messages],
    )
    parts = [
        block.text for block in response.content
        if getattr(block, "type", None) == "text"
    ]
    text = "\n".join(parts).strip()
    if not text:
        raise RuntimeError("Claude không trả về nội dung văn bản.")
    return text
