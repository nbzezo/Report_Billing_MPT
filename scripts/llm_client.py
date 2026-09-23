"""Dispatcher trung tam cho 4 provider LLM (Anthropic/Gemini/DeepSeek/Gateway).

Noi duy nhat giu system prompt cho 4 che do (summary/explain/chat/risk_report) -
server (mpt_dashboard_server.py) chi goi send_for_feature(...), khong tu dung
system prompt tu client (client chi gui "context"/"question").

Nguyen tac (theo skill telecom-cid-risk-optimizer muc 1.1/36, ap dung chung cho
ca 4 che do o day): LLM chi duoc doc va dien giai JSON da tong hop, khong duoc
tu tinh/tu bia so lieu, khong doi threshold da tinh san.
"""
import json
import re

from llm_providers import anthropic_provider, deepseek_provider, gateway_provider, gemini_provider

PROVIDERS = {
    "anthropic": anthropic_provider,
    "gemini": gemini_provider,
    "deepseek": deepseek_provider,
    "gateway": gateway_provider,
}

PROVIDER_LABELS = {
    "anthropic": "Claude",
    "gemini": "Gemini",
    "deepseek": "DeepSeek",
    "gateway": "Cổng LLM",
}

_DISCIPLINE = (
    "Chỉ dùng số liệu có trong JSON được cung cấp. Không tự tính hoặc bịa ra số "
    "liệu mới, không đổi threshold/ngưỡng đã có sẵn trong JSON. Nếu dữ liệu "
    "không đủ để kết luận, nói rõ \"Chưa đủ dữ liệu\" thay vì đoán. Phân biệt rõ "
    "correlation/liên hệ thống kê với causal/nguyên nhân — không gọi correlation "
    "là causal nếu JSON không có bằng chứng thực nghiệm. Trả lời bằng tiếng "
    "Việt, ngắn gọn, đi thẳng vào số liệu và khuyến nghị."
)

_FILTER_SCOPE_DISCIPLINE = (
    "Mọi câu trả lời về dữ liệu phải nằm tuyệt đối trong FILTER_SCOPE và "
    "FILTERED_DATABASE_CONTEXT được cung cấp. Không dùng dữ liệu ngoài khoảng "
    "ngày/giờ, account hoặc điều kiện lọc đó; nếu người dùng hỏi ngoài phạm vi "
    "thì nói rõ cần đổi bộ lọc."
)

_PRESENTATION_CONTRACT = """
Trả về DUY NHẤT một JSON object hợp lệ, không bọc trong markdown/code fence:
{
  "title": "tiêu đề ngắn",
  "summary": "kết luận 1-2 câu",
  "blocks": [
    {"type":"section","title":"...","text":"...","bullets":["..."]},
    {"type":"kpis","items":[{"label":"...","value":"...","tone":"good|warn|bad|neutral"}]},
    {"type":"callout","tone":"info|good|warn|bad","title":"...","text":"..."},
    {"type":"table","title":"...","columns":["..."],"rows":[["..."]]},
    {"type":"chart","title":"...","chartType":"bar|line","labels":["..."],"values":[0],"unit":"%"},
    {"type":"diagram","title":"...","nodes":[{"id":"a","label":"...","value":"..."}],"edges":[{"from":"a","to":"b","label":"..."}]},
    {"type":"actions","title":"Nên làm tiếp","items":["..."]},
    {"type":"text","title":"...","text":"..."}
  ]
}
Đây là hợp đồng UI linh hoạt, KHÔNG phải mẫu báo cáo cố định. Chọn block theo
bản chất câu hỏi: câu hỏi nhanh dùng kpis/callout ngắn; phân tích vận hành dùng
section + table + actions; so sánh nhiều dòng dùng table; chuỗi số dùng chart;
quan hệ/quy trình dùng diagram. Nếu câu hỏi không liên quan Fail/Gateway thì
không tự ép vào khung Fail/Gateway. Tối đa 10 blocks, bảng tối đa 10 dòng, biểu
đồ tối đa 12 điểm. Không chèn HTML, markdown hay URL ảnh giả.
""".strip()

SYSTEM_PROMPTS = {
    "summary": (
        "Bạn là trợ lý phân tích dữ liệu cho một dashboard cuộc gọi viễn thông "
        "(MPT Call Dashboard). Người dùng vừa xem 1 tab báo cáo; bạn nhận JSON "
        "tổng hợp (cube) của đúng dữ liệu đang hiển thị trên tab đó. Viết một "
        "tóm tắt điều hành ngắn: 3-5 phát hiện đáng chú ý (kèm số liệu cụ thể), "
        "nêu bất thường nếu có, kết thúc bằng 1-2 gợi ý hành động.\n\n" + _DISCIPLINE
        + "\n\n" + _FILTER_SCOPE_DISCIPLINE + "\n\n" + _PRESENTATION_CONTRACT
    ),
    "explain": (
        "Bạn là trợ lý phân tích dữ liệu cho một dashboard cuộc gọi viễn thông. "
        "Người dùng bấm \"Giải thích\" trên 1 cảnh báo/dòng bất thường cụ thể; "
        "bạn nhận JSON mô tả đúng dòng đó (và đôi khi baseline để so sánh). "
        "Giải thích ngắn gọn ý nghĩa cảnh báo này, vì sao nó được gắn cờ, và 1 "
        "hành động cụ thể nên làm tiếp theo.\n\n" + _DISCIPLINE
        + "\n\n" + _FILTER_SCOPE_DISCIPLINE + "\n\n" + _PRESENTATION_CONTRACT
    ),
    "chat": (
        "Bạn là trợ lý hỏi-đáp cho một dashboard cuộc gọi viễn thông (MPT Call "
        "Dashboard). Người dùng đặt câu hỏi tự do về dữ liệu đang xem; bạn nhận "
        "JSON tổng hợp (cube) của tab hiện tại làm ngữ cảnh. Trả lời thẳng vào "
        "câu hỏi, trích số liệu cụ thể từ JSON khi có thể.\n\n" + _DISCIPLINE
        + "\n\n" + _FILTER_SCOPE_DISCIPLINE + "\n\n" + _PRESENTATION_CONTRACT
    ),
    "risk_report": (
        "Bạn là CHUYÊN GIA PHÂN TÍCH DỮ LIỆU VIỄN THÔNG, chuyên về CID/CDR, "
        "routing outbound, chống khóa đầu số, tối ưu number_random/call_fail. "
        "Bạn nhận JSON kết quả đã tính sẵn bởi calculation engine (không phải "
        "CDR thô). Viết báo cáo gồm: Tóm tắt điều hành, 3-5 phát hiện chính, "
        "bảng tham số khuyến nghị (nêu rõ confidence HIGH/MEDIUM/LOW cho từng "
        "tham số), hạn chế của phân tích, và tối đa 5 hành động ưu tiên (Top 5 "
        "Actions). Mỗi kết luận định lượng phải gắn với 1 số liệu cụ thể trong "
        "JSON.\n\n" + _DISCIPLINE
    ),
}


class LlmNotConfiguredError(RuntimeError):
    pass


def _clean_presentation_text(value):
    text = str(value or "")
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip(" \t\r\n-*")


def _table_cells(line):
    return [_clean_presentation_text(cell) for cell in line.strip().strip("|").split("|")]


def _is_table_separator(line):
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in cells)


def _markdown_presentation(raw):
    normalized = (raw or "").replace("\r\n", "\n").replace("\r", "\n")
    normalized = re.sub(r"(?<!\n)(#{1,4}\s+\d*\.?\s*)", r"\n\1", normalized)
    lines = [line.strip() for line in normalized.split("\n") if line.strip()]
    title = "Phân tích AI"
    title_seen = False
    summary = ""
    blocks = []
    section_title = None
    section_text = []
    section_bullets = []

    def flush_section():
        nonlocal section_title, section_text, section_bullets
        text = " ".join(_clean_presentation_text(line) for line in section_text).strip()
        bullets = [_clean_presentation_text(item) for item in section_bullets]
        bullets = [item for item in bullets if item]
        if section_title or text or bullets:
            blocks.append({
                "type": "section",
                "title": section_title or ("Ý chính" if not blocks else "Chi tiết"),
                "text": text,
                "bullets": bullets[:8],
            })
        section_title = None
        section_text = []
        section_bullets = []

    index = 0
    while index < len(lines):
        line = lines[index]
        heading = re.match(r"^(#{1,4})\s+(.+)$", line)
        if heading:
            flush_section()
            clean_heading = _clean_presentation_text(heading.group(2))
            if not title_seen:
                title = clean_heading[:160] or title
                title_seen = True
            else:
                section_title = clean_heading
            index += 1
            continue

        if "|" in line and index + 1 < len(lines) and _is_table_separator(lines[index + 1]):
            flush_section()
            columns = _table_cells(line)[:8]
            rows = []
            index += 2
            while index < len(lines) and "|" in lines[index] and not _is_table_separator(lines[index]):
                rows.append(_table_cells(lines[index])[:len(columns)])
                index += 1
            blocks.append({
                "type": "table",
                "title": section_title or "Bảng số liệu",
                "columns": columns,
                "rows": rows[:10],
            })
            section_title = None
            continue

        bullet = re.match(r"^(?:[-*•]|\d+[.)])\s+(.+)$", line)
        if bullet:
            section_bullets.append(bullet.group(1))
        else:
            clean_line = _clean_presentation_text(line)
            if clean_line:
                if not summary:
                    summary = clean_line[:400]
                if section_title or section_text or section_bullets or blocks:
                    section_text.append(clean_line)
        index += 1

    flush_section()
    if not summary and blocks:
        first = blocks[0]
        summary = (first.get("text") or " ".join(first.get("bullets") or []))[:400]
    if not blocks:
        clean = _clean_presentation_text(raw)
        blocks = [{"type": "text", "text": clean}]
        summary = clean[:400]
    return {"title": title, "summary": summary, "blocks": blocks[:10]}


def _structured_presentation(text):
    """Parse the visual answer contract without ever trusting model HTML."""
    raw = (text or "").strip()
    candidate = raw
    if candidate.startswith("```"):
        lines = candidate.splitlines()
        if lines and lines[0].lstrip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        candidate = "\n".join(lines).strip()
    try:
        value = json.loads(candidate)
    except (TypeError, ValueError):
        value = None
    if not isinstance(value, dict):
        return _markdown_presentation(raw)
    blocks = value.get("blocks")
    if not isinstance(blocks, list):
        blocks = []
    return {
        "title": str(value.get("title") or "Phân tích AI")[:160],
        "summary": str(value.get("summary") or "")[:4000],
        "blocks": [block for block in blocks[:10] if isinstance(block, dict)],
    }


def send_for_feature(cfg, feature_key, messages, extra_system=""):
    """cfg: dict {"provider","apiKey","model","baseUrl"} - xem
    LlmConfigStore.resolve() trong mpt_dashboard_server.py. Nem exception khi
    chua cau hinh hoac provider goi loi; nguoi goi (server handler) bat va tra
    error_response.

    Tra ve {"text","provider","model"} - dung de UI hien "Trả lời bởi: ...".
    """
    provider_key = cfg.get("provider")
    module = PROVIDERS.get(provider_key)
    if module is None:
        raise LlmNotConfiguredError(
            "Chưa cấu hình nhà cung cấp LLM nào. Mở menu ☰ → Cấu hình LLM."
        )
    system = SYSTEM_PROMPTS.get(feature_key, "")
    if extra_system:
        system = f"{system}\n\n{extra_system}"
    text = module.send(
        api_key=cfg.get("apiKey", ""),
        model=cfg.get("model", ""),
        system=system,
        messages=messages,
        base_url=cfg.get("baseUrl"),
    )
    result = {"text": text, "provider": provider_key,
              "providerLabel": PROVIDER_LABELS.get(provider_key, provider_key),
              "model": cfg.get("model", "")}
    if feature_key in ("summary", "explain", "chat"):
        result["presentation"] = _structured_presentation(text)
    return result


def test_provider(provider_key, api_key, model, base_url=None):
    """Goi 1 request re de xac nhan key/model/baseUrl hoat dong - dung cho nut
    "Kiểm tra kết nối" trong UI cau hinh."""
    module = PROVIDERS.get(provider_key)
    if module is None:
        raise ValueError(f"Provider LLM không hợp lệ: {provider_key!r}.")
    text = module.send(
        api_key=api_key,
        model=model,
        system="Trả lời đúng 1 từ: OK",
        messages=[{"role": "user", "content": "Ping"}],
        base_url=base_url,
    )
    return {"ok": True, "sample": text[:200]}
