"""Test scripts/risk_engine.py — port cua skill telecom-cid-risk-optimizer.

Fixture nho, tong hop tay (khong doc file that), phu cac acceptance test o
muc 38 cua SKILL.md: chuan hoa CID (84.../0...), PAUSE=locked, dem streak,
effective number_random (pool CID/ngay != so CID hoat dong trong 1 cua so 5
phut), interval overlap cho concurrency, ReActive roi Block lai = khong ben
vung. Khong goi mang/LLM o day - risk_engine.py chi tinh so, khong goi LLM
(xem scripts/llm_client.py cho phan viet bao cao).
"""
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import pandas as pd  # noqa: E402

import risk_engine as RE  # noqa: E402


def _cdr_row(cid, start, telco="Viettel", hangup="NORMAL_CLEARING", billsec=10,
             account_id="1", uuid=None, end=None):
    return {
        "account_id": account_id,
        "caller_id_number": cid,
        "start_stamp": start,
        "end_stamp": end or start,
        "billsec": billsec,
        "hangup_cause": hangup,
        "uuid": uuid or f"{cid}-{start}",
        "telco": telco,
    }


def _cdr_df(rows):
    return pd.DataFrame(rows)


def _routing_df(entries):
    """entries: list of (cid, gateway, {telco: status})."""
    rows = []
    for cid, gateway, status in entries:
        row = {"CID": cid, "Gateway": gateway}
        row.update(status)
        rows.append(row)
    return pd.DataFrame(rows)


class CidNormalizationTests(unittest.TestCase):
    def test_84_prefixed_cdr_cid_matches_0_prefixed_routing_cid(self):
        cdr = RE.load_cdr_df(_cdr_df([_cdr_row("842479929887", "2026-09-01 08:00:00")]))
        self.assertEqual(cdr["CID"].iloc[0], "02479929887")

        rt = RE.routing_df_from_gateway_index({
            "02479929887": {"gateway": "GW1", "telco_status": {"viettel": "PAUSE"}}
        })
        self.assertEqual(rt["CID"].iloc[0], "02479929887")
        self.assertEqual(cdr["CID"].iloc[0], rt["CID"].iloc[0])

    def test_events_cache_cid_is_normalized_too(self):
        ev = RE.events_df_from_cache([
            {"cid": "84247 992 9887", "ts": "2026-09-01 09:00:00", "kind": "block", "telco": "VT"}
        ])
        self.assertEqual(ev["CID"].iloc[0], "02479929887")
        self.assertEqual(ev["telco"].iloc[0], "Viettel")


class RoutingLockTruthTests(unittest.TestCase):
    def test_pause_means_locked_on_means_alive(self):
        rt = RE.routing_df_from_gateway_index({
            "0900000001": {"gateway": "GW1", "telco_status": {"viettel": "PAUSE"}},
            "0900000002": {"gateway": "GW1", "telco_status": {"viettel": "ON"}},
        })
        cdr = RE.load_cdr_df(_cdr_df([_cdr_row("0900000001", "2026-09-01 08:00:00")]))
        result = RE.compute(cdr, rt, None, "Viettel")
        self.assertEqual(result["locked_n"], 1)
        self.assertEqual(result["alive_n"], 1)
        self.assertEqual(result["eod_lock_truth"]["Viettel"]["PAUSE"], 1)
        self.assertEqual(result["eod_lock_truth"]["Viettel"]["ON"], 1)


class BacktestStreakTests(unittest.TestCase):
    def test_streak_resets_on_non_matching_flag(self):
        # CALL_REJECTED, CALL_REJECTED, NORMAL_CLEARING, CALL_REJECTED -> streak
        # tối đa trước khi reset là 2 (không phải 3), vì NORMAL_CLEARING cắt chuỗi.
        base = datetime(2026, 9, 1, 8, 0, 0)
        rows = [
            _cdr_row("0900000001", (base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S"),
                     hangup=h, billsec=0 if h != "NORMAL_CLEARING" else 10)
            for i, h in enumerate(["CALL_REJECTED", "CALL_REJECTED", "NORMAL_CLEARING", "CALL_REJECTED"])
        ]
        cdr = RE.load_cdr_df(_cdr_df(rows))
        final_block = {"0900000001": base + timedelta(hours=1)}
        bt, total = RE.backtest(cdr, "is_reject", final_block, xs=[2, 3], windows=(120,))
        self.assertEqual(total, 1)
        # x=2 (đạt streak 2 lần: sau call 1-2, và call 4 không đủ vì chỉ có 1 liên tiếp) -> đúng 1 trigger.
        self.assertEqual(bt["W120_x2"]["triggers"], 1)
        # x=3 không bao giờ đạt được (streak tối đa quan sát được chỉ là 2) -> 0 trigger.
        self.assertEqual(bt["W120_x3"]["triggers"], 0)


class EffectiveNumberRandomTests(unittest.TestCase):
    def test_pool_size_does_not_equal_windowed_activity(self):
        # 10 CID phát sinh trong ngày (pool), nhưng mỗi 5 phút chỉ có 2 CID gọi ra
        # (round-robin cặp đôi) -> effective number_random phải phản ánh 2, không phải 10.
        base = datetime(2026, 9, 1, 8, 0, 0)
        rows = []
        for slot in range(10):  # 10 cửa sổ 5 phút liên tiếp
            window_start = base + timedelta(minutes=5 * slot)
            pair = [slot % 10, (slot + 1) % 10]  # luôn đúng 2 CID khác nhau/cửa sổ
            for j, cid_idx in enumerate(pair):
                ts = window_start + timedelta(seconds=30 * j)
                rows.append(_cdr_row(f"090000{cid_idx:04d}", ts.strftime("%Y-%m-%d %H:%M:%S")))
        cdr = RE.load_cdr_df(_cdr_df(rows))
        rt = RE.routing_df_from_gateway_index({})
        result = RE.compute(cdr, rt, None, "Viettel")
        self.assertEqual(result["distinct_cid_total"], 10)
        self.assertEqual(result["effective_number_random"]["p50"], 2)
        self.assertLessEqual(result["effective_number_random"]["max"], 2)


class ConcurrencyTests(unittest.TestCase):
    def test_uses_interval_overlap_not_just_counts(self):
        cdr = RE.load_cdr_df(_cdr_df([
            _cdr_row("0900000001", "2026-09-01 08:00:00", end="2026-09-01 08:05:00"),
            _cdr_row("0900000002", "2026-09-01 08:02:00", end="2026-09-01 08:07:00"),
            _cdr_row("0900000003", "2026-09-01 09:00:00", end="2026-09-01 09:01:00"),
        ]))
        rt = RE.routing_df_from_gateway_index({})
        result = RE.compute(cdr, rt, None, "Viettel")
        # Cuộc 1 và 2 chồng nhau (08:02-08:05) -> concurrent max = 2, không phải 3.
        self.assertEqual(result["concurrent"]["max"], 2)


class ReactiveSurvivalTests(unittest.TestCase):
    def test_reactive_then_reblock_is_not_durable(self):
        ev = RE.events_df_from_cache([
            {"cid": "0900000001", "ts": "2026-09-01 08:00:00", "kind": "block", "telco": "VT"},
            {"cid": "0900000001", "ts": "2026-09-01 09:00:00", "kind": "reactive", "telco": "VT"},
            {"cid": "0900000001", "ts": "2026-09-01 09:30:00", "kind": "block", "telco": "VT"},
        ])
        cdr = RE.load_cdr_df(_cdr_df([_cdr_row("0900000001", "2026-09-01 08:00:00")]))
        rt = RE.routing_df_from_gateway_index({
            "0900000001": {"gateway": "GW1", "telco_status": {"viettel": "PAUSE"}}
        })
        result = RE.compute(cdr, rt, ev, "Viettel")
        self.assertEqual(result["reactive"]["reblocked"], 1)
        self.assertEqual(result["reactive"]["durable_est"], 0)
        self.assertEqual(result["reactive"]["time_to_reblock_min"]["p50"], 30.0)


class InsufficientSampleTests(unittest.TestCase):
    def test_zero_positive_locks_skips_backtest_section(self):
        cdr = RE.load_cdr_df(_cdr_df([_cdr_row("0900000001", "2026-09-01 08:00:00")]))
        rt = RE.routing_df_from_gateway_index({
            "0900000001": {"gateway": "GW1", "telco_status": {"viettel": "ON"}}
        })
        result = RE.compute(cdr, rt, None, "Viettel")
        self.assertEqual(result["cids_with_block"], 0)
        self.assertNotIn("backtest", result)


class GatewayTypingTests(unittest.TestCase):
    def test_structural_gateway_flagged_when_lock_rate_high_and_density_low(self):
        # 5 CID, tất cả PAUSE (lock_rate=100%), mật độ thấp, không có CALL_REJECTED
        # -> TYPE_C_STRUCTURAL (không phải lỗi load hay error, phải hạ ưu tiên route).
        entries = {}
        rows = []
        base = datetime(2026, 9, 1, 8, 0, 0)
        for i in range(5):
            cid = f"090000{i:04d}"
            entries[cid] = {"gateway": "GW_BAD", "telco_status": {"viettel": "PAUSE"}}
            rows.append(_cdr_row(cid, (base + timedelta(hours=i)).strftime("%Y-%m-%d %H:%M:%S")))
        cdr = RE.load_cdr_df(_cdr_df(rows))
        rt = RE.routing_df_from_gateway_index(entries)
        result = RE.compute(cdr, rt, None, "Viettel")
        self.assertEqual(result["gateway"]["GW_BAD"]["risk_type"], "TYPE_C_STRUCTURAL")
        self.assertEqual(result["gateway"]["GW_BAD"]["lock_rate"], 1.0)


class RunAnalysisEndToEndTests(unittest.TestCase):
    def test_run_analysis_wires_cdr_routing_events_together(self):
        header = "account_id,caller_id_number,start_stamp,end_stamp,billsec,hangup_cause,uuid,telco\n"
        csv_text = header + (
            "1,842479929887,2026-09-01 08:00:00,2026-09-01 08:00:10,10,NORMAL_CLEARING,u1,Viettel\n"
            "1,842479929887,2026-09-01 08:01:00,2026-09-01 08:01:00,0,CALL_REJECTED,u2,Viettel\n"
        )
        csv_bytes = csv_text.encode("utf-8-sig")
        gateway_index = {"02479929887": {"gateway": "GW1", "telco_status": {"viettel": "PAUSE"}}}
        events = [{"cid": "02479929887", "ts": "2026-09-01 07:00:00", "kind": "block", "telco": "VT"}]

        result = RE.run_analysis(csv_bytes, gateway_index, events, "Viettel")
        self.assertEqual(result["telco_calls"], 2)
        self.assertEqual(result["locked_n"], 1)
        self.assertEqual(result["cids_with_block"], 1)
        self.assertIn("backtest", result)


if __name__ == "__main__":
    unittest.main()
