import importlib.util
import csv
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import urllib.parse
import urllib.request
from unittest import mock
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import Event, Lock, Thread


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "scripts" / "mpt_dashboard_server.py"
SPEC = importlib.util.spec_from_file_location("mpt_dashboard_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class FakeResponse:
    def __init__(self, body=b"", content_type="text/html; charset=UTF-8",
                 url="https://example.com/dashboard", status=200):
        self._body = body
        self.headers = {"Content-Type": content_type}
        self._url = url
        self.status = status

    def read(self):
        return self._body

    def geturl(self):
        return self._url


class ProfileStoreTests(unittest.TestCase):
    def test_password_is_encrypted_and_update_can_keep_existing_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.ProfileStore(directory)
            saved = store.upsert({
                "name": "Test",
                "domain": "example.com",
                "username": "user",
                "password": "secret-value",
            })
            raw = json.loads(store.path.read_text(encoding="utf-8"))["profiles"][0]
            self.assertNotIn("password", raw)
            self.assertTrue(raw["passwordEncrypted"].startswith(SERVER.SecretProtector.PREFIX))
            self.assertNotIn("secret-value", store.path.read_text(encoding="utf-8"))

            store.upsert({
                "id": saved["id"],
                "name": "Renamed",
                "domain": "example.com",
                "username": "user",
                "password": "",
            })
            self.assertEqual(store.get(saved["id"])["password"], "secret-value")

    def test_unreadable_old_profile_does_not_block_saving_a_new_one(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config"
            config.mkdir()
            path = config / "profiles.json"
            path.write_text(json.dumps({"profiles": [{
                "id": "broken",
                "name": "Broken",
                "domain": "https://example.com",
                "username": "old-user",
                "passwordEncrypted": "dpapi:not-valid-base64",
                "accounts": [],
            }]}), encoding="utf-8")
            store = SERVER.ProfileStore(directory)
            saved = store.upsert({
                "name": "New",
                "domain": "example.org",
                "username": "new-user",
                "password": "new-secret",
            })
            self.assertEqual(store.get(saved["id"])["password"], "new-secret")
            broken = next(profile for profile in store.public_profiles() if profile["id"] == "broken")
            self.assertFalse(broken["credentialAvailable"])

    def test_plaintext_profile_is_migrated_on_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config"
            config.mkdir()
            path = config / "profiles.json"
            path.write_text(json.dumps({"profiles": [{
                "id": "old",
                "name": "Old",
                "domain": "https://example.com",
                "username": "user",
                "password": "legacy-secret",
                "accounts": [],
            }]}), encoding="utf-8")
            store = SERVER.ProfileStore(directory)
            self.assertEqual(store.get("old")["password"], "legacy-secret")
            self.assertNotIn("legacy-secret", path.read_text(encoding="utf-8"))

    def test_successful_account_refresh_records_last_verified_time(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.ProfileStore(directory)
            saved = store.upsert({
                "name": "Test",
                "domain": "example.com",
                "username": "user",
                "password": "secret",
            })
            store.update_accounts(saved["id"], [{"id": "1", "name": "A"}])
            public = next(p for p in store.public_profiles() if p["id"] == saved["id"])
            self.assertEqual(public["accountCount"], 1)
            self.assertTrue(public["lastVerifiedAt"])


class MptClientAuthenticationTests(unittest.TestCase):
    LOGIN_HTML = b'<form><input name="username_softswitch"><input name="password_softswitch"></form>'

    def test_login_rejects_login_form_even_when_http_status_is_200(self):
        client = SERVER.MptClient("https://example.com", "user", "bad")
        client.post_multipart = mock.Mock(return_value=FakeResponse(
            self.LOGIN_HTML, url="https://example.com/user/checkAuthen"
        ))

        with self.assertRaisesRegex(SERVER.MptAuthenticationError, "không hợp lệ"):
            client.login()

        self.assertFalse(client.logged_in)

    def test_export_reauthenticates_once_after_expired_session(self):
        client = SERVER.MptClient("https://example.com", "user", "secret")
        client.logged_in = True
        client.post_multipart = mock.Mock(side_effect=[
            FakeResponse(self.LOGIN_HTML, url="https://example.com/user"),
            FakeResponse(b"ok", url="https://example.com/dashboard"),
            FakeResponse(b"filter ok", url="https://example.com/calldata/filter"),
        ])
        client.opener = mock.Mock()
        client.opener.open.return_value = FakeResponse(
            b"uuid,account_id\n1,334\n", content_type="text/csv; charset=utf-8",
            url="https://example.com/calldata/export",
        )

        data = client.export_csv({"account_id": "334"})

        self.assertTrue(data.startswith(b"uuid,"))
        self.assertTrue(client.logged_in)
        self.assertEqual(client.post_multipart.call_count, 3)

    def test_accounts_rejects_unexpected_html_instead_of_returning_empty(self):
        client = SERVER.MptClient("https://example.com", "user", "secret")
        client.logged_in = True
        client.opener = mock.Mock()
        client.opener.open.return_value = FakeResponse(
            b"<html><body>maintenance</body></html>",
            url="https://example.com/calldata/filter",
        )

        with self.assertRaisesRegex(RuntimeError, "giữ nguyên"):
            client.get_accounts()

    def test_socket_permission_error_has_actionable_message(self):
        reason = PermissionError(13, "socket access forbidden")
        reason.winerror = 10013
        exc = urllib.error.URLError(reason)

        message = SERVER.mpt_connection_error_message(exc)

        self.assertIn("WinError 10013", message)
        self.assertIn("chặn kết nối mạng", message)

    def test_timeout_has_distinct_message(self):
        message = SERVER.mpt_connection_error_message(
            urllib.error.URLError(TimeoutError("timed out"))
        )

        self.assertIn("quá thời gian chờ", message)


class PortableSecretTests(unittest.TestCase):
    """Secrets must travel with the app folder, not be bound to one machine."""

    def test_keyfile_is_created_next_to_profiles_and_round_trips(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.ProfileStore(directory)
            saved = store.upsert({
                "name": "A",
                "domain": "example.com",
                "username": "u",
                "password": "p@ss-word",
            })
            keyfile = Path(directory) / "config" / "secret.key"
            self.assertTrue(keyfile.exists())
            raw = json.loads((Path(directory) / "config" / "profiles.json").read_text("utf-8"))
            self.assertTrue(raw["profiles"][0]["passwordEncrypted"].startswith("portable-gcm:"))
            # A fresh process (new objects, same folder) still decrypts.
            reopened = SERVER.ProfileStore(directory)
            self.assertEqual(reopened.get(saved["id"])["password"], "p@ss-word")

    def test_secret_survives_copying_the_folder_to_another_location(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as dest:
            store = SERVER.ProfileStore(source)
            saved = store.upsert({
                "name": "A",
                "domain": "example.com",
                "username": "u",
                "password": "copied-secret",
            })
            (Path(dest) / "config").mkdir()
            for name in ("profiles.json", "secret.key"):
                shutil.copy(Path(source) / "config" / name, Path(dest) / "config" / name)
            moved = SERVER.ProfileStore(dest)
            self.assertEqual(moved.get(saved["id"])["password"], "copied-secret")

    def test_profiles_without_the_matching_keyfile_are_flagged_not_fatal(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as dest:
            store = SERVER.ProfileStore(source)
            saved = store.upsert({
                "name": "A",
                "domain": "example.com",
                "username": "u",
                "password": "orphan",
            })
            (Path(dest) / "config").mkdir()
            shutil.copy(
                Path(source) / "config" / "profiles.json",
                Path(dest) / "config" / "profiles.json",
            )  # keyfile deliberately left behind
            moved = SERVER.ProfileStore(dest)
            public = next(p for p in moved.public_profiles() if p["id"] == saved["id"])
            self.assertFalse(public["credentialAvailable"])
            fresh = moved.upsert({
                "name": "B",
                "domain": "example.org",
                "username": "u2",
                "password": "works",
            })
            self.assertEqual(moved.get(fresh["id"])["password"], "works")

    def test_a_foreign_keyfile_cannot_decrypt_the_blob(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as dest:
            saved = SERVER.ProfileStore(source).upsert({
                "name": "A",
                "domain": "example.com",
                "username": "u",
                "password": "secret",
            })
            (Path(dest) / "config").mkdir()
            shutil.copy(
                Path(source) / "config" / "profiles.json",
                Path(dest) / "config" / "profiles.json",
            )
            # A different machine would have generated its own key.
            SERVER.SecretProtector(Path(dest) / "config" / "secret.key").protect("anything")
            moved = SERVER.ProfileStore(dest)
            self.assertEqual(moved.get(saved["id"])["password"], "")


class LlmConfigStoreTests(unittest.TestCase):
    """Cau hinh AI da provider (Anthropic/Gemini/DeepSeek/Gateway) - dung lai
    SecretProtector nhu ProfileStore, nhung config toan app, khong theo profile
    MPT nao ca."""

    def test_save_and_resolve_round_trip_per_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.LlmConfigStore(directory)
            status = store.save({
                "activeProvider": "anthropic",
                "providers": {
                    "anthropic": {"apiKey": "sk-ant-test", "model": "claude-sonnet-5"},
                    "deepseek": {"apiKey": "sk-ds-test", "model": "deepseek-chat",
                                 "baseUrl": "https://api.deepseek.com"},
                },
                "features": {
                    "summary": {"enabled": True, "provider": None},
                    "explain": {"enabled": True, "provider": "deepseek"},
                },
            })
            self.assertEqual(status["activeProvider"], "anthropic")
            self.assertTrue(status["providers"]["anthropic"]["hasApiKey"])
            self.assertNotIn("apiKey", status["providers"]["anthropic"])
            self.assertNotIn("apiKeyEncrypted", status["providers"]["anthropic"])

            summary_cfg = store.resolve("summary")
            self.assertEqual(summary_cfg["provider"], "anthropic")
            self.assertEqual(summary_cfg["apiKey"], "sk-ant-test")

            explain_cfg = store.resolve("explain")
            self.assertEqual(explain_cfg["provider"], "deepseek")
            self.assertEqual(explain_cfg["apiKey"], "sk-ds-test")
            self.assertEqual(explain_cfg["baseUrl"], "https://api.deepseek.com")

    def test_blank_api_key_on_edit_keeps_existing_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.LlmConfigStore(directory)
            store.save({"providers": {"anthropic": {"apiKey": "keep-me", "model": "claude-sonnet-5"}}})
            store.save({"providers": {"anthropic": {"apiKey": "", "model": "claude-opus-5"}}})
            item = store.resolve_provider("anthropic")
            self.assertEqual(item["apiKey"], "keep-me")
            self.assertEqual(item["model"], "claude-opus-5")

    def test_disabled_feature_resolves_to_none(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.LlmConfigStore(directory)
            store.save({
                "activeProvider": "anthropic",
                "providers": {"anthropic": {"apiKey": "k", "model": "claude-sonnet-5"}},
                "features": {"summary": {"enabled": False}},
            })
            self.assertIsNone(store.resolve("summary"))

    def test_unconfigured_feature_is_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.LlmConfigStore(directory)
            self.assertIsNone(store.resolve("summary"))

    def test_api_key_never_persisted_in_plaintext(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.LlmConfigStore(directory)
            store.save({"providers": {"gemini": {"apiKey": "top-secret-key", "model": "gemini-2.5-flash"}}})
            raw_text = store.path.read_text(encoding="utf-8")
            self.assertNotIn("top-secret-key", raw_text)
            self.assertIn(SERVER.SecretProtector.PREFIX, raw_text)

    def test_default_base_urls_present_for_deepseek_and_gateway_only(self):
        with tempfile.TemporaryDirectory() as directory:
            status = SERVER.LlmConfigStore(directory).public_status()
            self.assertEqual(status["providers"]["deepseek"]["baseUrl"], "https://api.deepseek.com")
            self.assertEqual(status["providers"]["gateway"]["baseUrl"], "http://localhost:20128/v1")
            self.assertNotIn("baseUrl", status["providers"]["anthropic"])
            self.assertNotIn("baseUrl", status["providers"]["gemini"])


class AppRootTests(unittest.TestCase):
    def test_app_root_is_the_repo_root_when_running_from_source(self):
        self.assertEqual(SERVER.app_root(), ROOT)

    def test_app_root_follows_the_executable_when_frozen(self):
        original_frozen = getattr(sys, "frozen", None)
        original_exe = sys.executable
        try:
            sys.frozen = True
            sys.executable = str(Path(tempfile.gettempdir()) / "MPT Call Dashboard.exe")
            self.assertEqual(SERVER.app_root(), Path(sys.executable).resolve().parent)
        finally:
            if original_frozen is None:
                if hasattr(sys, "frozen"):
                    del sys.frozen
            else:
                sys.frozen = original_frozen
            sys.executable = original_exe


class CreateServerTests(unittest.TestCase):
    def test_create_server_binds_an_ephemeral_port_and_wires_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            server = SERVER.create_server(host="127.0.0.1", port=0, root=directory)
            try:
                self.assertGreater(server.server_address[1], 0)
                self.assertIsInstance(server.profile_store, SERVER.ProfileStore)
                self.assertIsInstance(server.llm_config_store, SERVER.LlmConfigStore)
                self.assertIsInstance(server.call_store, SERVER.call_store.CallStore)
                self.assertIsInstance(server.analytics_worker, SERVER.AnalyticsWorker)
                self.assertTrue(hasattr(server, "profile_sync_locks"))
                self.assertTrue(hasattr(server, "profile_sync_completed"))
                self.assertEqual(server.dashboard, "V2_0_Call_Dashboard_MPT.html")
            finally:
                server.server_close()


class ServerSafetyTests(unittest.TestCase):
    def test_static_allowlist_blocks_sensitive_and_backup_files(self):
        dashboard = "V2_0_Call_Dashboard_MPT.html"
        self.assertTrue(SERVER.is_allowed_static_path(f"/{dashboard}", dashboard))
        self.assertTrue(SERVER.is_allowed_static_path("/dashboard-core.js", dashboard))
        self.assertTrue(SERVER.is_allowed_static_path("/dashboard.css", dashboard))
        self.assertTrue(SERVER.is_allowed_static_path("/dashboard-csv-worker.js", dashboard))
        for path in ("/config/profiles.json", "/logs/server.log", "/README.md", "/backup.html", "/.git/config"):
            self.assertFalse(SERVER.is_allowed_static_path(path, dashboard), path)

    def test_domain_normalization(self):
        self.assertEqual(SERVER.normalize_domain("example.com/path"), "https://example.com")
        self.assertEqual(SERVER.normalize_domain(" https://example.com/a "), "https://example.com")
        self.assertEqual(SERVER.normalize_domain(""), "")


class CallStoreTests(unittest.TestCase):
    def test_ingest_is_idempotent_and_query_uses_normalized_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.call_store.CallStore(directory)
            today = date.today().isoformat()
            payload = (
                "Account,Caller,Destination,Start time,End time,Duration,Billsec,Hangup Cause,Call ID,Telco,Direction,Call Type\n"
                f"334,0901,0912,{today} 10:00:00,{today} 10:01:00,60,50,NORMAL_CLEARING,u1,Viettel,Outbound,External\n"
            ).encode("utf-8")
            for _ in range(2):
                store.ingest_csv("p", payload, {"334": "Demo"}, ["334"], today, today)
            status = store.status("p")
            exported = store.query_csv({
                "profile_id": "p", "account_id": "334",
                "from_day": today, "to_day": today,
            }).decode("utf-8-sig")
            self.assertEqual(status["rows"], 1)
            self.assertIn("account_name", exported.splitlines()[0])
            self.assertIn("Demo", exported)
            filtered = store.query_csv({
                "profile_id": "p", "account_id": "334", "from_day": today,
                "to_day": today, "outbound": "1", "calltype": "3",
            }).decode("utf-8-sig")
            self.assertIn("Outbound", filtered)
            self.assertIn("External", filtered)
            self.assertFalse(store.needs_sync("p", ["334"], today, today))
            summary = store.scope_summary({
                "profile_id": "p", "account_id": "334", "from_day": today, "to_day": today,
            }, ["334"])
            self.assertEqual(summary["rows"], 1)
            self.assertEqual(summary["lastCall"], f"{today} 10:00:00")
            self.assertEqual(summary["missingDays"], [])
            self.assertTrue(summary["syncedAt"])

    def test_outbound_filter_accepts_legacy_external_direction(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.call_store.CallStore(directory)
            today = date.today().isoformat()
            payload = (
                "Account,Caller,Start time,Call ID,Direction,Call Type\n"
                f"334,0901,{today} 10:00:00,u-external,External,External\n"
                f"334,0902,{today} 11:00:00,u-local,Local,Local\n"
            ).encode("utf-8")
            store.ingest_csv("p", payload, {}, ["334"], today, today)

            exported = store.query_csv({
                "profile_id": "p", "account_id": "334",
                "from_day": today, "to_day": today, "outbound": "1",
            }).decode("utf-8-sig")

            self.assertIn("u-external", exported)
            self.assertNotIn("u-local", exported)

    def test_query_cache_is_reused_until_data_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.call_store.CallStore(directory)
            today = date.today().isoformat()
            row = "Account,Caller,Start time,Duration,Billsec,MOS,Call ID\n334,0901,{t} 10:00:00,60,50,{mos},{uuid}\n"
            store.ingest_csv("p", row.format(t=today, mos="", uuid="u1").encode(), {}, ["334"], today, today)
            params = {"profile_id": "p", "from_day": today, "to_day": today, "sync": "none"}
            first = store.query_csv(params)
            # Không có giá trị -> ô rỗng, số giữ nguyên dạng như bản cũ.
            line = first.decode("utf-8-sig").splitlines()[1].split(",")
            columns = SERVER.call_store.COLUMNS
            self.assertEqual(line[columns.index("mos")], "")
            self.assertEqual(line[columns.index("duration")], "60.0")  # cột REAL, như bản cũ
            # Tham số không thuộc bộ lọc (sync/job_id) không tạo khoá cache mới.
            self.assertIs(store.query_csv(dict(params, sync="auto", job_id="x")), first)
            store.ingest_csv("p", row.format(t=today, mos="4.2", uuid="u2").encode(), {}, ["334"], today, today)
            second = store.query_csv(params)
            self.assertIsNot(second, first)
            self.assertIn("4.2", second.decode("utf-8-sig"))

    def test_new_database_can_shrink_and_old_one_can_be_compacted(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.call_store.CallStore(directory)
            status = store.status("p")
            self.assertEqual(status["autoVacuum"], 2)  # 2 = INCREMENTAL
            self.assertEqual(status["totalRows"], 0)
            result = store.compact()
            self.assertGreater(result["afterBytes"], 0)
            self.assertEqual(store.status("p")["autoVacuum"], 2)

    def test_day_synced_before_it_ended_is_refreshed_later(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.call_store.CallStore(directory)
            today = date.today()
            days = [(today - timedelta(days=n)).isoformat() for n in (3, 2, 1)]
            with store.connect() as db:
                # 3 ngày trước: đồng bộ sau khi ngày kết thúc -> đủ.
                db.execute("INSERT INTO sync_days VALUES('p','*',?,?)", (days[0], datetime.combine(
                    today - timedelta(days=1), datetime.min.time()).astimezone().isoformat()))
                # Hôm qua: đồng bộ lúc 12:00 hôm qua (chưa hết ngày) -> thiếu.
                db.execute("INSERT INTO sync_days VALUES('p','*',?,?)", (days[2], datetime.combine(
                    today - timedelta(days=1), datetime.min.time()).replace(hour=12).astimezone().isoformat()))
            # 2 ngày trước chưa từng đồng bộ.
            self.assertEqual(store.stale_days("p", [], days[0], days[2]), days[1:])
            summary = store.scope_summary({"profile_id": "p", "from_day": days[0], "to_day": days[2]}, [])
            self.assertEqual(summary["missingDays"], [days[1]])

    def test_cleanup_removes_rows_outside_rolling_window(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.call_store.CallStore(directory)
            old = (date.today() - timedelta(days=60)).isoformat()
            boundary = (date.today() - timedelta(days=59)).isoformat()
            payload = (
                "account_id,start_stamp,uuid\n"
                f"334,{old} 10:00:00,old-1\n"
                f"334,{boundary} 10:00:00,boundary-1\n"
            ).encode("utf-8")
            store.ingest_csv("p", payload, {}, ["334"], old, boundary)
            self.assertEqual(store.status("p")["retentionDays"], 60)
            self.assertEqual(store.status("p")["rows"], 2)
            store.cleanup()
            status = store.status("p")
            self.assertEqual(status["rows"], 1)
            self.assertEqual(status["dateMin"], boundary)

    def test_refresh_replaces_partition_and_advances_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.call_store.CallStore(directory)
            today = date.today().isoformat()
            first = (
                "account_id,start_stamp,uuid\n"
                f"334,{today} 10:00:00,old-row\n"
            ).encode()
            second = (
                "account_id,start_stamp,uuid\n"
                f"334,{today} 11:00:00,new-row\n"
            ).encode()
            store.ingest_csv("p", first, {}, ["334"], today, today)
            store.ingest_csv("p", second, {}, ["334"], today, today)
            exported = store.query_csv({
                "profile_id": "p", "account_id": "334",
                "from_day": today, "to_day": today,
            }).decode("utf-8-sig")
            self.assertNotIn("old-row", exported)
            self.assertIn("new-row", exported)
            self.assertEqual(store.data_revision("p"), 2)
            with store.connect() as db:
                partition = db.execute(
                    "SELECT status,row_count,revision FROM sync_partitions "
                    "WHERE profile_id='p' AND account_scope='334' AND day=?",
                    (today,),
                ).fetchone()
            self.assertEqual(tuple(partition), ("complete", 1, 2))


class AnalyticsWorkerTests(unittest.TestCase):
    @unittest.skipIf(shutil.which("node") is None, "Node.js is required")
    def test_worker_reads_sqlite_and_serves_compact_operations(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SERVER.call_store.CallStore(directory)
            today = date.today().isoformat()
            payload = (
                "uuid,account_id,caller_id_number,destination_number,start_stamp,end_stamp,duration,billsec,hangup_cause,telco,direction\n"
                f"u1,334,0901,0911,{today} 10:00:00,{today} 10:01:00,60,30,NORMAL_CLEARING,Viettel,Outbound\n"
                f"u2,334,0902,0912,{today} 11:00:00,{today} 11:00:00,0,0,NO_ROUTE_DESTINATION,Viettel,Outbound\n"
            ).encode()
            store.ingest_csv("p", payload, {"334": "Demo"}, ["334"], today, today)
            worker = SERVER.AnalyticsWorker(ROOT, store.path)
            params = {
                "profile_id": "p", "account_id": "334",
                "from_day": today, "to_day": today,
            }
            cube_params = {
                "startDate": today, "endDate": today,
                "startTime": "00:00", "endTime": "23:59", "account": "all",
            }
            try:
                bundle = worker.request(
                    "bundle", params=params, datasetKey="p:1",
                    cubeParams=cube_params, previewLimit=1,
                )
                self.assertEqual(bundle["meta"]["count"], 2)
                self.assertEqual(len(bundle["rows"]), 1)
                self.assertEqual(bundle["cube"]["overview"]["totalCalls"], 2)
                detail = worker.request(
                    "detail", params=params, datasetKey="p:1",
                    detailParams={"startDate": today, "endDate": today,
                                  "startTime": "00:00", "endTime": "23:59",
                                  "statuses": ["Connected"]},
                    offset=0, limit=25,
                )
                self.assertEqual(detail["total"], 1)
                billing = worker.request(
                    "billing", params=params, datasetKey="p:1",
                    cfg={"startDate": today, "endDate": today,
                         "startTime": "00:00", "endTime": "23:59",
                         "firstBlock": 6, "nextBlock": 1, "onlyConnected": True,
                         "rate": 100, "roundStep": 0, "groupBy": "day"},
                )
                self.assertEqual(billing["rowCount"], 2)
                self.assertEqual(billing["report"]["totals"]["billedCalls"], 1)
                external_payload = (
                    "uuid,account_id,start_stamp,direction,calltype\n"
                    f"u3,334,{today} 12:00:00,External,External\n"
                    f"u4,334,{today} 13:00:00,Local,Local\n"
                ).encode()
                store.ingest_csv("p", external_payload, {"334": "Demo"}, ["334"], today, today)
                outbound = worker.request(
                    "bundle", params=dict(params, outbound="1"),
                    datasetKey="p:external", cubeParams=cube_params, previewLimit=10,
                )
                self.assertEqual(outbound["meta"]["count"], 1)
                self.assertEqual(outbound["rows"][0]["uuid"], "u3")
            finally:
                worker.stop()


class AnalyticsApiTests(unittest.TestCase):
    @unittest.skipIf(shutil.which("node") is None, "Node.js is required")
    def test_bundle_detail_and_billing_endpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copy(ROOT / "dashboard-core.js", root / "dashboard-core.js")
            shutil.copy(ROOT / "analytics-worker.js", root / "analytics-worker.js")
            server = SERVER.create_server(host="127.0.0.1", port=0, root=root)
            today = date.today().isoformat()
            server.call_store.ingest_csv(
                "p",
                (
                    "uuid,account_id,caller_id_number,destination_number,start_stamp,end_stamp,duration,billsec,hangup_cause,telco,direction\n"
                    f"u1,334,0901,0911,{today} 10:00:00,{today} 10:01:00,60,30,NORMAL_CLEARING,Viettel,Outbound\n"
                    f"u2,334,0902,0912,{today} 11:00:00,{today} 11:00:00,0,0,NO_ROUTE_DESTINATION,Viettel,Outbound\n"
                ).encode(),
                {"334": "Demo"}, ["334"], today, today,
            )
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"
            common = {
                "profile_id": "p", "account_id": "334",
                "from_day": today, "to_day": today, "sync": "none",
                "start_time": "00:00", "end_time": "23:59",
                "cube_account": json.dumps("all"),
            }
            try:
                with urllib.request.urlopen(
                    base + "/api/report-bundle?" + urllib.parse.urlencode(common), timeout=10
                ) as response:
                    bundle = json.loads(response.read())
                self.assertEqual(bundle["meta"]["count"], 2)
                self.assertEqual(bundle["cube"]["overview"]["totalCalls"], 2)

                detail_query = dict(common, detail=json.dumps({
                    "startDate": today, "endDate": today,
                    "startTime": "00:00", "endTime": "23:59",
                    "statuses": ["Connected"],
                }), offset="0", limit="25")
                with urllib.request.urlopen(
                    base + "/api/call-details?" + urllib.parse.urlencode(detail_query), timeout=10
                ) as response:
                    detail = json.loads(response.read())
                self.assertEqual(detail["total"], 1)

                request = urllib.request.Request(
                    base + "/api/billing-report", method="POST",
                    headers={"Content-Type": "application/json"},
                    data=json.dumps({
                        "params": common,
                        "cfg": {"startDate": today, "endDate": today,
                                "startTime": "00:00", "endTime": "23:59",
                                "firstBlock": 6, "nextBlock": 1,
                                "onlyConnected": True, "rate": 100,
                                "roundStep": 0, "groupBy": "day"},
                    }).encode(),
                )
                with urllib.request.urlopen(request, timeout=10) as response:
                    billing = json.loads(response.read())
                self.assertEqual(billing["report"]["totals"]["billedCalls"], 1)
                self.assertNotIn("detail", billing["report"])
                request = urllib.request.Request(
                    base + "/api/billing-detail", method="POST",
                    headers={"Content-Type": "application/json"},
                    data=json.dumps({
                        "params": common,
                        "cfg": {"startDate": today, "endDate": today,
                                "startTime": "00:00", "endTime": "23:59",
                                "firstBlock": 6, "nextBlock": 1,
                                "onlyConnected": True, "rate": 100,
                                "roundStep": 0, "groupBy": "day"},
                        "offset": 0, "limit": 25,
                    }).encode(),
                )
                with urllib.request.urlopen(request, timeout=10) as response:
                    billing_detail = json.loads(response.read())
                self.assertEqual(billing_detail["total"], 1)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(2)


class DashboardCoreModuleTests(unittest.TestCase):
    """dashboard-core.js là nguồn duy nhất cho logic normalize/classify/enrich."""

    CORE = ROOT / "dashboard-core.js"
    HTML = ROOT / "V2_0_Call_Dashboard_MPT.html"
    WORKER = ROOT / "dashboard-csv-worker.js"

    def test_core_module_exists_and_is_dom_free(self):
        src = self.CORE.read_text(encoding="utf-8")
        no_comments = __import__("re").sub(r"/\*.*?\*/|(^|[^:])//.*$", r"\1",
                                          src, flags=__import__("re").S | __import__("re").M)
        for bad in ("document.", "localStorage.", "getElementById", "Plotly.", "window."):
            self.assertNotIn(bad, no_comments, f"dashboard-core.js chứa {bad}")

    def test_html_loads_core_before_the_main_script(self):
        html = self.HTML.read_text(encoding="utf-8")
        self.assertIn('<script src="/dashboard-core.js"></script>', html)
        self.assertLess(html.index('src="/dashboard-core.js"'),
                        html.rindex("function updateDashboardWithFilters"))

    def test_worker_imports_core(self):
        self.assertIn("importScripts('/dashboard-core.js')", self.WORKER.read_text(encoding="utf-8"))

    def test_foundation_defs_moved_out_of_html(self):
        html = self.HTML.read_text(encoding="utf-8")
        for token in (
            "function classifyCall(rec){",
            "function enrichData(arr",
            "function filterData(rows,",
            "function normalizeCallRecord(raw",
            "function dedupByUUID(rows){",
            "const CONN_TYPES =",
            "const Fail_Hangup_cause =",
            "function mapPrefix(caller){",
            # cụm tổng hợp overview -> dashboard-core.js (Milestone 1c)
            "function computeCallCounts(rows){",
            "function aggregateOverview(rows){",
            "function minutesPerDay(rows){",
        ):
            self.assertNotIn(token, html, f"HTML vẫn còn định nghĩa trùng: {token}")
        # phần render vẫn ở HTML và vẫn gọi các hàm đó (giờ từ core)
        self.assertIn("aggregateOverview(", html)
        self.assertIn("enrichData(", html)

    def test_node_core_suite_passes(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node không có sẵn")
        proc = subprocess.run(
            [node, "--test", str(ROOT / "tests" / "core.test.mjs")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            encoding="utf-8", errors="replace", cwd=str(ROOT),
        )
        self.assertEqual(proc.returncode, 0, proc.stdout or "<no output>")


class WorkerProtocolTests(unittest.TestCase):
    """Worker bền: giao thức message + fallback main-thread."""

    WORKER = (ROOT / "dashboard-csv-worker.js").read_text(encoding="utf-8")
    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")

    def test_worker_handles_every_message_type(self):
        for t in ("'parse'", "'ingest'", "'ingestRows'", "'reenrich'", "'cube'", "'billing'", "'page'"):
            self.assertIn("type === " + t, self.WORKER, f"worker thiếu type {t}")

    def test_worker_keeps_string_message_backcompat(self):
        # parseCSVInWorker cũ gửi chuỗi thuần -> vẫn phải trả mảng
        self.assertIn("if (typeof d === 'string')", self.WORKER)
        self.assertIn("self.postMessage(parseCSV(d))", self.WORKER)

    def test_worker_stores_state_and_builds_cube_from_it(self):
        self.assertIn("state = { deduped: [], enriched: [], nameMap: {}, gwIndex: null }", self.WORKER)
        self.assertIn("buildCube(state.enriched, msg.params", self.WORKER)

    def test_html_load_paths_use_worker_with_main_thread_fallback(self):
        html = self.HTML
        self.assertIn("const dashWorker=(()=>{", html)
        self.assertIn("dashWorker.ingest(text,", html)          # loadReportDataUrl
        self.assertIn("dashWorker.ingestRows(allRows,", html)   # file upload
        self.assertIn("dashWorker.ingestRows(rows,", html)      # applyLoadedRows (snapshot)
        # mỗi nhánh worker phải có else fallback dùng core trực tiếp
        self.assertIn("enrichData(ded.rows, accountNameMap, gatewayCidIndex)", html)


class CubeRenderPipelineTests(unittest.TestCase):
    """Milestone 3: render đọc từ cube (worker) thay vì compute*(filtered) tại chỗ."""

    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")

    def test_update_dashboard_is_async_and_fetches_cube(self):
        self.assertIn("async function updateDashboardWithFilters(){", self.HTML)
        self.assertIn("const cube = await computeCubeFor(params);", self.HTML)
        self.assertIn("dashState.cube = cached.cube || null;", self.HTML)

    def test_compute_cube_helper_prefers_worker_then_falls_back(self):
        self.assertIn("async function computeCubeFor(params){", self.HTML)
        self.assertIn("dashWorker.cube(params)", self.HTML)
        self.assertIn("buildCube(enriched, params)", self.HTML)  # nhánh fallback main-thread
        self.assertIn("function cubeVal(path, fallbackFn){", self.HTML)

    def test_render_call_sites_read_from_cube(self):
        for token in (
            "cubeVal('byPrefix',",
            "cubeVal('minutesPerDay',",
            "cubeVal('timeHeatmap',",
            "cubeVal('goldenHours',",
            "cubeVal('concurrency.all',",
            "cubeVal('concurrency.byTelco',",
            "cubeVal('concurrency.ccuByTelco',",
            "cubeVal('agentPerf',",
            "cubeVal('callbackStats',",
            "cubeVal('retryPattern',",
            "cubeVal('dailyPrefixStats',",
            "cubeVal('columnHealth',",
            "cubeVal('timeAnomaly',",
            "cubeVal('overview.destinationQuality',",
            "cubeVal('accountKPIs',",
            "cubeVal('topDest',",
        ):
            self.assertIn(token, self.HTML, f"thiếu {token}")
        # overview đi qua dashState.ov (đã = cube.overview) nên không cần cubeVal riêng
        self.assertIn("const ov = (cube && cube.overview) || aggregateOverview(filtered);", self.HTML)

    def test_sample_button_routes_through_worker_load_path(self):
        # trước đây tự set enriched -> worker rỗng -> cube 0 dòng
        self.assertIn("await applyLoadedRows(normalizeCallRecords(sample));", self.HTML)

    def test_sqlite_reports_use_server_bundle_and_server_side_details(self):
        for token in (
            "/api/report-bundle", "loadServerReportBundle(", "serverBackedReport=true",
            "/api/call-details", "/api/billing-report", "/api/billing-detail",
        ):
            self.assertIn(token, self.HTML)


class IncrementalRenderTests(unittest.TestCase):
    """Milestone 4: vẽ từng biểu đồ có nhả luồng -> cửa sổ không treo cứng."""

    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")

    def test_yield_frame_has_timeout_fallback_for_hidden_window(self):
        self.assertIn("function yieldFrame(){", self.HTML)
        # rAF không chạy khi cửa sổ ẩn -> phải có fallback setTimeout
        self.assertIn("requestAnimationFrame(fin)", self.HTML)
        self.assertIn("setTimeout(fin, 32)", self.HTML)

    def test_every_tab_renderer_uses_render_steps(self):
        for fn in ("renderOverviewTab", "renderQualityTab", "renderTimeTab",
                   "renderAdvancedTab"):
            body = self.HTML.split(f"function {fn}(", 1)[1].split("\n}", 1)[0]
            self.assertIn("renderSteps([", body, f"{fn} chưa dùng renderSteps")
        # renderBillingTab (đã async từ 3-billing) cũng vẽ qua renderSteps
        billing = self.HTML.split("async function renderBillingTab()", 1)[1].split("\n}", 1)[0]
        self.assertIn("await renderSteps([", billing)

    def test_ensure_tab_rendered_is_async_and_awaited_on_load(self):
        self.assertIn("async function ensureTabRendered(tabName, force=false){", self.HTML)
        self.assertIn("await ensureTabRendered(currentTab, true);", self.HTML)
        # đánh dấu đã render trước await để không render trùng khi đổi tab nhanh
        idx_add = self.HTML.index("renderedTabs.add(tabName);")
        idx_await = self.HTML.index("await renderOverviewTab(filtered, ov, colors);")
        self.assertLess(idx_add, idx_await)

    def test_load_paths_await_dashboard_update_for_progress(self):
        # loadReportDataUrl, tải file, applyLoadedRows, applyLoadedText
        self.assertGreaterEqual(self.HTML.count("await updateDashboardWithFilters();"), 3)

    def test_ccu_by_telco_returns_stats_and_meta_separately(self):
        core = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")
        self.assertNotIn("stats.meta = {", core)   # không gắn property lên Array nữa
        self.assertIn("return {\n    stats,\n    meta: {", core)

    def test_main_thread_row_cap_keeps_full_data_in_worker(self):
        worker = (ROOT / "dashboard-csv-worker.js").read_text(encoding="utf-8")
        html = self.HTML
        # worker giữ toàn bộ, chỉ gửi về main thread tối đa cap dòng
        self.assertIn("state.enriched.slice(0, cap)", worker)
        self.assertIn("accountIds: accountIds", worker)   # danh sách account đủ, không bị cap
        self.assertIn("telcos: telcos", worker)
        self.assertIn("const MAIN_ROW_CAP=", html)
        self.assertIn("cap:MAIN_ROW_CAP", html)
        # cube/page vẫn tính trên state.enriched đầy đủ
        self.assertIn("buildCube(state.enriched", worker)
        self.assertIn("filterData(state.enriched", worker)
        # snapshot cho nguồn CSV: lưu chuỗi thô thay vì hàng chục nghìn object
        self.assertIn("async function snapshotSaveText(text,meta,count,sourceUrl)", html)
        self.assertIn("text = null;", html)   # giải phóng chuỗi CSV sớm

    def test_billing_tab_runs_in_worker_with_shared_filter(self):
        core = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")
        worker = (ROOT / "dashboard-csv-worker.js").read_text(encoding="utf-8")
        self.assertIn("function billingRows(rows, cfg){", core)
        self.assertIn("type === 'billing'", worker)
        self.assertIn("billingRows(state.enriched, cfg)", worker)
        # HTML: getBillingRows chỉ còn là wrapper mỏng, renderBillingTab async qua worker
        self.assertIn("function getBillingRows(cfg){ return billingRows(enriched || [], cfg); }", self.HTML)
        self.assertIn("async function renderBillingTab(){", self.HTML)
        self.assertIn("await dashWorker.billing(cfg)", self.HTML)

    def test_billing_quick_ranges_use_full_dataset_metadata(self):
        self.assertIn("function setBillingRangePreset(preset)", self.HTML)
        self.assertIn("resolveDateRangePreset(preset,min,max)", self.HTML)
        self.assertIn("setBillingRangePreset('all')", self.HTML)
        self.assertIn("setBillingRangePreset('latest')", self.HTML)
        self.assertNotIn("function setBillingRangeDays(days)", self.HTML)

    def test_operational_alerts_are_computed_in_full_data_cube(self):
        core = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")
        self.assertIn("operationalAlerts: computeOperationalAlerts(rows)", core)
        self.assertIn("cubeVal('operationalAlerts'", self.HTML)
        self.assertIn("scope:{mode:'full'", core)


class ExportProgressTests(unittest.TestCase):
    def test_direction_aware_export_splits_sources_without_direction_column(self):
        class FakeClient:
            def __init__(self):
                self.calls = []

            def export_csv(self, params):
                outbound = str(params.get("outbound", ""))
                self.calls.append(outbound)
                header = "uuid,account_id,start_stamp,calltype\n"
                if outbound == "1":
                    return (header + "u-out,294,2026-09-23 10:00:00,Local\n").encode()
                if outbound == "2":
                    return (header + "u-in,294,2026-09-23 11:00:00,Local\n").encode()
                return (header + "u-out,294,2026-09-23 10:00:00,Local\n"
                        "u-in,294,2026-09-23 11:00:00,Local\n").encode()

        handler = SERVER.DashboardHandler.__new__(SERVER.DashboardHandler)
        handler.server = types.SimpleNamespace(profile_direction_modes={})
        client = FakeClient()

        first = handler.export_direction_aware("p", client, {"account_id": "294"})
        second = handler.export_direction_aware("p", client, {"account_id": "294"})
        rows = list(csv.DictReader(io.StringIO(first.decode("utf-8-sig"))))

        self.assertEqual(client.calls, ["", "1", "2", "1", "2"])
        self.assertEqual(handler.server.profile_direction_modes["p"], "split")
        self.assertEqual({row["uuid"]: row["direction"] for row in rows}, {
            "u-out": "Outbound", "u-in": "Inbound",
        })
        self.assertEqual(len(list(csv.DictReader(io.StringIO(second.decode("utf-8-sig"))))), 2)

    def test_direction_aware_export_keeps_native_direction_in_one_request(self):
        class FakeClient:
            calls = 0

            def export_csv(self, params):
                self.calls += 1
                return b"uuid,direction\nu1,Outbound\n"

        handler = SERVER.DashboardHandler.__new__(SERVER.DashboardHandler)
        handler.server = types.SimpleNamespace(profile_direction_modes={})
        client = FakeClient()

        data = handler.export_direction_aware("p", client, {})

        self.assertEqual(client.calls, 1)
        self.assertEqual(handler.server.profile_direction_modes["p"], "native")
        self.assertIn(b"Outbound", data)

    def test_overlapping_force_requests_for_same_scope_are_coalesced(self):
        export_started = Event()
        second_reached_lock = Event()
        release_export = Event()
        sync_lock = Lock()
        counter_lock = Lock()
        lock_requests = 0

        class FakeStore:
            retention_days = 31

            def needs_sync(self, *args, **kwargs):
                return True

            def stale_days(self, *args, **kwargs):
                return ["2026-09-23"]

            def ingest_csv(self, *args, **kwargs):
                return None

            def query_csv(self, params):
                return b"uuid\n"

            def cleanup(self):
                return 0

        class FakeClient:
            calls = 0

            def export_csv(self, params):
                FakeClient.calls += 1
                export_started.set()
                self.assert_released = release_export.wait(2)
                return b"uuid,account_id,start_stamp,direction\nu1,334,2026-09-23 10:00:00,Outbound\n"

        handler = SERVER.DashboardHandler.__new__(SERVER.DashboardHandler)
        handler.server = types.SimpleNamespace(
            call_store=FakeStore(), profile_sync_locks_lock=Lock(),
            profile_sync_completed={}, last_store_cleanup=SERVER.monotonic(),
        )
        handler.account_names = lambda profile_id: {}
        handler.get_export_client = lambda profile_id: FakeClient()

        def get_sync_lock(profile_id):
            nonlocal lock_requests
            with counter_lock:
                lock_requests += 1
                if lock_requests == 2:
                    second_reached_lock.set()
            return sync_lock

        handler.get_profile_sync_lock = get_sync_lock
        params = {
            "profile_id": "p", "account_id": "334",
            "from_day": "2026-09-23", "to_day": "2026-09-23",
        }
        results = []
        errors = []

        def run_export():
            try:
                results.append(handler._export_calldata_csv(dict(params), sync_mode="force")[1])
            except Exception as exc:
                errors.append(exc)

        first = Thread(target=run_export)
        second = Thread(target=run_export)
        first.start()
        self.assertTrue(export_started.wait(1))
        second.start()
        self.assertTrue(second_reached_lock.wait(1))
        release_export.set()
        first.join(2)
        second.join(2)
        self.assertFalse(errors)
        self.assertEqual(FakeClient.calls, 1)
        self.assertCountEqual(results, ["SYNC", "DB"])

    def test_multi_account_export_reports_progress_for_each_account(self):
        class FakeClient:
            base_url = "https://example.com"
            username = "user"
            password = "secret"

            def __init__(self, *args, **kwargs):
                pass

            def export_csv(self, params):
                account_id = params["account_id"]
                return f"uuid,account_id\r\nu{account_id},{account_id}\r\n".encode("utf-8-sig")

        original = SERVER.MptClient
        SERVER.MptClient = FakeClient
        events = []
        try:
            data = SERVER.DashboardHandler.merge_account_exports(
                FakeClient(),
                {"account_id": "1,2,3", "from_day": "2026-09-01"},
                ["1", "2", "3"],
                progress=lambda done, current: events.append((done, current)),
                names={"1": "Acc A", "2": "Acc B"},
            )
        finally:
            SERVER.MptClient = original

        self.assertEqual([done for done, _ in events], [0, 1, 2, 3])
        self.assertEqual(events[0][1], "Acc A")
        self.assertEqual(events[2][1], "Account 3")
        self.assertIn("u3,3", data.decode("utf-8-sig"))

    def test_all_account_sync_exports_each_saved_account(self):
        class FakeStore:
            retention_days = 31

            def __init__(self):
                self.stale_scopes = None
                self.ingest_scopes = None

            def stale_days(self, profile_id, scopes, from_day, to_day, max_age=None):
                self.stale_scopes = list(scopes)
                return ["2026-09-01"]

            def ingest_csv(self, profile_id, csv_bytes, account_names, account_scopes,
                           from_day, to_day):
                self.ingest_scopes = list(account_scopes)

            def query_csv(self, params):
                return b"uuid\n"

            def cleanup(self):
                return 0

        store = FakeStore()
        exported_accounts = []
        handler = SERVER.DashboardHandler.__new__(SERVER.DashboardHandler)
        handler.server = types.SimpleNamespace(
            call_store=store, profile_sync_locks_lock=Lock(),
            profile_sync_completed={}, last_store_cleanup=SERVER.monotonic(),
            profile_store=types.SimpleNamespace(get=lambda profile_id: {
                "accounts": [
                    {"id": "1", "name": "Acc A"},
                    {"id": "2", "name": "Acc B"},
                ],
            }),
        )
        handler.get_profile_sync_lock = lambda profile_id: Lock()
        handler.get_export_client = lambda profile_id: types.SimpleNamespace(
            base_url="https://example.com", username="user", password="secret",
        )

        def fake_merge(client, params, account_ids, progress=None, names=None,
                       exporter=None):
            exported_accounts.extend(account_ids)
            return b"uuid,account_id,start_stamp\nu1,1,2026-09-01 10:00:00\n"

        handler.merge_account_exports = fake_merge

        _, cache_state = handler._export_calldata_csv({
            "profile_id": "p", "account_id": "0",
            "from_day": "2026-09-01", "to_day": "2026-09-01",
        }, sync_mode="update")

        self.assertEqual(cache_state, "SYNC")
        self.assertEqual(store.stale_scopes, ["1", "2"])
        self.assertEqual(exported_accounts, ["1", "2"])
        self.assertEqual(store.ingest_scopes, ["1", "2"])

    def test_inject_account_names_adds_a_name_column_from_the_id_map(self):
        inject = SERVER.DashboardHandler.inject_account_names
        names = {"388": "VCLASS BOT", "421": "SALE OUTBOUND"}
        # MPT "new format" header uses "Account" for the id column.
        src = "Account,Destination\r\n388,09xx\r\n421,08yy\r\n999,07zz\r\n".encode("utf-8-sig")
        out = inject(src, names).decode("utf-8-sig")
        lines = [ln for ln in out.splitlines() if ln]
        self.assertEqual(lines[0], "Account,Destination,account_name")
        self.assertEqual(lines[1], "388,09xx,VCLASS BOT")
        self.assertEqual(lines[2], "421,08yy,SALE OUTBOUND")
        self.assertEqual(lines[3], "999,07zz,")  # id không có trong map -> để trống
        # Không có map / đã có cột name -> giữ nguyên.
        self.assertEqual(inject(src, {}), src)
        self.assertEqual(inject(out.encode("utf-8-sig"), names).decode("utf-8-sig"), out)

    @unittest.skipIf(shutil.which("node") is None, "Node.js is required for backend cube")
    def test_backend_report_cube_uses_dashboard_core(self):
        handler = SERVER.DashboardHandler.__new__(SERVER.DashboardHandler)
        handler.server = types.SimpleNamespace(root=str(ROOT))
        csv_bytes = (
            "uuid,account_id,caller_id_number,destination_number,direction,start_stamp,end_stamp,duration,billsec,hangup_cause\n"
            "u1,421,0901,0911,Outbound,2026-09-01 08:00:00,2026-09-01 08:01:00,60,30,NORMAL_CLEARING\n"
            "u2,421,0902,0912,Outbound,2026-09-01 09:00:00,2026-09-01 09:00:00,0,0,NO_ROUTE_DESTINATION\n"
        ).encode("utf-8-sig")

        result = handler.build_report_cube(
            csv_bytes,
            {
                "startDate": "2026-09-01",
                "endDate": "2026-09-01",
                "startTime": "00:00",
                "endTime": "23:59",
                "account": "all",
            },
            {"421": "HNI_Pana_BOT_Biva"},
            {},
        )

        self.assertEqual(result["meta"]["sourceRows"], 2)
        self.assertEqual(result["cube"]["meta"]["rows"], 2)
        self.assertEqual(result["cube"]["overview"]["totalCalls"], 2)
        self.assertEqual(result["cube"]["overview"]["counts"]["Connected"], 1)

    def test_job_id_is_removed_before_the_database_query_is_built(self):
        source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertLess(
            source.index('params.pop("job_id"'),
            source.index("self.server.call_store.query_csv(params)"),
        )

    def test_progress_is_stored_per_job_and_ignored_without_a_job_id(self):
        handler = SERVER.DashboardHandler.__new__(SERVER.DashboardHandler)
        handler.server = types.SimpleNamespace(export_progress={}, export_progress_lock=Lock())
        handler.set_export_progress("job-1", 3, 10, "Acc A")
        handler.set_export_progress("", 1, 2, "ignored")
        self.assertEqual(list(handler.server.export_progress), ["job-1"])
        self.assertEqual(handler.server.export_progress["job-1"]["done"], 3)
        self.assertEqual(handler.server.export_progress["job-1"]["total"], 10)


class FrontendRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.filter_html = (ROOT / "mpt_filter.html").read_text(encoding="utf-8")
        cls.dashboard_html = (
            (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
            + (ROOT / "dashboard.css").read_text(encoding="utf-8")
            + (ROOT / "dashboard-core.js").read_text(encoding="utf-8")
        )
        cls.server_source = SERVER_PATH.read_text(encoding="utf-8")

    def test_filter_uses_local_date_instead_of_utc_date(self):
        self.assertIn("const today = localISODate();", self.filter_html)
        self.assertNotIn("const today = new Date().toISOString().slice(0,10)", self.filter_html)

    def test_dashboard_bootstraps_after_late_report_functions(self):
        function_position = self.dashboard_html.index("function plotDirectionSplit")
        bootstrap_position = self.dashboard_html.rindex("loadDataFromUrlParam()")
        self.assertGreater(bootstrap_position, function_position)
        # Bootstrap chạy đúng một lần; không tải được từ URL thì mời dùng lại dữ liệu cũ.
        bootstrap = "loadDataFromUrlParam().then(loaded=>{ if(!loaded) offerLastSnapshot(); });"
        self.assertEqual(self.dashboard_html.count(bootstrap), 1)

    def test_loading_and_accessibility_hooks_exist(self):
        for token in (
            "reportLoading",
            "cancelReportLoad",
            'aria-live="polite"',
            'class="skip-link"',
            'id="uiInfoPopover"',
            "aria-current",
        ):
            self.assertIn(token, self.dashboard_html)
        self.assertNotIn("ⓘ", self.dashboard_html)

    def test_ai_assistant_uses_responsive_side_sheet(self):
        for token in (
            "--ask-sheet-w:clamp(360px,40vw,420px)",
            "body.adw.ask-panel-open .adw-body",
            "body.adw.ask-panel-open::before",
            "document.body.classList.add('ask-panel-open')",
            "event.ctrlKey && event.key==='/'",
            "requestAnimationFrame(()=>document.getElementById('askQuestionInput')?.focus())",
        ):
            self.assertIn(token, self.dashboard_html)

    def test_overview_kpis_use_primary_status_and_compact_secondary_rows(self):
        for token in (
            'class="kpi-primary-grid"',
            'class="kpi kpi-status" id="kpi_conn"',
            'class="kpi-secondary-grid"',
            'id="kpi_minutes"',
            'Trung vị số ngẫu nhiên (RN)',
            'Tỷ lệ kết nối (trừ cuộc lỗi)',
            'const KPI_THRESHOLDS=Object.freeze',
            'data-severity="warn"',
        ):
            self.assertIn(token, self.dashboard_html)
        self.assertNotIn('id="kpi_max_cf" class="kpi compact tone-red"', self.dashboard_html)

    def test_empty_states_replace_zero_charts_and_group_repetition(self):
        for token in (
            "function renderEmptyState(container,",
            'id="reportEmptyState"',
            'id="gatewayGroupEmpty"',
            'id="cidGroupEmpty"',
            "function syncGlobalEmptyState",
            "details.hidden=true",
            "card.classList.add('has-empty-state')",
            "const CID_REPORT_SELECTOR",
            "const GATEWAY_REPORT_IDS",
        ):
            self.assertIn(token, self.dashboard_html)
        self.assertNotIn("body.innerHTML='<div class=\"report-stat-note\">Không có số liệu", self.dashboard_html)

    def test_billing_defaults_to_main_range_and_requires_rate_for_money_charts(self):
        for token in (
            'id="billUseOwnRange"',
            'id="billingOwnRangeFields"',
            'id="billingRateEmpty"',
            "function syncBillingRangeMode()",
            "function updateBillingRateState(cfg)",
            "startDate: ownRange ? val('billStartDate') : val('startDate')",
            "setKpi('billKpiCostText', cfg.rate ? UIFormat.vnd(t.cost) : '—')",
            'Xuất CSV tổng hợp',
            'Xuất chi tiết từng cuộc',
            '<summary>Cách tính</summary>',
        ):
            self.assertIn(token, self.dashboard_html)
        self.assertNotIn('Export CSV tổng hợp', self.dashboard_html)

    def test_visible_copy_uses_consistent_vietnamese_labels(self):
        for token in (
            "const UI_LABELS = Object.freeze",
            "statusLabel('Connected')",
            "Bảng điều khiển cuộc gọi MPT",
            "Tỷ lệ cuộc gọi ngắn",
            "Lượt gọi lại",
            "Phân bố số lượng cuộc gọi theo Gateway",
            "Nguyên nhân kết thúc",
            "Không thể xuất CSV vì chưa có dữ liệu gọi lại",
        ):
            self.assertIn(token, self.dashboard_html)
        for stale_copy in (
            "Không có cuộc gọi Connected",
            "Short Call Rate trong Connected",
            "Account summary",
            "Retry rate cao",
            "Phân bổ số lượng cuộc gọi theo Gateway",
            "Phân bổ Hangup Cause theo Gateway",
            ">Export CSV<",
            ">Huỷ<",
        ):
            self.assertNotIn(stale_copy, self.dashboard_html)

    def test_css_cleanup_stays_within_ux30_budgets(self):
        html = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
        css = (ROOT / "dashboard.css").read_text(encoding="utf-8")
        core = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")
        self.assertLess(len(re.findall(r'style="[^"]*"', html)), 80)
        self.assertLessEqual(css.count("!important"), 5)
        token_end = "/* /UX-30: centralized legacy and chart color tokens. */"
        self.assertIn(token_end, css)
        self.assertEqual(re.findall(r"#[0-9a-fA-F]{3,8}\b", css.split(token_end, 1)[1]), [])
        self.assertLessEqual(len(re.findall(r"#[0-9a-fA-F]{3,8}\b", html + core)), 10)

    def test_responsive_layout_covers_tablet_and_mobile_breakpoints(self):
        for token in (
            'id="mobileFilterToggle"',
            'id="mobileFilterSheet"',
            "function scheduleVisiblePlotResize()",
            "setTimeout(()=>",
            "},150);",
            "@media(min-width:1024px) and (max-width:1279px)",
            "@media(min-width:900px) and (max-width:1023px)",
            "@media(max-width:899px)",
            "@container report-layout (max-width:933px)",
        ):
            self.assertIn(token, self.dashboard_html)

    def test_worker_is_available(self):
        worker = ROOT / "dashboard-csv-worker.js"
        self.assertTrue(worker.exists())
        self.assertIn("self.onmessage", worker.read_text(encoding="utf-8"))

    def test_update_scope_is_separate_from_viewing_account_filter(self):
        for token in (
            'id="updateScopePopover"',
            'id="updateScopeButton"',
            'id="mptAccountList"',
            'id="accountDropdown"',
            "const syncAccountIds=mode==='view'?[]:mptSelectedAccountIds()",
            "params.set('sync_account_id'",
            'Phạm vi tải độc lập',
        ):
            self.assertIn(token, self.dashboard_html)
        self.assertIn('def separate_sync_scope(params):', self.server_source)

    def test_backend_separates_download_scope_without_mutating_report_scope(self):
        params = {"profile_id": "p", "account_id": "view-1", "sync_account_id": "load-2,load-3"}
        sync_params = SERVER.DashboardHandler.separate_sync_scope(params)
        self.assertEqual(params, {"profile_id": "p", "account_id": "view-1"})
        self.assertEqual(sync_params["account_id"], "load-2,load-3")

    def test_mpt_connection_manager_lives_in_settings(self):
        for token in ('id="settingsConnectionContent"', "move('#mptConnectionManager','settingsConnectionContent')", 'id="connectionEmptySettings"'):
            self.assertIn(token, self.dashboard_html)
        self.assertIn("classList.add('btn-danger')", self.dashboard_html)

    def test_closed_dialogs_do_not_leak_into_the_bottom_of_report_tabs(self):
        self.assertIn("body.adw dialog.adw-dialog:not([open]){display:none}", self.dashboard_html)
        self.assertIn(".mapping-panel{margin-top:12px}", self.dashboard_html)
        self.assertNotIn(".mapping-panel{display:none", self.dashboard_html)

    def test_kpi_drilldown_dialog_has_content_and_restores_focus(self):
        for token in ('id="callDrilldownDialog"', 'id="callDrilldownBody"', 'function initDrilldownTriggers()', "trigger.focus()"):
            self.assertIn(token, self.dashboard_html)

    def test_legacy_mpt_source_dialog_is_removed(self):
        self.assertNotIn('id="mptSourcePanel"', self.dashboard_html)
        self.assertNotIn('id="openMptSource"', self.dashboard_html)
        self.assertIn("['updateScopeButton','updateScopePopover']", self.dashboard_html)

    def test_loading_overlay_can_be_dismissed_after_a_failure(self):
        for token in (
            'id="closeReportLoad"',
            "function dismissReportLoading",
            "event.key!=='Escape'",
            "url.searchParams.delete('csv')",
        ):
            self.assertIn(token, self.dashboard_html)

    def test_main_filter_warns_when_range_falls_outside_loaded_data(self):
        for token in (
            'id="mainFilterScope"',
            "function updateFilterScopeNotice",
            "button.addEventListener('click',()=>runUnifiedReport('view'))",
            "Xem khoảng này",
        ):
            self.assertIn(token, self.dashboard_html)

    def test_report_run_is_not_blocked_by_a_missing_account_list(self):
        self.assertIn(
            "button.disabled=!mptActiveProfileId||mptActiveProfile()?.credentialAvailable===false",
            self.dashboard_html,
        )

    def test_multi_account_progress_is_polled_and_served(self):
        for token in ("/api/export-progress", "startReportProgressPolling", "Đang tải tài khoản "):
            self.assertIn(token, self.dashboard_html)
        self.assertIn('parsed.path == "/api/export-progress"', self.server_source)

    def test_yaru_shell_replaces_the_old_control_panel(self):
        for token in (
            '<link rel="stylesheet" href="/dashboard.css">',
            'class="adw-headerbar"',
            'class="adw-filterbar"',
            'id="adwSidebar"',
            'id="adwClamp"',
            'id="appMenu"',
            'id="updateScopePopover"',
            '<dialog id="filesDialog"',
            '<dialog id="optionsDialog"',
            '<dialog id="mappingDialog"',
            "classList.add('adw')",
        ):
            self.assertIn(token, self.dashboard_html)
        self.assertNotIn("classList.add('dashboard-v2')", self.dashboard_html)

    def test_ubuntu_accent_and_local_fonts_are_used(self):
        self.assertIn("#E95420", self.dashboard_html)
        for name in ("UbuntuSans-variable.woff2", "NotoSans-vietnamese.woff2"):
            self.assertTrue((ROOT / "vendor" / name).exists(), name)
            self.assertIn(f"vendor/{name}", self.dashboard_html)
            self.assertIn(f'"/vendor/{name}"', self.server_source)
        # Ubuntu Sans không có glyph tiếng Việt nên phải có font phủ đúng dải đó.
        self.assertIn("U+1EA0-1EF9", self.dashboard_html)

    def test_woff2_is_served_with_a_font_mime_type(self):
        handler = SERVER.DashboardHandler.__new__(SERVER.DashboardHandler)
        self.assertEqual(handler.guess_type("/vendor/UbuntuSans-variable.woff2"), "font/woff2")

    def test_dark_mode_follows_the_desktop_theme_until_the_user_chooses(self):
        self.assertIn("prefers-color-scheme: dark", self.dashboard_html)

    def test_charts_follow_the_yaru_theme(self):
        for token in ("CHART_CATEGORY_COLORS_DARK", "function adwPlotTheme", "function plotLayout", "__adwThemed"):
            self.assertIn(token, self.dashboard_html)

    def test_plot_render_removes_stale_no_data_message(self):
        # Plotly.react giữ lại HTML do showNoData() chèn từ lần render rỗng
        # trước đó, nên phải xóa node này trước khi dựng biểu đồ có dữ liệu.
        self.assertIn("target.querySelectorAll(':scope > .no-data')", self.dashboard_html)
        self.assertIn("forEach(node=>node.remove())", self.dashboard_html)

    def test_account_dropdown_lists_every_account_of_the_connection(self):
        # Tải 1 account xong vẫn phải chọn được account khác: danh sách lấy từ
        # toàn bộ account của kết nối, không chỉ account có trong dữ liệu đã tải.
        self.assertIn("new Set([...mptAccounts.map(item=>String(item.id)), ...loadedIds])", self.dashboard_html)

    def test_main_filter_shows_unapplied_changes(self):
        for token in ("function markFilterDirty", "#applyDateRange,#applyMoreFilters", ".dirty"):
            self.assertIn(token, self.dashboard_html)

    def test_unified_filter_owns_sync_and_report_update(self):
        for token in (
            'id="mainMptProfile"', 'id="updateReport"', '>Cập nhật</button>',
            'id="applyFilter" type="button" hidden', 'id="dataFreshnessDialog"',
            "runUnifiedReport('view')", "runUnifiedReport('update')",
            "function showDataFreshness", "X-MPT-Last-Call", "parsed.searchParams.set('sync','none')",
            'id="mainDirection"', '>Gọi ra</option>', '>Gọi vào</option>',
            'id="mainHangup"', 'id="mainCallType"',
            "function runUnifiedReport(mode='view')", "{view:'none',update:'update',force:'force'}",
            "let reportRequestSeq=0", "datasetToken:requestId",
            "setReportActionsBusy(true,syncMode)",
            "/api/data-status?profile_id=",
        ):
            self.assertIn(token, self.dashboard_html)
        self.assertIn('parsed.path == "/api/data-status"', self.server_source)
        self.assertIn("self.server.call_store.query_csv(params)", self.server_source)
        worker = (ROOT / "dashboard-csv-worker.js").read_text(encoding="utf-8")
        self.assertIn("token < state.datasetToken", worker)

    def test_header_exposes_freshness_and_single_update_action(self):
        for token in (
            'id="dataFreshnessSummary"',
            'id="headerCancelUpdate"',
            'data-menu="view-db"',
            'data-menu="force-update"',
            "function updateDataFreshnessSummary",
            "Thiếu ${missing.length} ngày · bấm Cập nhật",
            "update.textContent=`Đang cập nhật… ${done}/${progress.total}`",
            "runUnifiedReport('force')",
        ):
            self.assertIn(token, self.dashboard_html)

    def test_report_url_restores_direction_and_account_scope(self):
        # Mở lại URL đã lọc phải đồng bộ control với chính dataset đó. Nếu không,
        # đổi Hướng gọi ở lần kế tiếp sẽ âm thầm gửi account_id=0 (tất cả).
        for token in (
            "function reportScopeFromDataUrl(dataUrl)",
            "function applyReportScopeToControls(scope)",
            "mainDirection: params.get('outbound')",
            "activeReportAccountIds=scope.accountIds.slice()",
            "refreshAccountFilter(requestScope&&Array.isArray(requestScope.accountIds)",
        ):
            self.assertIn(token, self.dashboard_html)

    def test_account_labels_separate_fetching_from_viewing(self):
        self.assertIn("Tài khoản cần tải", self.dashboard_html)
        self.assertIn("Tài khoản đang xem", self.dashboard_html)

    def test_last_dataset_is_remembered_and_offered_again(self):
        for token in (
            'id="restoreBanner"',
            "function snapshotSave",
            "function offerLastSnapshot",
            "SNAPSHOT_MAX_ROWS",
        ):
            self.assertIn(token, self.dashboard_html)

    def test_duplicate_connection_is_confirmed_before_saving(self):
        self.assertIn("function mptFindDuplicateProfile", self.dashboard_html)

    def test_html_mapping_export_is_gone(self):
        for token in ("saveMapIntoHtml", "exportHTMLWithMapping", "dashboard_with_mapping.html"):
            self.assertNotIn(token, self.dashboard_html)
        # Export/Import JSON vẫn còn
        self.assertIn('id="exportMap"', self.dashboard_html)

    def test_dead_v2_layer_is_removed(self):
        self.assertNotIn("dashboard-v2", self.dashboard_html)
        self.assertNotIn("--v2-canvas", self.dashboard_html)

    def test_root_opens_integrated_dashboard(self):
        self.assertIn('self.path = f"/{self.server.dashboard}"', self.server_source)
        self.assertIn('target = f"/?csv={encoded}"', self.server_source)


if __name__ == "__main__":
    unittest.main()


RE = SERVER.routing_events


def _row(rid, routing, cid, ts, notes, typ):
    return (f"<tr><td>{rid}</td><td>{routing}</td><td>{cid}</td>"
            f"<td>{ts}</td><td>{notes}</td><td>{typ}</td></tr>")


class RoutingEventParseTests(unittest.TestCase):
    """Boc du lieu tu trang routing/reports (chi co HTML, khong co CSV export)."""

    def test_normalize_cid_phu_het_4_dinh_dang_cua_nguon(self):
        self.assertEqual(RE.normalize_cid("02479929887"), "02479929887")  # 024, 11 so
        self.assertEqual(RE.normalize_cid("0916407599"), "0916407599")    # 09x, 10 so
        self.assertEqual(RE.normalize_cid("842471060319"), "02471060319")  # tien to 84
        self.assertEqual(RE.normalize_cid("919362764"), "0919362764")     # thieu so 0 dau
        self.assertEqual(RE.normalize_cid("+84 916 407 599"), "0916407599")
        self.assertEqual(RE.normalize_cid(""), "")
        self.assertEqual(RE.normalize_cid(None), "")

    def test_parse_notes_lay_duoc_nha_mang_va_actor(self):
        self.assertEqual(RE.parse_notes("Block VT by Verifier CID at 09-07 16:55:51"),
                         ("VT", "Verifier CID"))
        self.assertEqual(RE.parse_notes("Reactive MB by tool at 2026-09-07 15:17:24"),
                         ("MB", "tool"))
        self.assertEqual(RE.parse_notes("Block OT by routingauto at 01-24 10:05:56"),
                         ("OT", "routingauto"))
        # khong khop thi van tra ve tuple, khong duoc nem loi -> dong du lieu con giu
        self.assertEqual(RE.parse_notes("rac"), ("", ""))
        self.assertEqual(RE.parse_notes(None), ("", ""))

    def test_parse_report_rows_chuan_hoa_va_bo_dong_rac(self):
        html = ("<table>"
                + _row(1, "R_A", "842471060319", "2026-09-07 16:41:51",
                       "Block VT by Verifier CID at 09-07 16:41:51", "Block")
                + _row(2, "R_A", "02479929887", "2026-09-07 16:55:51",
                       "Reactive MB by tool at 2026-09-07 16:55:51", "ReActive")
                + "<tr><td>x</td><td>thieu cot</td></tr>"
                + "</table>")
        rows = RE.parse_report_rows(html)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["cid"], "02471060319")   # da chuan hoa
        self.assertEqual(rows[0]["cid_raw"], "842471060319")  # van giu ban goc
        self.assertEqual(rows[0]["kind"], "block")
        self.assertEqual(rows[0]["telco"], "VT")
        self.assertEqual(rows[1]["kind"], "reactive")     # "ReActive" -> reactive

    def test_dedup_bo_dong_lap_nhung_khong_dung_cot_ID(self):
        # Cung mot su kien, chi khac so thu tu ID va moc gio ben trong Notes.
        html = ("<table>"
                + _row(1, "R_A", "0901", "2026-09-05 21:20:36",
                       "Reactive VT by tool at 2026-09-05 21:20:01", "ReActive")
                + _row(2, "R_A", "0901", "2026-09-05 21:20:36",
                       "Reactive VT by tool at 2026-09-05 21:20:12", "ReActive")
                + _row(3, "R_A", "0901", "2026-09-05 22:00:00",
                       "Reactive VT by tool at 2026-09-05 22:00:00", "ReActive")
                + "</table>")
        rows = RE.parse_report_rows(html)
        self.assertEqual(len(rows), 3)
        self.assertEqual(len(RE.dedup_events(rows)), 2)  # gop 2 dong dau


class RoutingEventCacheTests(unittest.TestCase):
    def test_cua_so_cuon_va_prune_bo_ngay_ngoai_cua_so(self):
        from datetime import date
        with tempfile.TemporaryDirectory() as directory:
            cache = RE.RoutingEventCache(directory, "profile-1")
            cache.write_day("2026-09-07", [{"cid": "0901", "ts": "2026-09-07 10:00:00",
                                            "kind": "block", "telco": "VT", "routing": "R"}])
            cache.write_day("2026-01-01", [{"cid": "0902", "ts": "2026-01-01 10:00:00",
                                            "kind": "block", "telco": "VT", "routing": "R"}])
            days = RE.day_range(30, date(2026, 9, 7))
            self.assertEqual(len(days), 30)
            self.assertEqual(days[-1], "2026-09-07")

            events, meta = cache.load_window(30, date(2026, 9, 7))
            self.assertEqual(len(events), 1)                 # ngay 2026-01-01 ngoai cua so
            self.assertEqual(len(meta["missingDays"]), 29)

            cache.prune(days)
            self.assertIsNone(cache.read_day("2026-01-01"))  # da bi xoa
            self.assertIsNotNone(cache.read_day("2026-09-07"))

    def test_cache_tach_rieng_theo_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            a = RE.RoutingEventCache(directory, "p-A")
            b = RE.RoutingEventCache(directory, "p-B")
            a.write_day("2026-09-07", [{"cid": "0901"}])
            self.assertIsNotNone(a.read_day("2026-09-07"))
            self.assertIsNone(b.read_day("2026-09-07"))

    def test_file_hong_khong_lam_sap_ca_cua_so(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = RE.RoutingEventCache(directory, "p")
            cache.write_day("2026-09-07", [{"cid": "0901", "ts": "2026-09-07 10:00:00",
                                            "kind": "block", "telco": "VT", "routing": "R"}])
            cache.dir.joinpath("2026-09-06.json").write_text("{khong phai json", encoding="utf-8")
            from datetime import date
            events, meta = cache.load_window(3, date(2026, 9, 7))
            self.assertEqual(len(events), 1)
            self.assertIn("2026-09-06", meta["missingDays"])  # coi nhu thieu, khong nem loi


class RoutingSyncTests(unittest.TestCase):
    class _FakeClient:
        """Gia lap MptClient: tra ve so dong dat truoc cho moi ngay."""

        def __init__(self, rows_per_day):
            self.base_url = "https://x"
            self.rows_per_day = rows_per_day
            self.asked = []

        def login(self):
            pass

        def post_multipart(self, url, fields):
            day = fields["from_day"]
            self.asked.append(day)
            n = self.rows_per_day.get(day, 0)
            html = "<table>" + "".join(
                _row(i, "R", f"09{i:08d}", f"{day} 10:00:00",
                     "Block VT by Verifier CID at 10:00:00", "Block")
                for i in range(n)
            ) + "</table>"
            return types.SimpleNamespace(read=lambda: html.encode("utf-8"))

    def test_cham_tran_2000_dong_duoc_danh_dau_chu_khong_im_lang(self):
        from datetime import date
        with tempfile.TemporaryDirectory() as directory:
            cache = RE.RoutingEventCache(directory, "p")
            client = self._FakeClient({"2026-09-07": RE.ROW_CAP})
            res = RE.sync(client, cache, days=2, today=date(2026, 9, 7))
            self.assertIn("2026-09-07", res["truncatedDays"])
            _, meta = cache.load_window(2, date(2026, 9, 7))
            self.assertIn("2026-09-07", meta["truncatedDays"])

    def test_chi_tai_ngay_con_thieu_va_luon_tai_lai_ngay_chua_khep(self):
        from datetime import date
        today = date(2026, 9, 7)
        with tempfile.TemporaryDirectory() as directory:
            cache = RE.RoutingEventCache(directory, "p")
            client = self._FakeClient({})
            RE.sync(client, cache, days=5, today=today)
            self.assertEqual(len(client.asked), 5)          # lan dau: tai het

            client2 = self._FakeClient({})
            RE.sync(client2, cache, days=5, today=today)
            # lan hai: chi tai lai ngay chua khep so (hom nay + hom qua)
            self.assertEqual(sorted(client2.asked), ["2026-09-06", "2026-09-07"])


class RoutingOptionsTests(unittest.TestCase):
    def test_parse_routing_options_bo_option_All_va_giu_ten_co_dau_cach(self):
        html = ('<select name="routing_id">'
                '<option value="0">All Routing</option>'
                '<option value="73">HNI_LLV_Omicx</option>'
                '<option value="5991">HNI_Duoc Thai Minh_VBN</option>'
                '</select>')
        got = RE.parse_routing_options(html)
        self.assertEqual(got, [{"id": "73", "name": "HNI_LLV_Omicx"},
                               {"id": "5991", "name": "HNI_Duoc Thai Minh_VBN"}])

    def test_khong_co_select_thi_tra_rong_chu_khong_no(self):
        self.assertEqual(RE.parse_routing_options("<html>trong</html>"), [])
        self.assertEqual(RE.parse_routing_options(""), [])
        self.assertEqual(RE.parse_routing_options(None), [])

    def test_prune_khong_xoa_file_meta_routings(self):
        from datetime import date
        with tempfile.TemporaryDirectory() as directory:
            cache = RE.RoutingEventCache(directory, "p")
            cache.write_routings([{"id": "1", "name": "R"}])
            cache.write_day("2020-01-01", [])          # ngay ngoai cua so
            cache.prune(RE.day_range(5, date(2026, 9, 7)))
            self.assertEqual(cache.read_routings(), [{"id": "1", "name": "R"}])
            self.assertIsNone(cache.read_day("2020-01-01"))


class CidTabTests(unittest.TestCase):
    """Tab Vong doi CID: markup, dispatch render va cac the bao cao."""

    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")

    def test_tab_va_cac_the_bao_cao_co_mat(self):
        self.assertIn('data-tab="cid"', self.HTML)
        self.assertIn("<span>Vòng đời CID</span>", self.HTML)
        for card in ("panel_cid_coverage", "chart_cid_availability", "chart_cid_mttr",
                     "table_cid_mttr_telco", "table_cid_duty", "panel_cid_waste"):
            self.assertIn(f'id="{card}"', self.HTML, f"thiếu thẻ {card}")

    def test_render_duoc_noi_vao_ensure_tab_rendered(self):
        self.assertIn("else if(tabName==='cid') renderCidTab();", self.HTML)
        # Tab CID nay co trong REPORT_LAYOUT (nguon duy nhat) voi primary/secondary
        self.assertIn("cid:{ primary:", self.HTML)
        # panel cau hinh (mapping gateway) nam CUOI thu tu tab CID
        cid_block = self.HTML.split("cid:{ primary:", 1)[1].split("]}", 1)[0]
        self.assertTrue(cid_block.rstrip().rstrip("\n").rstrip().endswith("'panel_gateway_map'"),
                        "panel_gateway_map phai la card cuoi cung cua tab CID")

    def test_tab_luoi_nap_qua_api_rieng_khong_an_theo_bo_loc_CDR(self):
        self.assertIn("fetch('/api/cid-events?'", self.HTML)
        self.assertIn("function loadCidEvents(sync)", self.HTML)
        # chi goi mang khi bam nut, khong nap theo moi lan doi filter
        self.assertIn("t.id === 'cidLoadBtn'", self.HTML)
        self.assertIn("t.id === 'cidSyncBtn'", self.HTML)

    def test_moc_cua_so_lay_tu_meta_chu_khong_suy_tu_du_lieu(self):
        # neu suy tu su kien dau tien thi mau so duty cycle se co gian theo du lieu
        self.assertIn("function cidWindowBounds()", self.HTML)
        self.assertIn("computeCidDutyCycle(cidState.timeline, cidWindowBounds())", self.HTML)

    def test_mau_so_kha_dung_lay_tu_CDR_de_khong_bi_quan(self):
        self.assertIn("function cidUniverseFromCdr(rows)", self.HTML)
        self.assertIn("universeByTelco: universe", self.HTML)


class CidDot3Tests(unittest.TestCase):
    """Dot 3: ap luc chan, dot can quet, ton that."""

    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
    CORE = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")

    def test_the_bao_cao_moi_co_mat_va_duoc_ve(self):
        for card in ("chart_cid_pressure", "table_cid_bursts", "panel_cid_loss"):
            self.assertIn(f'id="{card}"', self.HTML, f"thiếu thẻ {card}")
        self.assertIn("safePlot('chart_cid_pressure'", self.HTML)
        self.assertIn("renderCidBurstTable();", self.HTML)
        self.assertIn("renderCidLoss();", self.HTML)

    def test_ap_luc_chi_dem_block_khong_dem_reactive(self):
        # gop reactive vao se lam duong ap luc nhan doi mot cach vo nghia
        self.assertIn("if(!ev || ev.kind !== 'block') return;", self.CORE)

    def test_nguong_burst_dung_MAD_va_phai_noi_ro_nguon_nguong(self):
        # trung binh + do lech chuan se bi chinh cac dot can quet thoi phong
        self.assertIn("const mad = med(counts.map", self.CORE)
        self.assertIn("thresholdSource", self.CORE)
        self.assertIn("r.thresholdSource === 'floor'", self.HTML)

    def test_ton_that_suy_tu_nen_quan_sat_duoc_va_canh_bao_khi_thieu_mau(self):
        self.assertIn("lostConnections = wastedCalls * baseConnectRate", self.CORE)
        self.assertIn("reliable:", self.CORE)
        self.assertIn("Mẫu nền quá nhỏ", self.HTML)
        # tien chi la cuoc thoai, khong phai gia tri nghiep vu
        self.assertIn("Tiền chỉ tính phần cước thoại", self.HTML)


class CidDot4Tests(unittest.TestCase):
    """Dot 4: tai vs rui ro, chi bao som. Ca hai deu ra ket qua AM TINH."""

    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
    CORE = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")

    def test_the_bao_cao_moi_co_mat_va_duoc_ve(self):
        for card in ("chart_cid_load_risk", "panel_cid_precursors"):
            self.assertIn(f'id="{card}"', self.HTML, f"thiếu thẻ {card}")
        self.assertIn("safePlot('chart_cid_load_risk'", self.HTML)
        self.assertIn("renderCidPrecursors();", self.HTML)

    def test_bieu_do_tai_ve_ca_hai_duong_de_lo_bay_thanh_phan_mau(self):
        # chi ve duong "tat ca CID" se cho ra duong cong lieu-dap-ung dep nhung gia
        self.assertIn("eligibleOnly:true", self.HTML)
        self.assertIn("Chỉ CID từng bị khoá", self.HTML)
        self.assertIn("ẢO GIÁC do thành phần mẫu", self.HTML)

    def test_loai_tru_ngay_dang_bi_khoa_va_ngay_thieu_horizon(self):
        self.assertIn("excludedAlreadyBlocked", self.CORE)
        self.assertIn("excludedNoRoom", self.CORE)
        self.assertIn("excludedNeverBlocked", self.CORE)

    def test_ba_ket_luan_tach_bach_khong_gop_mau_nho_voi_am_tinh(self):
        # gop lai se sinh cau "khong chi so nao dat nguong" ngay canh bang day
        # chi so vuot nguong — mau thuan ngay tren man hinh
        self.assertIn("insufficientSample", self.CORE)
        self.assertIn("Chưa thể kết luận về khả năng cảnh báo sớm", self.HTML)
        self.assertIn("Chưa tìm thấy dấu hiệu đủ ổn định để cảnh báo", self.HTML)
        self.assertIn("chưa nên bật cảnh báo tự động", self.HTML)


class CidSignalPatternTests(unittest.TestCase):
    """Nguyen tac don/kep truoc khi khoa + hai moc 24h/48h."""

    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
    CORE = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")

    def test_hai_moc_24h_do_va_48h_chet(self):
        self.assertIn("const CID_DEAD_AFTER_MIN = 2880;", self.CORE)
        self.assertIn("const CID_WARN_AFTER_MIN = 1440;", self.CORE)
        self.assertIn("atRisk:", self.CORE)
        self.assertIn("recoveredAfterWarn:", self.CORE)
        self.assertIn("Đỏ &gt;24h", self.HTML)
        self.assertIn("Chết &gt;48h", self.HTML)
        # cai gia cua moc do phai nhin thay duoc
        self.assertIn("Đã chuyển đỏ nhưng vẫn quay lại", self.HTML)

    def test_the_don_kep_co_mat_va_duoc_ve(self):
        self.assertIn('id="panel_cid_signals"', self.HTML)
        self.assertIn("renderCidSignals();", self.HTML)
        self.assertIn('id="cidSignalWindow"', self.HTML)

    def test_ba_tin_hieu_va_nguong_lay_tu_doi_chung(self):
        for token in ("causeShare", "avgBillsec", "callsPerHour"):
            self.assertIn(token, self.CORE, f"thiếu tín hiệu {token}")
        self.assertIn("__percentile", self.CORE)
        self.assertIn("hiPercentile", self.CORE)
        # nguong suy bien phai duoc bao ra
        self.assertIn("durationDegenerate", self.CORE)
        self.assertIn("nhiều thời điểm bình thường cũng không có cuộc nào kết nối", self.HTML)

    def test_luon_co_nen_doi_chung_de_so_sanh(self):
        self.assertIn("controlPct", self.CORE)
        self.assertIn("lift:", self.CORE)
        self.assertIn("Mức phổ biến", self.HTML)

    def test_canh_bao_khi_luong_chinh_chi_giu_mau_bi_cat(self):
        # dashState.filtered bi cap o MAIN_ROW_CAP; khong bao thi cac ti le trong
        # nhu tinh tren toan bo du lieu
        self.assertIn("function cidSampleWarning()", self.HTML)
        self.assertIn("mẫu bị cắt", self.HTML)
        self.assertGreaterEqual(self.HTML.count("cidSampleWarning()"), 4)


class CidPerAccountAndPerfTests(unittest.TestCase):
    """Tin hieu theo tung account, ngay hoat dong, va cac toi uu."""

    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
    CORE = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")

    def test_bang_tin_hieu_theo_tung_account(self):
        self.assertIn('id="table_cid_signals_account"', self.HTML)
        self.assertIn("renderCidSignalsByAccount();", self.HTML)
        self.assertIn("function computeSignalsByAccount", self.CORE)

    def test_dem_ngay_co_luu_luong_chu_khong_dem_ngay_lich(self):
        # du lieu that co Chu nhat gan bang 0 va mot dai 5 ngay gian doan
        self.assertIn("function countActiveDays", self.CORE)
        self.assertIn("ngày có phát sinh cuộc gọi", self.HTML)
        self.assertIn("khoảng có lưu lượng đều", self.HTML)

    def test_khong_con_mang_hits_va_khong_quet_lai_CDR(self):
        self.assertIn("sampleLimit", self.CORE)
        self.assertNotIn("leaks.hits.map", self.CORE)
        self.assertIn("leaks.outside.avgBillsec", self.CORE)

    def test_dung_chung_cua_so_precursor_va_leaks(self):
        self.assertIn("function buildPrecursorWindows", self.CORE)
        self.assertIn("o.windows", self.CORE)
        self.assertIn("function cidLeaks(rows)", self.HTML)
        self.assertIn("function cidWindows(rows, hours)", self.HTML)

    def test_duong_kha_dung_rut_gon_bang_ham_giu_DAY(self):
        # giu max se che mat chinh cac dot tut — thu duy nhat dang nhin
        self.assertIn("function downsampleSeriesMin", self.CORE)
        self.assertIn("downsampleSeriesMin(series[t].times", self.HTML)


class GatewayHangupCauseChartTests(unittest.TestCase):
    HTML = ((ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
            + (ROOT / "dashboard.css").read_text(encoding="utf-8"))

    def test_bieu_do_phan_bo_so_cuoc_goi_theo_gateway(self):
        self.assertIn('id="chart_gateway_call_distribution"', self.HTML)
        self.assertIn("function plotGatewayCallDistribution(rows, colors)", self.HTML)
        self.assertIn("title:{text:'Phân bố số lượng cuộc gọi theo Gateway'", self.HTML)
        self.assertIn("cubeVal('gatewayFail'", self.HTML)
        self.assertIn("safePlot('chart_gateway_call_distribution'", self.HTML)
        self.assertIn("Tỷ trọng: %{customdata[0]:.2f}%", self.HTML)

    def test_bieu_do_phan_bo_phan_tram_theo_gateway(self):
        self.assertIn('id="chart_gateway_hangup_cause_pie"', self.HTML)
        self.assertIn("function plotGatewayHangupCausePie(rows)", self.HTML)
        self.assertIn("title:'Phân bố nguyên nhân kết thúc theo Gateway (%)'", self.HTML)
        self.assertIn("type:'bar', orientation:'h'", self.HTML)
        self.assertIn("barmode:'stack', barnorm:'percent'", self.HTML)
        self.assertIn("Không gộp nguyên nhân nhỏ", self.HTML)
        self.assertIn("customdata[1]:.2f", self.HTML)
        self.assertIn(":not(#chart_gateway_hangup_cause_pie)", self.HTML)
        self.assertIn(".chart-report-card>#chart_gateway_hangup_cause_pie{height:auto;min-height:430px;display:block}", self.HTML)
        self.assertIn("#report_chart_gateway_hangup_cause_pie{height:auto;min-height:0;overflow:hidden}", self.HTML)
        self.assertIn("function fitGatewayHangupCauseCard(plot)", self.HTML)
        self.assertIn("card.style.height=`${chartHeight + detailsHeight + 16}px`", self.HTML)
        self.assertIn("layout-full>[id^=\"chart_\"]:not(#chart_gateway_hangup_cause_pie)", self.HTML)

    def test_bieu_do_dung_chung_cube_va_render_trong_tab_advanced(self):
        self.assertIn("cubeVal('gatewayHangupCause'", self.HTML)
        self.assertIn("safePlot('chart_gateway_hangup_cause_pie'", self.HTML)
        self.assertIn("'table_gateway_fail','chart_gateway_call_distribution','chart_gateway_hangup_cause_pie'", self.HTML)

    def test_bang_hangup_cause_thu_gon_theo_tung_gateway(self):
        self.assertIn('id="gatewayHangupCauseGroups"', self.HTML)
        self.assertIn("details.className = 'gateway-cause-group'", self.HTML)
        self.assertIn("details.open = openGateways.has(gateway)", self.HTML)
        self.assertIn("Tỷ trọng lỗi", self.HTML)
        self.assertIn("item.failSharePct.toFixed(2)", self.HTML)
        self.assertNotIn('id="gatewayHangupCauseTable"', self.HTML)


class AdvancedReportLayoutTests(unittest.TestCase):
    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")

    def test_nam_nhom_bao_cao_duoc_tao_va_dinh_vi_dong(self):
        for label in ("Tổng quan vận hành", "Sức khỏe Gateway", "Hiệu suất Account",
                      "Chẩn đoán chuyên sâu", "Dữ liệu chi tiết"):
            self.assertIn(f"label:'{label}'", self.HTML)
        self.assertIn("function positionAdvancedGroupHeaders()", self.HTML)
        self.assertIn("updateAdvancedGroupHeaders(tabName);", self.HTML)

    def test_bay_bao_cao_xem_nhanh_duoc_chon_xuyen_nhom(self):
        expected = "primaryIds:['panel_alerts','table_data_quality','table_gateway_fail','chart_gateway_call_distribution','chart_gateway_hangup_cause_pie','chart_agent_perf','table_agent_perf']"
        self.assertIn(expected, self.HTML)
        self.assertIn("v.primaryIds || v.order.slice(0, v.primary)", self.HTML)

    def test_thu_tu_theo_luong_chan_doan(self):
        advanced = self.HTML.split("advanced:{ primary:7,", 1)[1].split("cid:{ primary:", 1)[0]
        advanced = advanced.split("order:[", 1)[1]
        ordered = ["panel_alerts", "table_data_quality", "table_gateway_fail",
                   "chart_gateway_call_distribution", "chart_gateway_hangup_cause_pie", "chart_gateway_fail_timeline",
                   "chart_agent_perf", "table_gateway_block_reconcile", "table_card"]
        positions = [advanced.index(token) for token in ordered]
        self.assertEqual(positions, sorted(positions))

    def test_bao_cao_rn_chi_tiet_tham_gia_layout_va_nhom_chan_doan(self):
        advanced = self.HTML.split("advanced:{ primary:7,", 1)[1].split("cid:{ primary:", 1)[0]
        self.assertIn("'report_rn_cf_by_account','report_rn_detail'", advanced)
        diagnostics = self.HTML.split("id:'advancedGroupDiagnostics'", 1)[1].split("},", 1)[0]
        self.assertIn("'report_rn_detail'", diagnostics)
        self.assertIn("'report_rn_detail','table_card'", self.HTML)


class CidReadabilityOnReportLayoutTests(unittest.TestCase):
    """Tom tat dau trang + nhan nhom mau xay LAI tren nen REPORT_LAYOUT/Gateway
    (khong dung PRIMARY_REPORTS/tabReportExpanded rieng nhu ban truoc — ban do
    da bi thay the boi REPORT_LAYOUT tu nhanh Gateway)."""

    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")

    def test_tom_tat_va_nhan_nhom_tao_bang_JS_khong_phai_HTML_tinh(self):
        # KHONG duoc co san trong HTML tinh — neu co nghia la lai dung kieu cu
        # (dinh vi tinh, se lech khi REPORT_LAYOUT/keo-tha sap xep lai the).
        self.assertNotIn('<div id="panel_cid_summary"', self.HTML)
        self.assertNotIn('<div id="cidGroupAvail"', self.HTML)
        self.assertIn("function createCidExtras()", self.HTML)
        self.assertIn("function positionCidExtras()", self.HTML)
        self.assertIn("function renderCidSummaryStrip()", self.HTML)

    def test_dinh_vi_bang_resolveReportCard_giong_toggle_co_san(self):
        # dam bao dung DUNG co che positionReportToggles() da dung (anchor bang
        # resolveReportCard), khong tu che ra kieu dinh vi rieng de sai lech
        # voi cac the bi boc lai (chart_cid_pressure, chart_cid_load_risk).
        self.assertIn("resolveReportCard('panel_cid_coverage')", self.HTML)
        self.assertIn("resolveReportCard(g.anchor)", self.HTML)
        self.assertIn("  positionReportToggles();\n  positionCidExtras();\n  positionAdvancedGroupHeaders();\n}\napplyDashboardV2Layout();", self.HTML)
        self.assertIn("    positionReportToggles();\n    positionCidExtras();\n    positionAdvancedGroupHeaders();\n  }catch(e){}\n}", self.HTML)

    def test_5_nhom_mau_khop_dung_REPORT_LAYOUT_cid_order(self):
        for anchor in ("panel_cid_coverage", "chart_cid_pressure", "chart_cid_load_risk",
                       "table_cid_action_queue", "panel_gateway_map"):
            self.assertIn(f"anchor:'{anchor}'", self.HTML)

    def test_bang_ky_thuat_van_an_sau_details(self):
        self.assertIn('<details class="cid-detail-toggle">', self.HTML)
        self.assertIn("Xem số liệu phân tích chuyên sâu", self.HTML)
        self.assertIn("Xem cách hệ thống tính kết quả", self.HTML)

    def test_khong_dung_lai_co_che_PRIMARY_REPORTS_cu_rieng_cho_cid(self):
        # Co che REPORT_LAYOUT (tu nhanh Gateway) da la nguon duy nhat; khong
        # duoc tao lai bien tabReportExpanded/PRIMARY_REPORTS rieng cho cid.
        self.assertIn("const PRIMARY_REPORTS=Object.fromEntries(", self.HTML)
        self.assertNotIn("cid:savedReportExpanded('cid')", self.HTML)
        self.assertNotIn("cid:true};", self.HTML)

    def test_cid_stat_box_dung_chung(self):
        self.assertIn("function cidStatBox(value, label, hint, tone)", self.HTML)
        self.assertIn("const box = (label, value, hint, tone) => cidStatBox(value, label, hint, tone);", self.HTML)
        self.assertIn("const box = cidStatBox;", self.HTML)


class CidLifecycleExpansionTests(unittest.TestCase):
    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
    CORE = (ROOT / "dashboard-core.js").read_text(encoding="utf-8")

    def test_nam_bao_cao_phan_tich_moi_co_mat(self):
        for card in ("chart_cid_recovery_survival", "table_cid_reblock",
                     "chart_cid_inventory_trend", "table_cid_action_queue",
                     "table_cid_comparison"):
            self.assertIn(f'id="{card}"', self.HTML)
        for fn in ("plotCidRecoverySurvival", "renderCidReblockTable",
                   "plotCidInventoryTrend", "renderCidActionQueue",
                   "renderCidComparison"):
            self.assertIn(f"function {fn}", self.HTML)

    def test_tinh_toan_nam_trong_core_va_duoc_xuat(self):
        for fn in ("computeCidRecoverySurvival", "computeCidReblockStats",
                   "computeCidInventoryTrend", "computeCidActionQueue",
                   "computeCidDimensionComparison"):
            self.assertIn(f"function {fn}", self.CORE)
            self.assertIn(fn, self.CORE.split("const __exports =", 1)[1])

    def test_bay_bao_cao_quyet_dinh_mo_mac_dinh(self):
        expected = "primaryIds:['panel_cid_coverage','chart_cid_availability','chart_cid_recovery_survival','chart_cid_pressure','panel_cid_waste','chart_cid_load_risk','table_cid_action_queue']"
        self.assertIn(expected, self.HTML)
        self.assertIn("updateCidGroupHeaders(tabName);", self.HTML)


class CidRiskReportPresentationTests(unittest.TestCase):
    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")

    def test_risk_report_uses_dashboard_components(self):
        for class_name in ("risk-kpi-grid", "risk-table-wrap", "risk-badge",
                           "risk-rate-track", "risk-narrative"):
            self.assertIn(class_name, self.HTML)
        self.assertIn("Xếp hạng rủi ro Gateway", self.HTML)
        self.assertIn("Sắp xếp theo tỷ lệ CID bị khoá giảm dần", self.HTML)

    def test_ai_narrative_is_formatted_instead_of_raw_pre_wrap(self):
        self.assertIn("function llmSafeNarrativeHtml(value)", self.HTML)
        self.assertIn("llmSafeNarrativeHtml(data.narrative)", self.HTML)
        self.assertNotIn('style="white-space:pre-wrap">${reportTableEscape(data.narrative)}', self.HTML)


class LlmRichChatTests(unittest.TestCase):
    HTML = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
    SERVER = (ROOT / "scripts" / "mpt_dashboard_server.py").read_text(encoding="utf-8")

    def test_chat_reads_all_filtered_cube_domains_and_sends_locked_scope(self):
        self.assertIn("buildLlmContext(cube, '__all__'", self.HTML)
        self.assertIn("scope:llmCurrentFilterScope()", self.HTML)
        self.assertIn("appliedFilterKey:dashState.filterKey", self.HTML)
        self.assertIn('scope.get("appliedFilterKey")', self.SERVER)
        self.assertIn("FILTERED_DATABASE_CONTEXT", self.SERVER)

    def test_chat_rejects_oversized_context_before_calling_model(self):
        self.assertIn("if len(user_text) > LLM_ASK_MAX_CHARS:", self.SERVER)
        self.assertIn("Dữ liệu gửi kèm quá lớn", self.SERVER)

    def test_chat_sessions_and_slash_commands(self):
        for token in ("LLM_SESSIONS_KEY", "function llmStartNewSession", "function llmRunCommand",
                      "name:'/new'", "name:'/sessions'", "name:'/resume'", "name:'/compact'",
                      "name:'/context'", 'id="askSessionDrawer"', 'id="askCommandMenu"'):
            self.assertIn(token, self.HTML)
        self.assertIn("history: llmActiveSession().history.slice(-LLM_HISTORY_SEND)", self.HTML)

    def test_chat_renders_structured_visual_blocks_without_model_html(self):
        for token in ("function llmRenderPresentation", "function llmRenderChart",
                      "ai-section", "ai-kpis", "ai-table", "ai-chart", "ai-diagram", "ai-actions"):
            self.assertIn(token, self.HTML)
        self.assertIn("document.createElementNS('http://www.w3.org/2000/svg','svg')", self.HTML)
        self.assertNotIn("div.innerHTML = text", self.HTML)

    def test_chat_frontend_cleans_markdown_fallback(self):
        for token in ("function llmLooksLikeMarkdown", "function llmMarkdownToPresentation",
                      "llmCleanMarkdownText", "onlyTextBlock", "data = llmMarkdownToPresentation"):
            self.assertIn(token, self.HTML)

    def test_chat_composer_and_scope_are_visible(self):
        self.assertIn('id="askScopeLabel"', self.HTML)
        self.assertIn('id="askQuestionInput" rows="1"', self.HTML)
        self.assertIn("Enter để gửi · Shift+Enter để xuống dòng", self.HTML)
        self.assertIn("event.key==='Enter' && !event.shiftKey", self.HTML)
