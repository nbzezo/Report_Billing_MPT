import importlib.util
import json
import tempfile
import types
import unittest
from pathlib import Path
from threading import Lock


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "scripts" / "mpt_dashboard_server.py"
SPEC = importlib.util.spec_from_file_location("mpt_dashboard_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


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


class ServerSafetyTests(unittest.TestCase):
    def test_static_allowlist_blocks_sensitive_and_backup_files(self):
        dashboard = "V2_0_Call_Dashboard_MPT.html"
        self.assertTrue(SERVER.is_allowed_static_path(f"/{dashboard}", dashboard))
        self.assertTrue(SERVER.is_allowed_static_path("/dashboard-csv-worker.js", dashboard))
        for path in ("/config/profiles.json", "/logs/server.log", "/README.md", "/backup.html", "/.git/config"):
            self.assertFalse(SERVER.is_allowed_static_path(path, dashboard), path)

    def test_domain_normalization(self):
        self.assertEqual(SERVER.normalize_domain("example.com/path"), "https://example.com")
        self.assertEqual(SERVER.normalize_domain(" https://example.com/a "), "https://example.com")
        self.assertEqual(SERVER.normalize_domain(""), "")


class ExportProgressTests(unittest.TestCase):
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

    def test_job_id_is_removed_before_the_export_cache_key_is_built(self):
        source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertLess(
            source.index('params.pop("job_id"'),
            source.index("self.get_cached_export(params)"),
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
        cls.dashboard_html = (ROOT / "V2_0_Call_Dashboard_MPT.html").read_text(encoding="utf-8")
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
        for token in ("reportLoading", "cancelReportLoad", 'role="tablist"', 'aria-live="polite"'):
            self.assertIn(token, self.dashboard_html)

    def test_worker_is_available(self):
        worker = ROOT / "dashboard-csv-worker.js"
        self.assertTrue(worker.exists())
        self.assertIn("self.onmessage", worker.read_text(encoding="utf-8"))

    def test_integrated_mpt_source_panel_loads_report_in_place(self):
        for token in (
            'id="mptSourcePanel"',
            'id="mptProfile"',
            'id="mptAccountList"',
            'id="mptRunReport"',
            'class="mpt-source-primary"',
            'id="mptAdvancedScope"',
            'Tải file thủ công',
            "loadReportDataUrl(mptBuildDataUrl(),true)",
            "history.replaceState",
        ):
            self.assertIn(token, self.dashboard_html)

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
            "function loadMainFilterRangeFromMpt",
            "Tải khoảng này từ MPT",
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
            'id="yaruLayer"',
            'class="adw-headerbar"',
            'class="adw-filterbar"',
            'id="adwSidebar"',
            'id="adwClamp"',
            'id="appMenu"',
            '<dialog id="mptSourcePanel" class="adw-dialog">',
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
        for token in ("YARU_COLORWAY", "function adwPlotTheme", "__adwThemed"):
            self.assertIn(token, self.dashboard_html)

    def test_main_filter_shows_unapplied_changes(self):
        for token in ("function markFilterDirty", "Áp dụng thay đổi", "#applyFilter.dirty"):
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
