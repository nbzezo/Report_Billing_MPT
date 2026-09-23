"""Test 4 provider LLM (scripts/llm_providers/) + dispatcher (scripts/llm_client.py).

Khong goi mang that o day: moi test tu inject fake client/opener. Muc tieu la
kiem tra dung hinh dang request (model/system/messages/headers/base URL) va
dung viec parse response - khong kiem tra chat luong tra loi thuc te cua model
nao (dieu do khong test duoc offline va khong nen test bang tien that).
"""
import json
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import llm_client  # noqa: E402
from llm_providers import (  # noqa: E402
    anthropic_provider, deepseek_provider, gateway_provider, gemini_provider,
)


SAMPLE_MESSAGES = [{"role": "user", "content": "Xin chào"}]


# --------------------------------------------------------------------- fakes

class _FakeAnthropicMessages:
    def __init__(self, text):
        self.text = text
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        block = types.SimpleNamespace(type="text", text=self.text)
        return types.SimpleNamespace(content=[block])


class _FakeAnthropicClient:
    def __init__(self, text="OK từ Claude"):
        self.messages = _FakeAnthropicMessages(text)


class _FakeGeminiModels:
    def __init__(self, text):
        self.text = text
        self.calls = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        return types.SimpleNamespace(text=self.text)


class _FakeGeminiClient:
    def __init__(self, text="OK từ Gemini"):
        self.models = _FakeGeminiModels(text)


class _FakeHTTPResponse:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._data


class _FakeOpener:
    def __init__(self, payload=None, error=None):
        self.payload = payload if payload is not None else {
            "choices": [{"message": {"content": "OK từ cổng"}}]
        }
        self.error = error
        self.requests = []

    def urlopen(self, req, timeout=None):
        self.requests.append(req)
        if self.error:
            raise self.error
        return _FakeHTTPResponse(self.payload)


# --------------------------------------------------------------------- tests

class AnthropicProviderTests(unittest.TestCase):
    def test_send_returns_text_and_passes_model_system_messages(self):
        client = _FakeAnthropicClient("Câu trả lời")
        result = anthropic_provider.send(
            "sk-test", "claude-sonnet-5", "Bạn là trợ lý.", SAMPLE_MESSAGES, client=client
        )
        self.assertEqual(result, "Câu trả lời")
        call = client.messages.calls[0]
        self.assertEqual(call["model"], "claude-sonnet-5")
        self.assertEqual(call["system"], "Bạn là trợ lý.")
        self.assertEqual(call["messages"], [{"role": "user", "content": "Xin chào"}])

    def test_missing_api_key_raises(self):
        with self.assertRaises(ValueError):
            anthropic_provider.send("", "claude-sonnet-5", "", SAMPLE_MESSAGES, client=_FakeAnthropicClient())

    def test_missing_model_raises(self):
        with self.assertRaises(ValueError):
            anthropic_provider.send("sk-test", "", "", SAMPLE_MESSAGES, client=_FakeAnthropicClient())

    def test_empty_response_raises(self):
        with self.assertRaises(RuntimeError):
            anthropic_provider.send(
                "sk-test", "claude-sonnet-5", "", SAMPLE_MESSAGES, client=_FakeAnthropicClient("")
            )


class GeminiProviderTests(unittest.TestCase):
    def test_send_returns_text(self):
        client = _FakeGeminiClient("Câu trả lời Gemini")
        result = gemini_provider.send(
            "gm-test", "gemini-2.5-flash", "Bạn là trợ lý.", SAMPLE_MESSAGES, client=client
        )
        self.assertEqual(result, "Câu trả lời Gemini")
        call = client.models.calls[0]
        self.assertEqual(call["model"], "gemini-2.5-flash")

    def test_assistant_role_maps_to_model(self):
        client = _FakeGeminiClient("ok")
        history = [
            {"role": "user", "content": "Câu 1"},
            {"role": "assistant", "content": "Trả lời 1"},
            {"role": "user", "content": "Câu 2"},
        ]
        gemini_provider.send("gm-test", "gemini-2.5-flash", "", history, client=client)
        contents = client.models.calls[0]["contents"]
        self.assertEqual([c["role"] for c in contents], ["user", "model", "user"])

    def test_missing_api_key_raises(self):
        with self.assertRaises(ValueError):
            gemini_provider.send("", "gemini-2.5-flash", "", SAMPLE_MESSAGES, client=_FakeGeminiClient())

    def test_empty_response_raises(self):
        with self.assertRaises(RuntimeError):
            gemini_provider.send(
                "gm-test", "gemini-2.5-flash", "", SAMPLE_MESSAGES, client=_FakeGeminiClient("")
            )


class DeepseekProviderTests(unittest.TestCase):
    def test_send_posts_to_default_base_url_with_bearer_auth(self):
        opener = _FakeOpener()
        result = deepseek_provider.send(
            "ds-test", "deepseek-chat", "hệ thống", SAMPLE_MESSAGES, opener=opener
        )
        self.assertEqual(result, "OK từ cổng")
        req = opener.requests[0]
        self.assertEqual(req.full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(req.get_header("Authorization"), "Bearer ds-test")
        # UA giống trình duyệt thật - tránh bị Cloudflare/WAF chặn theo "browser
        # signature" (lỗi 1010) trước khi request chạm tới cổng phía sau.
        self.assertIn("Mozilla", req.get_header("User-agent"))
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["model"], "deepseek-chat")
        self.assertEqual(body["messages"][0], {"role": "system", "content": "hệ thống"})

    def test_custom_base_url_overrides_default(self):
        opener = _FakeOpener()
        deepseek_provider.send(
            "ds-test", "deepseek-chat", "", SAMPLE_MESSAGES,
            base_url="https://proxy.internal/deepseek", opener=opener,
        )
        self.assertEqual(opener.requests[0].full_url, "https://proxy.internal/deepseek/chat/completions")

    def test_missing_api_key_raises(self):
        with self.assertRaises(ValueError):
            deepseek_provider.send("", "deepseek-chat", "", SAMPLE_MESSAGES, opener=_FakeOpener())

    def test_http_error_is_wrapped(self):
        import io
        import urllib.error
        error = urllib.error.HTTPError(
            "https://api.deepseek.com/chat/completions", 401,
            "Unauthorized", {}, io.BytesIO(b'{"error":"bad key"}')
        )
        opener = _FakeOpener(error=error)
        with self.assertRaises(RuntimeError) as ctx:
            deepseek_provider.send("bad-key", "deepseek-chat", "", SAMPLE_MESSAGES, opener=opener)
        self.assertIn("401", str(ctx.exception))


class GatewayProviderTests(unittest.TestCase):
    def test_requires_base_url(self):
        with self.assertRaises(ValueError):
            gateway_provider.send("k", "kr/claude-sonnet-4.5", "", SAMPLE_MESSAGES, opener=_FakeOpener())

    def test_send_posts_to_configured_base_url(self):
        opener = _FakeOpener()
        result = gateway_provider.send(
            "k", "kr/claude-sonnet-4.5", "", SAMPLE_MESSAGES,
            base_url="http://localhost:20128/v1", opener=opener,
        )
        self.assertEqual(result, "OK từ cổng")
        self.assertEqual(opener.requests[0].full_url, "http://localhost:20128/v1/chat/completions")

    def test_does_not_duplicate_chat_completions_suffix(self):
        opener = _FakeOpener()
        gateway_provider.send(
            "k", "m", "", SAMPLE_MESSAGES,
            base_url="https://openrouter.ai/api/v1/chat/completions", opener=opener,
        )
        self.assertEqual(opener.requests[0].full_url, "https://openrouter.ai/api/v1/chat/completions")


class LlmClientDispatchTests(unittest.TestCase):
    def test_send_for_feature_routes_to_configured_provider(self):
        fake_module = types.SimpleNamespace(
            send=lambda **kwargs: "trả lời giả" if kwargs["model"] == "m1" else "SAI"
        )
        original = llm_client.PROVIDERS.get("anthropic")
        llm_client.PROVIDERS["anthropic"] = fake_module
        try:
            result = llm_client.send_for_feature(
                {"provider": "anthropic", "apiKey": "k", "model": "m1", "baseUrl": None},
                "summary",
                SAMPLE_MESSAGES,
            )
        finally:
            llm_client.PROVIDERS["anthropic"] = original
        self.assertEqual(result["text"], "trả lời giả")
        self.assertEqual(result["provider"], "anthropic")
        self.assertEqual(result["presentation"]["summary"], "trả lời giả")

    def test_visual_json_contract_is_parsed_without_trusting_html(self):
        payload = {
            "title": "Tổng quan",
            "summary": "Trong phạm vi lọc",
            "blocks": [{"type": "chart", "labels": ["A"], "values": [12]}],
        }
        parsed = llm_client._structured_presentation(json.dumps(payload, ensure_ascii=False))
        self.assertEqual(parsed["title"], "Tổng quan")
        self.assertEqual(parsed["blocks"][0]["type"], "chart")

    def test_markdown_fallback_is_structured_for_chat_ui(self):
        text = (
            "### Phân tích AI\n"
            "**Chưa đủ dữ liệu để kết luận causal root cause** do bảng mã lỗi.\n\n"
            "### 1. Gateway cần chú ý\n"
            "* Digi_bk có 63 cuộc Fail.\n"
            "* vcc cần kiểm tra logic phân loại.\n\n"
            "| Gateway | Fail |\n"
            "| --- | ---: |\n"
            "| Digi_bk | 63 |\n"
        )
        parsed = llm_client._structured_presentation(text)
        self.assertEqual(parsed["title"], "Phân tích AI")
        self.assertNotIn("**", parsed["summary"])
        self.assertEqual(parsed["blocks"][0]["type"], "section")
        self.assertEqual(parsed["blocks"][0]["title"], "1. Gateway cần chú ý")
        self.assertEqual(parsed["blocks"][0]["bullets"][0], "Digi_bk có 63 cuộc Fail.")
        self.assertEqual(parsed["blocks"][1]["type"], "table")

    def test_unknown_provider_raises_not_configured(self):
        with self.assertRaises(llm_client.LlmNotConfiguredError):
            llm_client.send_for_feature(
                {"provider": "", "apiKey": "", "model": ""}, "summary", SAMPLE_MESSAGES
            )

    def test_every_mode_has_a_system_prompt_mentioning_discipline(self):
        for mode in ("summary", "explain", "chat", "risk_report"):
            prompt = llm_client.SYSTEM_PROMPTS[mode]
            self.assertIn("Chỉ dùng số liệu", prompt)
        for mode in ("summary", "explain", "chat"):
            self.assertIn('"type":"table"', llm_client.SYSTEM_PROMPTS[mode])
            self.assertIn('"type":"section"', llm_client.SYSTEM_PROMPTS[mode])
            self.assertIn("FILTER_SCOPE", llm_client.SYSTEM_PROMPTS[mode])
            self.assertIn("KHÔNG phải mẫu báo cáo cố định", llm_client.SYSTEM_PROMPTS[mode])


if __name__ == "__main__":
    unittest.main()
