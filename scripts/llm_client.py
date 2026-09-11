"""Dispatcher trung tam cho 4 provider LLM (Anthropic/Gemini/DeepSeek/Gateway).

Noi duy nhat giu system prompt cho 4 che do (summary/explain/chat/risk_report) -
server (mpt_dashboard_server.py) chi goi send_for_feature(...), khong tu dung
system prompt tu client (client chi gui "context"/"question").

Nguyen tac (theo skill telecom-cid-risk-optimizer muc 1.1/36, ap dung chung cho
ca 4 che do o day): LLM chi duoc doc va dien giai JSON da tong hop, khong duoc
tu tinh/tu bia so lieu, khong doi threshold da tinh san.
"""
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

SYSTEM_PROMPTS = {
    "summary": (
        "Bạn là trợ lý phân tích dữ liệu cho một dashboard cuộc gọi viễn thông "
        "(MPT Call Dashboard). Người dùng vừa xem 1 tab báo cáo; bạn nhận JSON "
        "tổng hợp (cube) của đúng dữ liệu đang hiển thị trên tab đó. Viết một "
        "tóm tắt điều hành ngắn: 3-5 phát hiện đáng chú ý (kèm số liệu cụ thể), "
        "nêu bất thường nếu có, kết thúc bằng 1-2 gợi ý hành động.\n\n" + _DISCIPLINE
    ),
    "explain": (
        "Bạn là trợ lý phân tích dữ liệu cho một dashboard cuộc gọi viễn thông. "
        "Người dùng bấm \"Giải thích\" trên 1 cảnh báo/dòng bất thường cụ thể; "
        "bạn nhận JSON mô tả đúng dòng đó (và đôi khi baseline để so sánh). "
        "Giải thích ngắn gọn ý nghĩa cảnh báo này, vì sao nó được gắn cờ, và 1 "
        "hành động cụ thể nên làm tiếp theo.\n\n" + _DISCIPLINE
    ),
    "chat": (
        "Bạn là trợ lý hỏi-đáp cho một dashboard cuộc gọi viễn thông (MPT Call "
        "Dashboard). Người dùng đặt câu hỏi tự do về dữ liệu đang xem; bạn nhận "
        "JSON tổng hợp (cube) của tab hiện tại làm ngữ cảnh. Trả lời thẳng vào "
        "câu hỏi, trích số liệu cụ thể từ JSON khi có thể.\n\n" + _DISCIPLINE
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
    return {"text": text, "provider": provider_key,
            "providerLabel": PROVIDER_LABELS.get(provider_key, provider_key),
            "model": cfg.get("model", "")}


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
