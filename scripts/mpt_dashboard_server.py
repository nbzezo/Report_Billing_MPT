#!/usr/bin/env python3
import argparse
import base64
import csv
import ctypes
import json
import io
import mimetypes
import os
import posixpath
import re
import sys
import uuid
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import date, datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from http.cookiejar import CookieJar
from pathlib import Path
from threading import Lock
from time import monotonic

sys.path.insert(0, str(Path(__file__).resolve().parent))
import routing_events  # noqa: E402  (can sys.path o tren de chay ca khi import truc tiep)
import gateway_map  # noqa: E402
import llm_client  # noqa: E402
import call_store  # noqa: E402


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_byte))]


class SecretProtector:
    """Encrypt saved passwords with a keyfile that travels with the app folder.

    The portable build is copied between machines as a plain folder, so a secret
    can no longer be tied to one Windows install through DPAPI. Instead a random
    32-byte key lives next to ``profiles.json`` (``config/secret.key``) and is
    used with AES-256-GCM. Anyone who can read the folder can therefore read the
    passwords - a deliberate trade-off for "copy the folder and it runs".

    Legacy ``dpapi:`` / ``dpapi-machine:`` values are still decrypted (only on
    the machine that wrote them) so older profiles migrate on first launch.
    """

    PREFIX = "portable-gcm:"
    LEGACY_PREFIXES = ("dpapi-machine:", "dpapi:")
    KEY_BYTES = 32

    def __init__(self, key_path):
        self.key_path = Path(key_path)
        self._key = None

    # -- keyfile -----------------------------------------------------------
    def _key_material(self, create=False):
        if self._key is None:
            if self.key_path.exists():
                key = base64.b64decode(self.key_path.read_text(encoding="ascii").strip())
                if len(key) != self.KEY_BYTES:
                    raise RuntimeError("config/secret.key không hợp lệ (cần 32 byte).")
                self._key = key
            elif create:
                self._key = os.urandom(self.KEY_BYTES)
                self.key_path.parent.mkdir(parents=True, exist_ok=True)
                self.key_path.write_text(
                    base64.b64encode(self._key).decode("ascii"), encoding="ascii"
                )
                self._lock_down(self.key_path)
            else:
                raise RuntimeError("Thiếu config/secret.key để giải mã mật khẩu đã lưu.")
        return self._key

    @staticmethod
    def _lock_down(path):
        """Best-effort: chỉ tài khoản hiện tại đọc được keyfile."""
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    # -- API -------------------------------------------------------------------
    def protect(self, value):
        if not value:
            return ""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        nonce = os.urandom(12)
        blob = AESGCM(self._key_material(create=True)).encrypt(
            nonce, value.encode("utf-8"), None
        )
        return self.PREFIX + base64.b64encode(nonce + blob).decode("ascii")

    def unprotect(self, value):
        if not value:
            return ""
        if value.startswith(self.PREFIX):
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM

            raw = base64.b64decode(value[len(self.PREFIX):])
            return (
                AESGCM(self._key_material())
                .decrypt(raw[:12], raw[12:], None)
                .decode("utf-8")
            )
        for prefix in self.LEGACY_PREFIXES:
            if value.startswith(prefix):
                return self._dpapi_unprotect(value[len(prefix):])
        return value

    # -- legacy DPAPI (read-only, original machine only) ----------------------
    @staticmethod
    def _blob(data):
        buffer = ctypes.create_string_buffer(data)
        blob = _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
        return blob, buffer

    def _dpapi_unprotect(self, encoded):
        if os.name != "nt":
            raise RuntimeError("Không thể đọc mật khẩu DPAPI bên ngoài Windows.")
        ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        ctypes.windll.kernel32.LocalFree.restype = ctypes.c_void_p
        source, _buffer = self._blob(base64.b64decode(encoded))
        output = _DataBlob()
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(source), None, None, None, None, 0x01, ctypes.byref(output)
        )
        if not ok:
            raise ctypes.WinError()
        try:
            return ctypes.string_at(output.pbData, output.cbData).decode("utf-8")
        finally:
            ctypes.windll.kernel32.LocalFree(output.pbData)


DEFAULT_DOMAINS = [
    "https://customer-billing.mpt.com.vn",
    "https://customer-omihub1.mpt.com.vn",
    "https://customer-billing01.mpt.com.vn",
]
EXPORT_CACHE_TTL_SECONDS = 10 * 60
EXPORT_CACHE_MAX_ITEMS = 8
EXPORT_PROGRESS_TTL_SECONDS = 15 * 60
RISK_ANALYSIS_CACHE_TTL_SECONDS = 10 * 60
RISK_ANALYSIS_CACHE_MAX_ITEMS = 8
# ~250K token: lưới an toàn phía server, trên mức client tự cắt (400K ký tự).
LLM_ASK_MAX_CHARS = 800_000


def normalize_domain(value):
    value = (value or "").strip()
    if not value:
        return ""
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    parsed = urllib.parse.urlparse(value)
    if not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


class ProfileStore:
    def __init__(self, root):
        self.root = Path(root)
        self.config_dir = self.root / "config"
        self.path = self.config_dir / "profiles.json"
        self.secrets = SecretProtector(self.config_dir / "secret.key")
        self._migrate_plaintext_passwords()
        self._migrate_legacy_encryption()

    def _read_raw(self):
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return []
        return data.get("profiles", []) if isinstance(data, dict) else []

    def load(self):
        profiles = self._read_raw()
        for profile in profiles:
            protected = profile.get("passwordEncrypted", "")
            if protected:
                try:
                    profile["password"] = self.secrets.unprotect(protected)
                except Exception:
                    profile["password"] = ""
                    profile["credentialError"] = True
        return profiles

    def save_all(self, profiles):
        self.config_dir.mkdir(parents=True, exist_ok=True)
        safe_profiles = []
        for profile in profiles:
            item = dict(profile)
            password = item.pop("password", "")
            protected = item.pop("passwordEncrypted", "")
            item["passwordEncrypted"] = self.secrets.protect(password) if password else protected
            safe_profiles.append(item)
        self.path.write_text(
            json.dumps({"profiles": safe_profiles}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _migrate_plaintext_passwords(self):
        profiles = self._read_raw()
        if any("password" in profile for profile in profiles):
            self.save_all(profiles)

    def _migrate_legacy_encryption(self):
        profiles = self._read_raw()
        changed = False
        for profile in profiles:
            protected = profile.get("passwordEncrypted", "")
            if not protected.startswith(self.secrets.LEGACY_PREFIXES):
                continue
            try:
                profile["password"] = self.secrets.unprotect(protected)
                changed = True
            except Exception:
                continue
        if changed:
            self.save_all(profiles)

    def public_profiles(self):
        return [
            {
                "id": p.get("id"),
                "name": p.get("name") or f"{p.get('username')} @ {p.get('domain')}",
                "domain": p.get("domain"),
                "username": p.get("username"),
                "accountCount": len(p.get("accounts") or []),
                "credentialAvailable": not p.get("credentialError"),
                "lastVerifiedAt": p.get("lastVerifiedAt"),
            }
            for p in self.load()
        ]

    def get(self, profile_id):
        for profile in self.load():
            if profile.get("id") == profile_id:
                return profile
        return None

    def upsert(self, payload):
        profiles = self.load()
        domain = normalize_domain(payload.get("domain"))
        username = (payload.get("username") or "").strip()
        profile_id = payload.get("id") or str(uuid.uuid4())
        existing = next((p for p in profiles if p.get("id") == profile_id), None)
        password = payload.get("password") or (existing or {}).get("password", "")
        if not domain or not username or not password:
            raise ValueError("Cần có domain, tên đăng nhập và mật khẩu.")
        name = (payload.get("name") or f"{username} @ {urllib.parse.urlparse(domain).netloc}").strip()
        item = {
            "id": profile_id,
            "name": name,
            "domain": domain,
            "username": username,
            "password": password,
            "accounts": (existing or {}).get("accounts", []),
            "lastVerifiedAt": (existing or {}).get("lastVerifiedAt"),
        }
        profiles = [p for p in profiles if p.get("id") != profile_id]
        profiles.append(item)
        self.save_all(profiles)
        return {k: item[k] for k in ("id", "name", "domain", "username")}

    def delete(self, profile_id):
        profiles = self.load()
        updated = [p for p in profiles if p.get("id") != profile_id]
        self.save_all(updated)
        return len(updated) != len(profiles)

    def update_accounts(self, profile_id, accounts):
        profiles = self.load()
        changed = False
        for profile in profiles:
            if profile.get("id") == profile_id:
                profile["accounts"] = accounts
                profile["lastVerifiedAt"] = datetime.now().astimezone().isoformat(
                    timespec="seconds"
                )
                changed = True
                break
        if changed:
            self.save_all(profiles)


class LlmConfigStore:
    """Cau hinh AI toan app (khong theo tung profile MPT - API key AI la
    credential rieng, doc lap tai khoan MPT dang xem): config/llm_config.json.

    4 provider doc lap (anthropic/gemini/deepseek/gateway), moi provider 1 API
    key rieng ma hoa bang CHUNG 1 SecretProtector/secret.key voi mat khau MPT
    (cung thu muc config/, cung trust boundary - xem SecretProtector ở trên).
    4 tinh nang (summary/explain/chat/riskReport) bat/tat rieng, moi tinh nang
    co the ghi de provider rieng (None = dung activeProvider).
    """

    PROVIDER_KEYS = ("anthropic", "gemini", "deepseek", "gateway")
    FEATURE_KEYS = ("summary", "explain", "chat", "riskReport")
    DEFAULT_BASE_URL = {
        "deepseek": "https://api.deepseek.com",
        "gateway": "http://localhost:20128/v1",
    }

    def __init__(self, root):
        self.root = Path(root)
        self.config_dir = self.root / "config"
        self.path = self.config_dir / "llm_config.json"
        self.secrets = SecretProtector(self.config_dir / "secret.key")

    def _default(self):
        providers = {}
        for key in self.PROVIDER_KEYS:
            item = {"apiKeyEncrypted": "", "model": ""}
            if key in self.DEFAULT_BASE_URL:
                item["baseUrl"] = self.DEFAULT_BASE_URL[key]
            providers[key] = item
        features = {key: {"enabled": True, "provider": None} for key in self.FEATURE_KEYS}
        return {"activeProvider": "", "providers": providers, "features": features}

    def _read_raw(self):
        merged = self._default()
        if not self.path.exists():
            return merged
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return merged
        if not isinstance(data, dict):
            return merged
        if data.get("activeProvider") in self.PROVIDER_KEYS:
            merged["activeProvider"] = data["activeProvider"]
        for key in self.PROVIDER_KEYS:
            merged["providers"][key].update((data.get("providers") or {}).get(key) or {})
        for key in self.FEATURE_KEYS:
            merged["features"][key].update((data.get("features") or {}).get(key) or {})
        return merged

    def _write_raw(self, data):
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def public_status(self):
        """Trạng thái an toàn trả cho client - KHÔNG bao giờ chứa API key thật."""
        raw = self._read_raw()
        providers = {}
        for key, item in raw["providers"].items():
            entry = {"hasApiKey": bool(item.get("apiKeyEncrypted")),
                      "model": item.get("model", "")}
            if "baseUrl" in item:
                entry["baseUrl"] = item.get("baseUrl", "")
            providers[key] = entry
        return {
            "activeProvider": raw["activeProvider"],
            "providers": providers,
            "features": raw["features"],
        }

    def save(self, payload):
        raw = self._read_raw()
        active = payload.get("activeProvider")
        if active in self.PROVIDER_KEYS:
            raw["activeProvider"] = active
        for key, incoming in (payload.get("providers") or {}).items():
            if key not in self.PROVIDER_KEYS or not isinstance(incoming, dict):
                continue
            current = raw["providers"][key]
            api_key = (incoming.get("apiKey") or "").strip()
            if api_key:
                current["apiKeyEncrypted"] = self.secrets.protect(api_key)
            elif incoming.get("clearApiKey"):
                current["apiKeyEncrypted"] = ""
            if "model" in incoming:
                current["model"] = (incoming.get("model") or "").strip()
            if "baseUrl" in incoming and key in self.DEFAULT_BASE_URL:
                current["baseUrl"] = (
                    (incoming.get("baseUrl") or "").strip() or self.DEFAULT_BASE_URL[key]
                )
        for key, incoming in (payload.get("features") or {}).items():
            if key not in self.FEATURE_KEYS or not isinstance(incoming, dict):
                continue
            current = raw["features"][key]
            if "enabled" in incoming:
                current["enabled"] = bool(incoming["enabled"])
            if "provider" in incoming:
                provider = incoming.get("provider")
                current["provider"] = provider if provider in self.PROVIDER_KEYS else None
        self._write_raw(raw)
        return self.public_status()

    def resolve(self, feature_key):
        """{"provider","apiKey","model","baseUrl"} đã giải mã, sẵn sàng truyền
        thẳng cho llm_client.send_for_feature(); None nếu tính năng đang tắt
        hoặc chưa cấu hình đủ (thiếu key/model) - gọi nơi dùng phải coi đó là
        "chưa sẵn sàng", không phải lỗi."""
        raw = self._read_raw()
        feature = raw["features"].get(feature_key)
        if not feature or not feature.get("enabled"):
            return None
        provider_key = feature.get("provider") or raw["activeProvider"]
        if provider_key not in self.PROVIDER_KEYS:
            return None
        item = raw["providers"].get(provider_key) or {}
        api_key = self.secrets.unprotect(item.get("apiKeyEncrypted", ""))
        if not api_key or not item.get("model"):
            return None
        return {
            "provider": provider_key,
            "apiKey": api_key,
            "model": item.get("model", ""),
            "baseUrl": item.get("baseUrl"),
        }

    def resolve_provider(self, provider_key):
        """Như resolve() nhưng theo đúng 1 provider cụ thể, bỏ qua feature - dùng
        cho nút "Kiểm tra kết nối" khi ô API key/model để trống (giữ giá trị đã
        lưu) trong lúc test."""
        if provider_key not in self.PROVIDER_KEYS:
            return None
        raw = self._read_raw()
        item = raw["providers"].get(provider_key) or {}
        api_key = self.secrets.unprotect(item.get("apiKeyEncrypted", ""))
        return {
            "provider": provider_key,
            "apiKey": api_key,
            "model": item.get("model", ""),
            "baseUrl": item.get("baseUrl"),
        }


class MptAuthenticationError(RuntimeError):
    pass


class MptClient:
    def __init__(self, domain, username, password):
        self.base_url = normalize_domain(domain)
        self.username = username
        self.password = password
        self.cookie_jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar)
        )
        self.logged_in = False

    @staticmethod
    def _is_login_page(response, data):
        """MPT often reports an expired/invalid session as HTTP 200 HTML."""
        content_type = (response.headers.get("Content-Type", "") or "").lower()
        if "html" not in content_type:
            return False
        body = (data or b"").lower()
        path = urllib.parse.urlparse(response.geturl()).path.rstrip("/").lower()
        return (
            b"username_softswitch" in body
            or b"password_softswitch" in body
            or path == "/user"
        )

    def _invalidate_session(self):
        self.logged_in = False
        try:
            self.cookie_jar.clear()
        except KeyError:
            pass

    def post_multipart(self, url, fields):
        boundary = "----mptdashboardboundary"
        body = bytearray()
        for name, value in fields.items():
            body.extend(f"--{boundary}\r\n".encode())
            body.extend(
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            )
            body.extend(str(value or "").encode())
            body.extend(b"\r\n")
        body.extend(f"--{boundary}--\r\n".encode())
        req = urllib.request.Request(url, data=bytes(body), method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        req.add_header("User-Agent", "Mozilla/5.0 MPT Dashboard Local")
        return self.opener.open(req, timeout=120)

    def login(self, force=False):
        if self.logged_in:
            if not force:
                return
            self._invalidate_session()
        res = self.post_multipart(
            f"{self.base_url}/user/checkAuthen",
            {
                "username_softswitch": self.username,
                "password_softswitch": self.password,
            },
        )
        data = res.read()
        if self._is_login_page(res, data):
            self._invalidate_session()
            raise MptAuthenticationError(
                "Thông tin đăng nhập MPT không hợp lệ hoặc đã hết hạn. "
                "Hãy nhập lại mật khẩu và lưu kết nối."
            )
        self.logged_in = True

    def get_accounts(self):
        html = ""
        for attempt in range(2):
            self.login()
            req = urllib.request.Request(f"{self.base_url}/calldata/filter")
            req.add_header("User-Agent", "Mozilla/5.0 MPT Dashboard Local")
            res = self.opener.open(req, timeout=30)
            data = res.read()
            if self._is_login_page(res, data):
                self._invalidate_session()
                if attempt == 0:
                    continue
                raise MptAuthenticationError(
                    "Phiên đăng nhập MPT đã hết hạn và không thể đăng nhập lại. "
                    "Hãy nhập lại mật khẩu và lưu kết nối."
                )
            html = data.decode("utf-8", errors="replace")
            break
        accounts = []
        # Extract only the <select name="account_id"> block
        m = re.search(
            r'<select[^>]*name="account_id"[^>]*>(.*?)</select>',
            html, re.DOTALL
        )
        if not m:
            raise RuntimeError(
                "MPT không trả về danh sách tài khoản hợp lệ. "
                "Danh sách tài khoản đã lưu được giữ nguyên."
            )
        block = m.group(1)
        for opt in re.finditer(
            r'<option\s+value="(\d+)"[^>]*>([^<]+)</option>', block
        ):
            aid, name = opt.group(1), opt.group(2).strip()
            if aid == "0":
                continue
            accounts.append({"id": aid, "name": name})
        return accounts

    def export_csv(self, params):
        fields = {
            "account_id": params.get("account_id", "0"),
            "caller_number": params.get("caller_number", ""),
            "dest_number": params.get("dest_number", ""),
            "outbound": params.get("outbound", ""),
            "from_day": params.get("from_day", ""),
            "to_day": params.get("to_day", ""),
            "hangupcause": params.get("hangupcause", "0"),
            "calltype": params.get("calltype", ""),
            "telco": params.get("telco", "0"),
        }
        for attempt in range(2):
            self.login()
            filter_res = self.post_multipart(
                f"{self.base_url}/calldata/filter", fields
            )
            filter_data = filter_res.read()
            if self._is_login_page(filter_res, filter_data):
                self._invalidate_session()
                if attempt == 0:
                    continue
                raise MptAuthenticationError(
                    "Phiên đăng nhập MPT đã hết hạn và không thể đăng nhập lại. "
                    "Hãy nhập lại mật khẩu và lưu kết nối."
                )

            req = urllib.request.Request(f"{self.base_url}/calldata/export")
            req.add_header("User-Agent", "Mozilla/5.0 MPT Dashboard Local")
            res = self.opener.open(req, timeout=120)
            content_type = res.headers.get("Content-Type", "")
            data = res.read()
            if "text/csv" in content_type.lower():
                return data
            if self._is_login_page(res, data):
                self._invalidate_session()
                if attempt == 0:
                    continue
                raise MptAuthenticationError(
                    "Phiên đăng nhập MPT đã hết hạn và không thể đăng nhập lại. "
                    "Hãy nhập lại mật khẩu và lưu kết nối."
                )
            raise RuntimeError(
                "MPT không trả về CSV. Hãy kiểm tra bộ lọc và thử lại."
            )

        raise MptAuthenticationError(
            "Không thể khôi phục phiên đăng nhập MPT. Hãy nhập lại mật khẩu."
        )


def is_allowed_static_path(path, dashboard):
    return path in {
        f"/{dashboard}",
        "/mpt_filter.html",
        "/dashboard-core.js",
        "/dashboard-csv-worker.js",
        "/vendor/plotly-2.24.2.min.js",
        "/vendor/UbuntuSans-variable.woff2",
        "/vendor/NotoSans-vietnamese.woff2",
        "/favicon.ico",
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "MPTDashboard/2.0"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/":
            self.path = f"/{self.server.dashboard}"
            super().do_GET()
            return
        if parsed.path == "/api/profiles":
            self.handle_profiles()
            return
        if parsed.path == "/api/accounts":
            self.handle_accounts(parsed)
            return
        if parsed.path == "/api/calldata.csv":
            self.handle_calldata(parsed)
            return
        if parsed.path == "/api/data-status":
            self.handle_data_status(parsed)
            return
        if parsed.path == "/api/export-progress":
            self.handle_export_progress(parsed)
            return
        if parsed.path == "/api/cid-events":
            self.handle_cid_events(parsed)
            return
        if parsed.path == "/api/gateway-map":
            self.handle_gateway_map_get(parsed)
            return
        if parsed.path == "/api/gateway-cids":
            self.handle_gateway_cids(parsed)
            return
        if parsed.path == "/api/gateway-sync":
            self.handle_gateway_sync(parsed)
            return
        if parsed.path == "/api/gateway-automap":
            self.handle_gateway_automap(parsed)
            return
        if parsed.path == "/api/llm-config":
            self.handle_llm_config_get()
            return
        if parsed.path == "/dashboard":
            self.handle_dashboard(parsed)
            return

        if not is_allowed_static_path(parsed.path, self.server.dashboard):
            self.send_error(404)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/profiles":
            self.handle_save_profile()
            return
        if parsed.path == "/api/accounts":
            self.handle_accounts_post()
            return
        if parsed.path == "/api/clientlog":
            self.handle_client_log()
            return
        if parsed.path == "/api/gateway-map":
            self.handle_gateway_map_post()
            return
        if parsed.path == "/api/llm-config":
            self.handle_llm_config_post()
            return
        if parsed.path == "/api/llm-config/test":
            self.handle_llm_config_test()
            return
        if parsed.path == "/api/llm-ask":
            self.handle_llm_ask()
            return
        if parsed.path == "/api/risk-analysis":
            self.handle_risk_analysis()
            return
        if parsed.path == "/api/db-compact":
            self.handle_db_compact()
            return
        self.send_error(404)

    def handle_db_compact(self):
        try:
            self.json_response(self.server.call_store.compact())
        except Exception as exc:
            self.error_response(exc)

    def handle_client_log(self):
        """Beacon lỗi JS từ cửa sổ native (không có DevTools) -> in ra stderr."""
        try:
            body = self.read_json_body()
        except Exception:
            body = {}
        msg = str(body.get("message", ""))[:2000]
        where = str(body.get("where", ""))[:400]
        print(f"[CLIENT] {body.get('kind', 'log')}: {msg} @ {where}",
              file=__import__("sys").stderr, flush=True)
        self.send_response(204)
        self.end_headers()

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/profiles":
            self.handle_delete_profile(parsed)
            return
        self.send_error(404)

    def json_response(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def error_response(self, exc, status=502):
        raw = str(exc)
        if isinstance(exc, urllib.error.HTTPError) and exc.code in (401, 403):
            message = "Đăng nhập MPT không hợp lệ hoặc phiên đã hết hạn."
        elif isinstance(exc, (TimeoutError, urllib.error.URLError)):
            message = "Không kết nối được MPT. Hãy kiểm tra mạng và thử lại."
        elif raw:
            message = raw
        else:
            message = "Không thể xử lý yêu cầu. Vui lòng thử lại."
        self.json_response({"error": message}, status)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def get_client(self, profile_id):
        profile = self.server.profile_store.get(profile_id)
        if not profile:
            raise ValueError("Không tìm thấy kết nối. Hãy chọn hoặc thêm kết nối trước.")
        if not profile.get("password"):
            raise ValueError("Không giải mã được mật khẩu đã lưu. Hãy nhập lại mật khẩu và bấm Lưu kết nối.")
        key = profile.get("id")
        client = self.server.clients.get(key)
        if not client:
            client = MptClient(profile.get("domain"), profile.get("username"), profile.get("password"))
            self.server.clients[key] = client
        return client

    def get_export_client(self, profile_id):
        profile = self.server.profile_store.get(profile_id)
        if not profile:
            raise ValueError("Không tìm thấy kết nối. Hãy chọn hoặc thêm kết nối trước.")
        if not profile.get("password"):
            raise ValueError("Không giải mã được mật khẩu đã lưu. Hãy nhập lại mật khẩu và bấm Lưu kết nối.")
        # MPT retains the previous filter in the session, so report exports
        # must never reuse the long-lived client used to load account lists.
        return MptClient(profile.get("domain"), profile.get("username"), profile.get("password"))

    def get_profile_sync_lock(self, profile_id):
        """Return the one export lock shared by all requests for a profile."""
        with self.server.profile_sync_locks_lock:
            lock = self.server.profile_sync_locks.get(profile_id)
            if lock is None:
                lock = Lock()
                self.server.profile_sync_locks[profile_id] = lock
            return lock

    def get_cached_export(self, params):
        key = json.dumps(params, sort_keys=True, separators=(",", ":"))
        with self.server.export_cache_lock:
            item = self.server.export_cache.get(key)
            if not item:
                return None
            created, data = item
            if monotonic() - created > EXPORT_CACHE_TTL_SECONDS:
                del self.server.export_cache[key]
                return None
            self.server.export_cache.move_to_end(key)
            return data

    def cache_export(self, params, data):
        key = json.dumps(params, sort_keys=True, separators=(",", ":"))
        with self.server.export_cache_lock:
            self.server.export_cache[key] = (monotonic(), data)
            self.server.export_cache.move_to_end(key)
            while len(self.server.export_cache) > EXPORT_CACHE_MAX_ITEMS:
                self.server.export_cache.popitem(last=False)

    def clear_export_cache(self):
        with self.server.export_cache_lock:
            self.server.export_cache.clear()

    def set_export_progress(self, job_id, done, total, current=""):
        """Publish sequential-export progress so the dashboard can show 7/40."""
        if not job_id:
            return
        now = monotonic()
        with self.server.export_progress_lock:
            self.server.export_progress[job_id] = {
                "done": done,
                "total": total,
                "current": current,
                "updated": now,
            }
            stale = [
                key
                for key, item in self.server.export_progress.items()
                if now - item["updated"] > EXPORT_PROGRESS_TTL_SECONDS
            ]
            for key in stale:
                del self.server.export_progress[key]

    def handle_export_progress(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        job_id = query.get("job", [""])[-1]
        with self.server.export_progress_lock:
            item = self.server.export_progress.get(job_id)
        if not item:
            self.json_response({})
            return
        self.json_response(
            {"done": item["done"], "total": item["total"], "current": item["current"]}
        )

    def handle_profiles(self):
        self.json_response(
            {
                "profiles": self.server.profile_store.public_profiles(),
                "defaultDomains": DEFAULT_DOMAINS,
                "storagePath": "Mat khau duoc ma hoa cuc bo bang Windows DPAPI",
            }
        )

    def handle_save_profile(self):
        try:
            payload = self.read_json_body()
            existing = self.server.profile_store.get(payload.get("id", "")) or {}
            domain = normalize_domain(payload.get("domain"))
            username = (payload.get("username") or "").strip()
            password = payload.get("password") or existing.get("password", "")
            if not domain or not username or not password:
                raise ValueError("Cần có domain, tên đăng nhập và mật khẩu.")

            # Chỉ ghi cấu hình sau khi MPT đã xác thực và trả về đúng trang
            # danh sách tài khoản. Nhờ vậy mật khẩu sai không thể biến một kết
            # nối đang dùng được thành hồ sơ lỗi hoặc xóa cache account cũ.
            accounts = MptClient(domain, username, password).get_accounts()
            profile = self.server.profile_store.upsert(payload)
            self.server.profile_store.update_accounts(profile["id"], accounts)
            self.server.clients.pop(profile["id"], None)
            self.clear_export_cache()
            self.json_response(profile)
        except Exception as exc:
            self.error_response(exc, 400)

    def handle_delete_profile(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        profile_id = query.get("id", [""])[-1]
        deleted = self.server.profile_store.delete(profile_id)
        self.server.clients.pop(profile_id, None)
        self.clear_export_cache()
        self.json_response({"deleted": deleted})

    def handle_accounts(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        profile_id = query.get("profile_id", [""])[-1]
        try:
            if query.get("cached", ["0"])[-1] == "1":
                profile = self.server.profile_store.get(profile_id)
                if profile and profile.get("accounts"):
                    self.json_response(profile["accounts"])
                    return
            accounts = self.get_client(profile_id).get_accounts()
            self.server.profile_store.update_accounts(profile_id, accounts)
            self.json_response(accounts)
        except Exception as exc:
            self.error_response(exc)

    def handle_accounts_post(self):
        try:
            payload = self.read_json_body()
            profile_id = payload.get("profile_id", "")
            if profile_id:
                client = self.get_client(profile_id)
            else:
                domain = normalize_domain(payload.get("domain"))
                username = (payload.get("username") or "").strip()
                password = payload.get("password") or ""
                if not domain or not username or not password:
                    raise ValueError("Cần domain, tên đăng nhập và mật khẩu để tải tài khoản.")
                client = MptClient(domain, username, password)
            accounts = client.get_accounts()
            if profile_id:
                self.server.profile_store.update_accounts(profile_id, accounts)
            self.json_response(accounts)
        except Exception as exc:
            self.error_response(exc)

    def handle_cid_events(self, parsed):
        """Lich su Block/Reactive CID (nguon: trang MPT `routing/reports`).

        `sync=1` keo bo sung cac ngay con thieu roi moi tra ve; khong co thi doc
        thang tu cache dia (mo dashboard la co ngay, khong phai cho MPT).
        """
        query = urllib.parse.parse_qs(parsed.query)
        profile_id = query.get("profile_id", [""])[-1]
        job_id = query.get("job_id", [""])[-1]
        try:
            days = int(query.get("days", [""])[-1] or routing_events.WINDOW_DAYS)
        except ValueError:
            days = routing_events.WINDOW_DAYS
        days = max(1, min(days, routing_events.WINDOW_DAYS))

        try:
            cache = routing_events.RoutingEventCache(self.server.root, profile_id)
            synced = None
            if query.get("sync", ["0"])[-1] == "1":
                # Client RIENG: sync POST vao /routing/reports, ma MPT giu lai
                # filter trong session -> dung chung se lam hong client dang
                # phuc vu danh sach account.
                synced = routing_events.sync(
                    self.get_export_client(profile_id),
                    cache,
                    days=days,
                    progress=lambda p: self.set_export_progress(
                        job_id, p["done"], p["total"], p["current"]
                    ),
                )
            events, meta = cache.load_window(days=days)
            meta["synced"] = synced
            # Danh sach routing day du (khac tap routing co su kien): can de phan
            # biet "0 block that su" voi "khong quan sat duoc".
            self.json_response({"events": events, "meta": meta,
                                "routings": cache.read_routings()})
        except Exception as exc:
            self.error_response(exc)

    # ------------------------------------------------------------------ Gateway
    # Nguon: trang MPT `routing/cids/<routing_id>` -> nut Export -> .xlsx.
    # MPT khong gan account; nguoi dung gan tay routing_id <-> account_id o giao
    # dien, luu config/gateway-map.json. Dong bo tai .xlsx tung routing roi suy
    # CID -> account mot lan, cache xuong config/.cache/gateway/<profile>/.

    def _gateway_store(self, profile_id):
        return gateway_map.GatewayMapStore(self.server.root, profile_id)

    def handle_gateway_map_get(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        profile_id = query.get("profile_id", [""])[-1]
        try:
            self.json_response(self._gateway_store(profile_id).status())
        except Exception as exc:
            self.error_response(exc)

    def handle_gateway_map_post(self):
        try:
            payload = self.read_json_body()
            profile_id = payload.get("profile_id", "")
            store = self._gateway_store(profile_id)
            store.save_map(payload.get("map") or {})
            store.rebuild_index()   # map doi -> chi muc CID phai theo (dung cache raw san co)
            self.json_response(store.status())
        except Exception as exc:
            self.error_response(exc)

    def handle_gateway_cids(self, parsed):
        """Chi muc CID -> {account_id, routing_id, routing_name, gateway,
        telco_status} cho dashboard join voi caller_id_number."""
        query = urllib.parse.parse_qs(parsed.query)
        profile_id = query.get("profile_id", [""])[-1]
        try:
            idx = self._gateway_store(profile_id).read_index()
            self.json_response({
                "index": idx.get("index", {}),
                "cidCount": idx.get("cidCount", 0),
                "builtAt": idx.get("builtAt"),
                "conflicts": idx.get("conflicts", []),
                "multiAccountRoutings": idx.get("multiAccountRoutings", {}),
            })
        except Exception as exc:
            self.error_response(exc)

    def handle_gateway_sync(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        profile_id = query.get("profile_id", [""])[-1]
        job_id = query.get("job_id", [""])[-1]
        try:
            store = self._gateway_store(profile_id)
            if not store.load_map():
                raise ValueError("Chưa gán routing_id cho account nào. Hãy điền bảng mapping rồi Lưu trước.")
            # Client rieng nhu cid-events: sync GET vao routing/exportCid, tranh
            # dung chung client dang phuc vu danh sach account.
            result = gateway_map.sync(
                self.get_export_client(profile_id),
                store,
                progress=lambda p: self.set_export_progress(
                    job_id, p["done"], p["total"], p["current"]
                ),
            )
            self.json_response(result)
        except Exception as exc:
            self.error_response(exc)

    def handle_gateway_automap(self, parsed):
        """Suy account_id <-> routing_id tu trang MPT `routing/monitoring`
        (ten routing == ten account), gop vao gateway-map.json, roi dong bo CID
        nhu nut "Dong bo Gateway". `sync=0` de bo qua buoc tai CID."""
        query = urllib.parse.parse_qs(parsed.query)
        profile_id = query.get("profile_id", [""])[-1]
        job_id = query.get("job_id", [""])[-1]
        do_sync = query.get("sync", ["1"])[-1] != "0"
        try:
            profile = self.server.profile_store.get(profile_id)
            if not profile:
                raise ValueError("Không tìm thấy kết nối. Hãy chọn kết nối trước.")
            accounts = profile.get("accounts") or []
            if not accounts:
                accounts = self.get_client(profile_id).get_accounts()
                self.server.profile_store.update_accounts(profile_id, accounts)
            store = self._gateway_store(profile_id)
            result = gateway_map.auto_map(
                self.get_export_client(profile_id),
                store,
                accounts,
                do_sync=do_sync,
                progress=lambda p: self.set_export_progress(
                    job_id, p["done"], p["total"], p["current"]
                ),
            )
            result["status"] = store.status()
            self.json_response(result)
        except Exception as exc:
            self.error_response(exc)

    # ------------------------------------------------------------------ LLM
    # Cau hinh + goi 4 provider LLM doc lap (llm_client.py). Opt-in triet de:
    # chua cau hinh/tat feature -> resolve() tra None -> handler bao loi 400
    # ro rang thay vi im lang goi mang.

    def handle_llm_config_get(self):
        self.json_response(self.server.llm_config_store.public_status())

    def handle_llm_config_post(self):
        try:
            status = self.server.llm_config_store.save(self.read_json_body())
            self.json_response(status)
        except Exception as exc:
            self.error_response(exc, 400)

    def handle_llm_config_test(self):
        """apiKey/model/baseUrl rỗng trong payload = dùng lại giá trị đã lưu
        cho đúng provider đó (test sau khi Lưu mà không gõ lại key)."""
        try:
            payload = self.read_json_body()
            provider = payload.get("provider", "")
            if provider not in LlmConfigStore.PROVIDER_KEYS:
                raise ValueError("provider không hợp lệ.")
            api_key = (payload.get("apiKey") or "").strip()
            model = (payload.get("model") or "").strip()
            base_url = payload.get("baseUrl")
            if not api_key or not model or base_url is None:
                saved = self.server.llm_config_store.resolve_provider(provider) or {}
                api_key = api_key or saved.get("apiKey", "")
                model = model or saved.get("model", "")
                if base_url is None:
                    base_url = saved.get("baseUrl")
        except Exception as exc:
            self.error_response(exc, 400)
            return
        try:
            result = llm_client.test_provider(provider, api_key, model, base_url)
        except ValueError as exc:
            # Thiếu key/model/baseUrl — lỗi phía người dùng, chưa hề gọi mạng.
            self.error_response(exc, 400)
            return
        except Exception as exc:
            # Gọi mạng/HTTP thất bại thật sự (key sai, hết hạn, cổng không phản hồi...).
            self.error_response(exc, 502)
            return
        self.json_response(result)

    def handle_llm_ask(self):
        try:
            payload = self.read_json_body()
            mode = payload.get("mode", "")
            if mode not in ("summary", "explain", "chat"):
                raise ValueError("mode không hợp lệ (cần summary/explain/chat).")
            cfg = self.server.llm_config_store.resolve(mode)
            if not cfg:
                raise llm_client.LlmNotConfiguredError(
                    "Tính năng AI này chưa được cấu hình hoặc đang tắt. "
                    "Mở menu ☰ → Cấu hình LLM."
                )
            history = payload.get("history") or []
            messages = []
            for turn in history[-6:]:
                role = turn.get("role") if isinstance(turn, dict) else None
                content = turn.get("content") if isinstance(turn, dict) else None
                if role in ("user", "assistant") and content:
                    messages.append({"role": role, "content": str(content)[:4000]})
            context = payload.get("context")
            scope = payload.get("scope")
            if mode in ("summary", "chat"):
                if not isinstance(context, dict) or not isinstance(context.get("meta"), dict):
                    raise ValueError("Thiếu ngữ cảnh dữ liệu đã lọc.")
                if not isinstance(scope, dict) or not scope.get("appliedFilterKey"):
                    raise ValueError("Thiếu phạm vi bộ lọc đã áp dụng.")
            question = str(payload.get("question", ""))[:2000]
            user_text = (
                "FILTER_SCOPE (JSON, ranh giới bắt buộc của câu trả lời):\n"
                + json.dumps(scope or {}, ensure_ascii=False)
                + "\n\nFILTERED_DATABASE_CONTEXT (toàn bộ miền phân tích của các bản ghi "
                  "nằm trong FILTER_SCOPE; không phải chỉ tab đang mở):\n"
                + json.dumps(context, ensure_ascii=False)
            )
            if question:
                user_text += "\n\nCâu hỏi: " + question
            # Chặn trước khi gọi model: payload quá lớn sẽ bị nhà cung cấp trả
            # HTTP 400 "input token count exceeds…" khó hiểu với người dùng.
            if len(user_text) > LLM_ASK_MAX_CHARS:
                raise ValueError(
                    f"Dữ liệu gửi kèm quá lớn (~{len(user_text) // 3200}K token). "
                    "Hãy thu hẹp bộ lọc (ít ngày/account hơn) rồi hỏi lại."
                )
            messages.append({"role": "user", "content": user_text})
        except Exception as exc:
            self.error_response(exc, 400)
            return
        try:
            result = llm_client.send_for_feature(cfg, mode, messages)
        except Exception as exc:
            self.error_response(exc, 502)
            return
        self.json_response(result)

    # ------------------------------------------------------- Risk analysis
    # Tinh nang 2 (Phase 4): tu dong hoa scripts/risk_engine.py (port cua skill
    # telecom-cid-risk-optimizer) tren du lieu du an da co san — CDR qua
    # _export_calldata_csv (dung chung voi handle_calldata), routing qua
    # GatewayMapStore, block/reactive events qua RoutingEventCache. LLM
    # (neu da cau hinh + bat riskReport) chi viet narrative tu JSON da tinh
    # san — khong tu tinh lai so lieu (nguyen tac muc 1.1/36 cua skill).

    def _get_cached_risk_analysis(self, key):
        with self.server.risk_analysis_cache_lock:
            item = self.server.risk_analysis_cache.get(key)
            if not item:
                return None
            created, data = item
            if monotonic() - created > RISK_ANALYSIS_CACHE_TTL_SECONDS:
                del self.server.risk_analysis_cache[key]
                return None
            self.server.risk_analysis_cache.move_to_end(key)
            return data

    def _cache_risk_analysis(self, key, data):
        with self.server.risk_analysis_cache_lock:
            self.server.risk_analysis_cache[key] = (monotonic(), data)
            self.server.risk_analysis_cache.move_to_end(key)
            while len(self.server.risk_analysis_cache) > RISK_ANALYSIS_CACHE_MAX_ITEMS:
                self.server.risk_analysis_cache.popitem(last=False)

    def handle_risk_analysis(self):
        try:
            payload = self.read_json_body()
            profile_id = payload.get("profile_id", "")
            if not profile_id:
                raise ValueError("Thiếu profile_id.")
            telco = (payload.get("telco") or "Viettel").strip()
            account_id = payload.get("account_id", "0") or "0"
            from_day = payload.get("from_day", "")
            to_day = payload.get("to_day", "")
            cache_key = json.dumps(
                {"profile_id": profile_id, "account_id": account_id,
                 "from_day": from_day, "to_day": to_day, "telco": telco},
                sort_keys=True,
            )
        except Exception as exc:
            self.error_response(exc, 400)
            return

        cached = self._get_cached_risk_analysis(cache_key)
        if cached is not None:
            self.json_response(cached)
            return

        try:
            params = {
                "profile_id": profile_id, "account_id": account_id,
                "from_day": from_day, "to_day": to_day,
                "caller_number": "", "dest_number": "", "outbound": "",
                "hangupcause": "0", "calltype": "", "telco": "0",
            }
            csv_bytes, _cache_state = self._export_calldata_csv(params)
            gateway_index = self._gateway_store(profile_id).read_index().get("index", {})
            events, _events_meta = routing_events.RoutingEventCache(
                self.server.root, profile_id
            ).load_window()
        except Exception as exc:
            self.error_response(exc)
            return

        try:
            import risk_engine
        except ImportError:
            self.error_response(RuntimeError(
                "Chưa cài thư viện phân tích rủi ro (pandas/numpy/openpyxl). "
                "Chạy: python -m pip install -r requirements.txt"
            ), 500)
            return

        try:
            analysis = risk_engine.run_analysis(csv_bytes, gateway_index, events, telco)
        except Exception as exc:
            self.error_response(exc, 400)
            return

        result = {"analysis": analysis, "narrative": None, "narrativeError": None,
                   "narrativeProvider": None, "narrativeModel": None}
        cfg = self.server.llm_config_store.resolve("riskReport")
        if cfg:
            try:
                messages = [{"role": "user", "content":
                             "Dữ liệu phân tích rủi ro CID/Gateway (JSON):\n" +
                             json.dumps(analysis, ensure_ascii=False)}]
                narrative = llm_client.send_for_feature(cfg, "risk_report", messages)
                result["narrative"] = narrative["text"]
                result["narrativeProvider"] = narrative["providerLabel"]
                result["narrativeModel"] = narrative["model"]
            except Exception as exc:
                result["narrativeError"] = str(exc)

        self._cache_risk_analysis(cache_key, result)
        self.json_response(result)

    def handle_calldata(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        params = {key: values[-1] for key, values in query.items()}
        # job_id chỉ để báo tiến độ, không được tham gia khóa cache.
        job_id = params.pop("job_id", "")
        sync_mode = params.pop("sync", "auto")
        try:
            data, cache_state = self._export_calldata_csv(params, job_id, sync_mode)
            scopes = [x for x in params.get("account_id", "").split(",") if x and x != "0"]
            summary = self.server.call_store.scope_summary(params, scopes)
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", "inline; filename=calldata.csv")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-MPT-Cache", cache_state)
            # Cho nút "Xem" báo dữ liệu trong DB của bộ lọc này mới tới đâu.
            self.send_header("X-MPT-Last-Call", summary["lastCall"])
            self.send_header("X-MPT-Synced-At", summary["syncedAt"])
            self.send_header("X-MPT-Missing-Days", ",".join(summary["missingDays"]))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            self.error_response(exc)

    def handle_data_status(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        profile_id = query.get("profile_id", [""])[-1]
        try:
            self.json_response(self.server.call_store.status(profile_id))
        except Exception as exc:
            self.error_response(exc)

    def _export_calldata_csv(self, params, job_id="", sync_mode="auto"):
        """Synchronize missing/stale MPT data, then serve the filtered DB slice.

        The compatibility endpoint still returns CSV so the existing worker and
        all chart calculations remain unchanged.  MPT bytes are never written
        as a temporary file.
        """
        from_day = params.get("from_day", "")
        to_day = params.get("to_day", "")
        try:
            start_day = date.fromisoformat(from_day)
            end_day = date.fromisoformat(to_day)
        except ValueError as exc:
            raise ValueError("Khoảng ngày không hợp lệ.") from exc
        if start_day > end_day:
            raise ValueError("Từ ngày phải trước hoặc bằng Đến ngày.")
        retention_start = date.today() - timedelta(days=self.server.call_store.retention_days - 1)
        if start_day < retention_start:
            raise ValueError(
                f"Chỉ hỗ trợ dữ liệu trong {self.server.call_store.retention_days} ngày gần nhất "
                f"(từ {retention_start.isoformat()})."
            )

        account_ids = [x for x in params.get("account_id", "").split(",") if x and x != "0"]
        profile_id = params.get("profile_id", "")
        names = self.account_names(profile_id)
        scopes = account_ids or ["*"]
        mode = str(sync_mode).lower()
        force = mode in ("force", "1", "true")
        # "update" = nút Cập nhật báo cáo: tải lại mọi ngày chưa trọn vẹn ngay,
        # không chờ hết khoảng 10 phút "còn tươi" như chế độ auto.
        explicit = force or mode == "update"
        sync_allowed = mode not in ("none", "0", "false")
        request_started = monotonic()
        sync_key = (profile_id, tuple(sorted(scopes)), from_day, to_day)
        cache_state = "DB"
        if sync_allowed:
            # MPT keeps report filters in server-side session state. Serialize
            # every export for one profile even though each export uses a fresh
            # CookieJar, otherwise overlapping requests can still contaminate
            # each other's account/direction scope upstream.
            with self.get_profile_sync_lock(profile_id):
                with self.server.profile_sync_locks_lock:
                    completed = self.server.profile_sync_completed.get(sync_key, 0)
                # Coalesce duplicate force requests that were already waiting
                # when an identical sync completed. A later, deliberate force
                # request still starts a new synchronization.
                already_completed_while_waiting = explicit and completed >= request_started
                sync_from, sync_to = from_day, to_day
                if already_completed_while_waiting:
                    should_sync = False
                elif force:
                    should_sync = True
                else:
                    # Only re-download the span that is missing/incomplete;
                    # days already complete in SQLite are served as-is.
                    stale = self.server.call_store.stale_days(
                        profile_id, scopes, from_day, to_day,
                        max_age=0 if explicit else call_store.TODAY_FRESH_SECONDS,
                    )
                    should_sync = bool(stale)
                    if stale:
                        sync_from, sync_to = min(stale), max(stale)
                if should_sync:
                    client = self.get_export_client(profile_id)
                    # Fetch the broad account/date slice once. All other filters
                    # run in SQLite, so those changes never re-download MPT.
                    source_params = dict(params)
                    source_params.update({
                        "caller_number": "", "dest_number": "", "outbound": "",
                        "hangupcause": "0", "calltype": "", "telco": "0",
                        "from_day": sync_from, "to_day": sync_to,
                    })
                    if len(account_ids) <= 1:
                        data = client.export_csv(source_params)
                    else:
                        data = self.merge_account_exports(
                            client, source_params, account_ids,
                            progress=lambda done, current: self.set_export_progress(
                                job_id, done, len(account_ids), current
                            ),
                            names=names,
                        )
                    data = self.inject_account_names(data, names)
                    self.server.call_store.ingest_csv(
                        profile_id, data, names, scopes, sync_from, sync_to,
                    )
                    with self.server.profile_sync_locks_lock:
                        self.server.profile_sync_completed[sync_key] = monotonic()
                    cache_state = "SYNC"
        if monotonic() - self.server.last_store_cleanup > 6 * 60 * 60:
            self.server.call_store.cleanup()
            self.server.last_store_cleanup = monotonic()
        return self.server.call_store.query_csv(params), cache_state

    def account_names(self, profile_id):
        profile = self.server.profile_store.get(profile_id) or {}
        return {
            str(item.get("id")): item.get("name", "")
            for item in (profile.get("accounts") or [])
        }

    @staticmethod
    def merge_account_exports(client, params, account_ids, progress=None, names=None):
        names = names or {}

        def export_one(account_id):
            one = dict(params)
            one["account_id"] = account_id
            # MPT stores the last filter in its session. A fresh session per
            # account guarantees correct filters and permits parallel export.
            account_client = MptClient(client.base_url, client.username, client.password)
            return account_id, account_client.export_csv(one)

        header = None
        rows = []
        seen = set()
        # MPT intermittently returns a stale filter when concurrent requests
        # originate from the same user/IP. Keep calls serial for correctness;
        # the server-side cache makes repeated runs fast without this risk.
        exports = []
        for index, account_id in enumerate(account_ids):
            if progress:
                progress(index, names.get(str(account_id)) or f"Account {account_id}")
            exports.append(export_one(account_id))
        if progress:
            progress(len(account_ids), "")
        for _, export_data in exports:
            raw = export_data.decode("utf-8-sig", errors="replace")
            parsed = list(csv.reader(io.StringIO(raw)))
            if not parsed:
                continue
            if header is None:
                header = parsed[0]
            for row in parsed[1:]:
                if not row or not any(row):
                    continue
                uuid_index = header.index("uuid") if "uuid" in header else -1
                key = row[uuid_index] if uuid_index >= 0 and len(row) > uuid_index else ""
                if key and key in seen:
                    continue
                if key:
                    seen.add(key)
                rows.append(row)
        if header is None:
            return b""
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)
        return output.getvalue().encode("utf-8-sig")

    # MPT chỉ trả account_id trong CSV. Ghép thêm cột account_name (từ danh sách
    # tài khoản đã lưu) để dashboard hiển thị TÊN thay vì id — áp cho cả luồng
    # 1 account lẫn "tất cả".
    _ACCOUNT_ID_HEADERS = ("accountid", "account", "tenant")

    @staticmethod
    def inject_account_names(csv_bytes, names):
        if not names or not csv_bytes:
            return csv_bytes
        text = csv_bytes.decode("utf-8-sig", errors="replace")
        parsed = list(csv.reader(io.StringIO(text)))
        if not parsed or not parsed[0]:
            return csv_bytes
        header = parsed[0]
        norm = [re.sub(r"[^a-z0-9]", "", h.lower()) for h in header]
        if "accountname" in norm:
            return csv_bytes
        try:
            acc_idx = next(
                i for i, h in enumerate(norm)
                if h in DashboardHandler._ACCOUNT_ID_HEADERS
            )
        except StopIteration:
            return csv_bytes
        out = io.StringIO(newline="")
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(header + ["account_name"])
        for row in parsed[1:]:
            if not row or not any(row):
                continue
            acc = row[acc_idx].strip() if len(row) > acc_idx else ""
            writer.writerow(row + [names.get(acc, "")])
        return out.getvalue().encode("utf-8-sig")

    def handle_dashboard(self, parsed):
        qs = urllib.parse.urlparse(self.path).query
        csv_url = ""
        for part in qs.split("&"):
            if part.startswith("csv="):
                csv_url = urllib.parse.unquote(part[4:])
                break
        if not csv_url:
            csv_params = urllib.parse.parse_qs(qs)
            csv_url = "/api/calldata.csv?" + urllib.parse.urlencode(
                {k: v[-1] for k, v in csv_params.items()}
            )
        encoded = urllib.parse.quote(csv_url, safe="")
        target = f"/?csv={encoded}"
        self.send_response(302)
        self.send_header("Location", target)
        self.end_headers()

    def translate_path(self, path):
        path = urllib.parse.urlparse(path).path
        path = posixpath.normpath(urllib.parse.unquote(path))
        words = [w for w in path.split("/") if w]
        current = Path(self.server.root)
        for word in words:
            if word in (os.curdir, os.pardir):
                continue
            current = current / word
        return str(current)

    def guess_type(self, path):
        if path.endswith(".html"):
            return "text/html; charset=utf-8"
        if path.endswith(".woff2"):
            return "font/woff2"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def app_root():
    """Folder holding the dashboard files plus the writable ``config/`` + ``logs/``.

    Frozen (PyInstaller portable build): the folder next to the ``.exe`` - so the
    whole app, saved profiles included, moves by copying that one folder.
    From source: the repository root.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def create_server(host="127.0.0.1", port=8787, root=None,
                  dashboard="V2_0_Call_Dashboard_MPT.html"):
    root = str(root if root is not None else app_root())
    server = ThreadingHTTPServer((host, port), DashboardHandler)
    server.root = root
    server.dashboard = dashboard
    server.profile_store = ProfileStore(root)
    server.llm_config_store = LlmConfigStore(root)
    server.call_store = call_store.CallStore(root)
    server.last_store_cleanup = monotonic()
    server.clients = {}
    server.export_cache = OrderedDict()
    server.export_cache_lock = Lock()
    server.export_progress = {}
    server.export_progress_lock = Lock()
    server.profile_sync_locks = {}
    server.profile_sync_completed = {}
    server.profile_sync_locks_lock = Lock()
    server.risk_analysis_cache = OrderedDict()
    server.risk_analysis_cache_lock = Lock()
    return server


def main():
    parser = argparse.ArgumentParser(
        description="MPT Call Dashboard with filter page."
    )
    parser.add_argument("--root", default=str(app_root()))
    parser.add_argument("--dashboard", default="V2_0_Call_Dashboard_MPT.html")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    server = create_server(args.host, args.port, args.root, args.dashboard)

    url = f"http://{args.host}:{args.port}/"
    print(f"Filter page: {url}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
