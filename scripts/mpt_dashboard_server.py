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
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from http.cookiejar import CookieJar
from pathlib import Path
from threading import Lock
from time import monotonic

sys.path.insert(0, str(Path(__file__).resolve().parent))
import routing_events  # noqa: E402  (can sys.path o tren de chay ca khi import truc tiep)


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
        if os.name != "nt":
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
            return
        user = os.environ.get("USERNAME")
        if not user:
            return
        try:
            import subprocess

            subprocess.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
                capture_output=True,
                check=False,
            )
        except Exception:
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
                changed = True
                break
        if changed:
            self.save_all(profiles)


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

    def login(self):
        if self.logged_in:
            return
        res = self.post_multipart(
            f"{self.base_url}/user/checkAuthen",
            {
                "username_softswitch": self.username,
                "password_softswitch": self.password,
            },
        )
        res.read()
        self.logged_in = True

    def get_accounts(self):
        self.login()
        req = urllib.request.Request(f"{self.base_url}/calldata/filter")
        req.add_header("User-Agent", "Mozilla/5.0 MPT Dashboard Local")
        res = self.opener.open(req, timeout=30)
        html = res.read().decode("utf-8", errors="replace")
        accounts = []
        # Extract only the <select name="account_id"> block
        m = re.search(
            r'<select[^>]*name="account_id"[^>]*>(.*?)</select>',
            html, re.DOTALL
        )
        if m:
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
        self.login()
        self.post_multipart(
            f"{self.base_url}/calldata/filter",
            {
                "account_id": params.get("account_id", "0"),
                "caller_number": params.get("caller_number", ""),
                "dest_number": params.get("dest_number", ""),
                "outbound": params.get("outbound", ""),
                "from_day": params.get("from_day", ""),
                "to_day": params.get("to_day", ""),
                "hangupcause": params.get("hangupcause", "0"),
                "calltype": params.get("calltype", ""),
                "telco": params.get("telco", "0"),
            },
        ).read()
        req = urllib.request.Request(f"{self.base_url}/calldata/export")
        req.add_header("User-Agent", "Mozilla/5.0 MPT Dashboard Local")
        res = self.opener.open(req, timeout=120)
        content_type = res.headers.get("Content-Type", "")
        data = res.read()
        if "text/csv" not in content_type.lower():
            raise RuntimeError(
                "MPT không trả về CSV. Hãy kiểm tra đăng nhập và bộ lọc."
            )
        return data


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
        if parsed.path == "/api/export-progress":
            self.handle_export_progress(parsed)
            return
        if parsed.path == "/api/cid-events":
            self.handle_cid_events(parsed)
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
        self.send_error(404)

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
            profile = self.server.profile_store.upsert(self.read_json_body())
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
            self.json_response({"events": events, "meta": meta})
        except Exception as exc:
            self.error_response(exc)

    def handle_calldata(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        params = {key: values[-1] for key, values in query.items()}
        # job_id chỉ để báo tiến độ, không được tham gia khóa cache.
        job_id = params.pop("job_id", "")
        try:
            data = self.get_cached_export(params)
            cache_state = "HIT" if data is not None else "MISS"
            if data is None:
                account_ids = [x for x in params.get("account_id", "").split(",") if x and x != "0"]
                profile_id = params.get("profile_id", "")
                client = self.get_export_client(profile_id)
                names = self.account_names(profile_id)
                if len(account_ids) <= 1:
                    data = client.export_csv(params)
                else:
                    data = self.merge_account_exports(
                        client,
                        params,
                        account_ids,
                        progress=lambda done, current: self.set_export_progress(
                            job_id, done, len(account_ids), current
                        ),
                        names=names,
                    )
                data = self.inject_account_names(data, names)
                self.cache_export(params, data)
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", "inline; filename=calldata.csv")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-MPT-Cache", cache_state)
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            self.error_response(exc)

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
    server.clients = {}
    server.export_cache = OrderedDict()
    server.export_cache_lock = Lock()
    server.export_progress = {}
    server.export_progress_lock = Lock()
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
