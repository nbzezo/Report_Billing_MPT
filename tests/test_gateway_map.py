import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GM_PATH = ROOT / "scripts" / "gateway_map.py"
SPEC = importlib.util.spec_from_file_location("gateway_map", GM_PATH)
GM = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GM)

FIXTURE = ROOT / "tests" / "fixtures" / "routing_export_6151.xlsx"
MONITORING_FIXTURE = ROOT / "tests" / "fixtures" / "routing_monitoring.html"


class XlsxParseTests(unittest.TestCase):
    def setUp(self):
        self.rows = GM.read_xlsx_rows(FIXTURE.read_bytes())

    def test_header_matches_expected_columns(self):
        self.assertEqual([str(c).strip() for c in self.rows[0]], GM.EXPECTED_HEADER)

    def test_row_count_is_header_plus_data(self):
        # export 6151 co dung 266 CID (khop bang HTML — khong dinh tran dong)
        self.assertEqual(len(self.rows), 267)

    def test_col_to_idx(self):
        self.assertEqual(GM._col_to_idx("A1"), 0)
        self.assertEqual(GM._col_to_idx("C12"), 2)
        self.assertEqual(GM._col_to_idx("AA7"), 26)
        self.assertIsNone(GM._col_to_idx(""))


class ParseGatewayRowsTests(unittest.TestCase):
    def setUp(self):
        self.parsed = GM.parse_gateway_rows(GM.read_xlsx_rows(FIXTURE.read_bytes()))

    def test_parses_every_cid(self):
        self.assertEqual(len(self.parsed), 266)

    def test_cid_is_normalised_to_local_form(self):
        by_raw = {r["cid_raw"].strip(): r["cid"] for r in self.parsed}
        # co dau cach dau -> phai bo
        self.assertEqual(by_raw["0994345507"], "0994345507")
        # tien to 84 -> ve 0...
        self.assertEqual(by_raw["842888820733"], "02888820733")

    def test_gateway_distribution(self):
        self.assertEqual(
            GM.gateway_summary(self.parsed),
            {"GIP2_new": 2, "Digi_bk": 33, "CMC_Telco": 1,
             "GIP2_cd": 210, "GIP2_BACHKHOA": 20},
        )

    def test_telco_status_captured(self):
        first = self.parsed[0]
        self.assertEqual(first["telco_status"]["viettel"], "PAUSE")
        self.assertEqual(first["telco_status"]["mobi"], "ON")

    def test_reads_by_column_name_not_position(self):
        # dao thu tu cot -> van doc dung nho map theo ten
        rows = GM.read_xlsx_rows(FIXTURE.read_bytes())
        swapped = [list(reversed(r)) for r in rows]
        parsed = GM.parse_gateway_rows(swapped)
        self.assertEqual(len(parsed), 266)
        self.assertEqual(GM.gateway_summary(parsed), GM.gateway_summary(self.parsed))

    def test_blank_rows_skipped(self):
        rows = GM.read_xlsx_rows(FIXTURE.read_bytes())
        rows.insert(3, ["", "", "", "", "", "", "", "", "", ""])
        rows.insert(4, [None] * 10)
        self.assertEqual(len(GM.parse_gateway_rows(rows)), 266)


class StoreTests(unittest.TestCase):
    def _store(self, tmp):
        return GM.GatewayMapStore(tmp, "profile-x")

    def test_save_map_normalises_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            clean = store.save_map({
                "244": [{"routing_id": "6151", "routing_name": "SIP_MTC_AUTOCALL"}],
                "  ": [{"routing_id": "9"}],          # account rong -> bo
                "300": ["7001"],                       # dang chuoi -> thanh dict
                "301": [{"routing_id": "", "routing_name": "x"}],  # routing rong -> bo
            })
            self.assertEqual(set(clean), {"244", "300"})
            self.assertEqual(clean["300"], [{"routing_id": "7001", "routing_name": ""}])
            on_disk = json.loads((Path(tmp) / "config" / "gateway-map.json").read_text("utf-8"))
            self.assertEqual(on_disk, clean)

    def test_routing_to_account_inverts_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.save_map({
                "244": [{"routing_id": "6151"}],
                "245": [{"routing_id": "6151"}, {"routing_id": "6152"}],
            })
            r2a = store.routing_to_account()
            self.assertEqual(sorted(r2a["6151"]), ["244", "245"])
            self.assertEqual(r2a["6152"], ["245"])

    def test_rebuild_index_joins_cached_rows_to_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.save_map({"244": [{"routing_id": "6151",
                                     "routing_name": "SIP_MTC_AUTOCALL"}]})
            rows = GM.parse_gateway_rows(GM.read_xlsx_rows(FIXTURE.read_bytes()))
            store.write_routing("6151", rows, {"cidCount": len(rows)})
            built = store.rebuild_index()
            self.assertEqual(built["cidCount"], 266)
            self.assertEqual(built["conflicts"], [])
            sample = built["index"]["0994345507"]
            self.assertEqual(sample["account_id"], "244")
            self.assertEqual(sample["routing_name"], "SIP_MTC_AUTOCALL")
            self.assertEqual(sample["gateway"], "GIP2_new")

    def test_rebuild_index_flags_cid_claimed_by_two_accounts(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.save_map({
                "244": [{"routing_id": "6151"}],
                "999": [{"routing_id": "6152"}],
            })
            store.write_routing("6151", [
                {"cid": "0900000001", "gateway": "GW_A", "telco_status": {}},
            ], {})
            store.write_routing("6152", [
                {"cid": "0900000001", "gateway": "GW_B", "telco_status": {}},
            ], {})
            built = store.rebuild_index()
            self.assertEqual(built["cidCount"], 1)
            self.assertEqual(len(built["conflicts"]), 1)
            self.assertEqual(built["conflicts"][0]["cid"], "0900000001")

    def test_status_summarises_map_and_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.save_map({"244": [{"routing_id": "6151",
                                     "routing_name": "SIP_MTC_AUTOCALL"}]})
            rows = GM.parse_gateway_rows(GM.read_xlsx_rows(FIXTURE.read_bytes()))
            store.write_routing("6151", rows, {
                "cidCount": len(rows),
                "gateways": GM.gateway_summary(rows),
                "fetchedAt": "2026-09-08T11:00:00",
            })
            store.rebuild_index()
            st = store.status()
            self.assertEqual(st["routings"][0]["routing_id"], "6151")
            self.assertTrue(st["routings"][0]["cached"])
            self.assertEqual(st["routings"][0]["cidCount"], 266)
            self.assertEqual(st["index"]["cidCount"], 266)


class MonitoringAutoMapTests(unittest.TestCase):
    """Tu dong suy account_id <-> routing_id tu trang /routing/monitoring."""

    def test_parse_monitoring_routings_reads_cids_links(self):
        html = MONITORING_FIXTURE.read_text("utf-8")
        routings = GM.parse_monitoring_routings(html)
        self.assertEqual(
            routings,
            [
                {"routing_id": "494", "routing_name": "HNI_Onschool263_3cx"},
                {"routing_id": "777", "routing_name": "HNI_BAOAN_SIP"},
                {"routing_id": "5950", "routing_name": "SIP_SCEX_OTP_C2C"},
                {"routing_id": "5962", "routing_name": "HNI_Palfish_SIP"},
            ],
        )

    def test_parse_ignores_duplicates_and_absolute_urls(self):
        html = (
            '<a href="https://host/routing/cids/6151?x=1">SIP_MTC_AUTOCALL</a>'
            '<a href="/routing/cids/6151">again</a>'          # trung id -> bo
            '<a href="/routing/reports">not a routing</a>'
        )
        self.assertEqual(
            GM.parse_monitoring_routings(html),
            [{"routing_id": "6151", "routing_name": "SIP_MTC_AUTOCALL"}],
        )

    def test_match_routings_to_accounts_by_name(self):
        routings = [
            {"routing_id": "5976", "routing_name": "HNI_IMAP_DIDONG_PS3"},
            {"routing_id": "6151", "routing_name": "sip mtc autocall"},   # khop chuan hoa
            {"routing_id": "9999", "routing_name": "KHONG_CO_ACCOUNT"},
        ]
        accounts = [
            {"id": "368", "name": "HNI_IMAP_DIDONG_PS3"},
            {"id": "548", "name": "SIP_MTC_AUTOCALL"},
        ]
        mapping, unmatched = GM.match_routings_to_accounts(routings, accounts)
        self.assertEqual(mapping["368"], [{"routing_id": "5976",
                                          "routing_name": "HNI_IMAP_DIDONG_PS3"}])
        self.assertEqual(mapping["548"], [{"routing_id": "6151",
                                          "routing_name": "sip mtc autocall"}])
        self.assertEqual(unmatched, [{"routing_id": "9999",
                                      "routing_name": "KHONG_CO_ACCOUNT"}])

    def test_merge_maps_keeps_manual_entries_and_adds_new(self):
        base = {
            "548": [{"routing_id": "6151", "routing_name": "SIP_MTC_AUTOCALL"}],
            "368": [{"routing_id": "5976", "routing_name": ""}],   # ten con trong
        }
        discovered = {
            "368": [{"routing_id": "5976", "routing_name": "HNI_IMAP_DIDONG_PS3"}],
            "514": [{"routing_id": "6118", "routing_name": "HNI_TALA2_SIP"}],
        }
        merged, added = GM.merge_maps(base, discovered)
        self.assertEqual(added, 1)                                  # chi 514 la moi
        self.assertEqual(merged["548"], base["548"])                # giu nguyen
        self.assertEqual(merged["368"][0]["routing_name"], "HNI_IMAP_DIDONG_PS3")
        self.assertEqual(merged["514"], discovered["514"])

    def test_auto_map_writes_map_and_index_without_sync(self):
        class FakeClient:
            base_url = "https://host"

            def login(self):
                pass

            class _Opener:
                @staticmethod
                def open(req, timeout=0):
                    class R:
                        headers = {"Content-Type": "text/html"}

                        @staticmethod
                        def read():
                            return MONITORING_FIXTURE.read_bytes()

                    return R()

            opener = _Opener()

        with tempfile.TemporaryDirectory() as tmp:
            store = GM.GatewayMapStore(tmp, "profile-x")
            store.save_map({"244": [{"routing_id": "777",
                                     "routing_name": "HNI_BAOAN_SIP"}]})  # tay
            accounts = [
                {"id": "225", "name": "HNI_Onschool263_3cx"},
                {"id": "244", "name": "HNI_BAOAN_SIP"},
                {"id": "334", "name": "SIP_SCEX_OTP_C2C"},
            ]
            result = GM.auto_map(FakeClient(), store, accounts, do_sync=False)
            self.assertEqual(result["monitoringRoutings"], 4)
            self.assertEqual(result["added"], 2)          # 494 + 5950 (777 da co)
            self.assertEqual(len(result["unmatched"]), 1)  # 5962 HNI_Palfish_SIP
            on_disk = json.loads(
                (Path(tmp) / "config" / "gateway-map.json").read_text("utf-8")
            )
            self.assertEqual(sorted(on_disk), ["225", "244", "334"])
            self.assertEqual(on_disk["244"], [{"routing_id": "777",
                                               "routing_name": "HNI_BAOAN_SIP"}])


if __name__ == "__main__":
    unittest.main()
