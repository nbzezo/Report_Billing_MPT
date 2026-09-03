import importlib.util
import json
import shutil
import subprocess
import sys
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
                self.assertEqual(len(server.export_cache), 0)
                self.assertTrue(hasattr(server, "export_cache_lock"))
                self.assertEqual(server.dashboard, "V2_0_Call_Dashboard_MPT.html")
            finally:
                server.server_close()


class ServerSafetyTests(unittest.TestCase):
    def test_static_allowlist_blocks_sensitive_and_backup_files(self):
        dashboard = "V2_0_Call_Dashboard_MPT.html"
        self.assertTrue(SERVER.is_allowed_static_path(f"/{dashboard}", dashboard))
        self.assertTrue(SERVER.is_allowed_static_path("/dashboard-core.js", dashboard))
        self.assertTrue(SERVER.is_allowed_static_path("/dashboard-csv-worker.js", dashboard))
        for path in ("/config/profiles.json", "/logs/server.log", "/README.md", "/backup.html", "/.git/config"):
            self.assertFalse(SERVER.is_allowed_static_path(path, dashboard), path)

    def test_domain_normalization(self):
        self.assertEqual(SERVER.normalize_domain("example.com/path"), "https://example.com")
        self.assertEqual(SERVER.normalize_domain(" https://example.com/a "), "https://example.com")
        self.assertEqual(SERVER.normalize_domain(""), "")


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
        self.assertIn("state = { deduped: [], enriched: [], nameMap: {} }", self.WORKER)
        self.assertIn("buildCube(state.enriched, msg.params", self.WORKER)

    def test_html_load_paths_use_worker_with_main_thread_fallback(self):
        html = self.HTML
        self.assertIn("const dashWorker=(()=>{", html)
        self.assertIn("dashWorker.ingest(text,", html)          # loadReportDataUrl
        self.assertIn("dashWorker.ingestRows(allRows,", html)   # file upload
        self.assertIn("dashWorker.ingestRows(rows,", html)      # applyLoadedRows (snapshot)
        # mỗi nhánh worker phải có else fallback dùng core trực tiếp
        self.assertIn("enrichData(ded.rows, accountNameMap)", html)


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
