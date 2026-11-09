"""Correctness checks for indexed cleanup, daily stats and SQL drilldown."""

import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import call_store
import mpt_dashboard_app as app
import mpt_dashboard_server as server


def ingest(store, profile, day, rows, scopes=None):
    header = "uuid,account_id,start_stamp,billsec,duration,hangup_cause,telco,direction,calltype\n"
    body = "\n".join(f"{uid},{account},{day} {clock},{bs},{dur},{cause},Viettel,{direction},External"
                     for uid, account, clock, bs, dur, cause, direction in rows)
    return store.ingest_csv(profile, (header + body + "\n").encode(), {}, scopes or ["*"], day, day)


class StorePerformanceTests(unittest.TestCase):
    def test_daily_stats_follow_scoped_replacement_and_actual_unique_rows(self):
        with tempfile.TemporaryDirectory() as root:
            store = call_store.CallStore(root)
            day = date.today().isoformat()
            a = ("a", "1", "10:00:00", 60, 70, "NORMAL_CLEARING", "Outbound")
            b = ("b", "2", "11:00:00", 20, 30, "NORMAL_CLEARING", "Inbound")
            ingest(store, "p", day, [a, a, b])
            self.assertEqual(store.status("p")["rows"], 2)
            ingest(store, "p", day, [("c", "1", "12:00:00", 5, 10, "NORMAL_CLEARING", "Outbound")], ["1"])
            with store.connect() as db:
                self.assertEqual(tuple(db.execute("SELECT SUM(row_count),SUM(total_billsec) FROM call_daily_stats").fetchone()), (2, 25))
                self.assertTrue(store._daily_stats_ready(db, "p"))
            self.assertEqual(store.status("p")["rows"], 2)
            ingest(store, "p", day, [], ["1"])
            self.assertEqual(store.status("p")["rows"], 1)
            self.assertEqual(store.status("p")["totalRows"], 1)

    def test_cleanup_uses_index_and_advances_only_affected_revisions(self):
        with tempfile.TemporaryDirectory() as root:
            store = call_store.CallStore(root)
            old = (date.today() - timedelta(days=60)).isoformat()
            boundary = (date.today() - timedelta(days=59)).isoformat()
            row = ("a", "1", "00:00:00", 5, 10, "NORMAL_CLEARING", "Outbound")
            ingest(store, "p", old, [row])
            ingest(store, "p", boundary, [("boundary", *row[1:])])
            ingest(store, "q", boundary, [row])
            before = {p: store.data_revision(p) for p in ("p", "q")}
            with store.connect() as db:
                plan = str([tuple(r) for r in db.execute("EXPLAIN QUERY PLAN DELETE FROM call_records WHERE start_stamp<?", (boundary + " 00:00:00",))])
                affected_plan = str([tuple(r) for r in db.execute("EXPLAIN QUERY PLAN SELECT DISTINCT profile_id FROM call_records INDEXED BY idx_calls_time WHERE start_stamp<?", (boundary + " 00:00:00",))])
            self.assertIn("idx_calls_time", plan)
            self.assertNotIn("SCAN call_records", plan)
            self.assertNotIn("SCAN call_records", affected_plan)
            self.assertEqual(store.cleanup(), 1)
            self.assertEqual(store.data_revision("p"), before["p"] + 1)
            self.assertEqual(store.data_revision("q"), before["q"])
            status = store.status("p")
            self.assertEqual((status["rows"], status["dateMin"], status["totalRows"]), (1, boundary, 2))
            self.assertEqual(store.cleanup(), 0)
            self.assertEqual(store.data_revision("p"), before["p"] + 1)
            with store.connect() as db:
                self.assertTrue(store._daily_stats_ready(db, "p"))

    def test_legacy_light_status_skips_ingested_scan_and_rebuild_preserves_calls(self):
        with tempfile.TemporaryDirectory() as root:
            store = call_store.CallStore(root)
            day = date.today().isoformat()
            ingest(store, "p", day, [("a", "1", "10:00:00", 60, 70, "NORMAL_CLEARING", "Outbound")])
            expected = store.status("p")
            with store.connect() as db:
                db.execute("DELETE FROM daily_stats_state")
                db.execute("DELETE FROM call_daily_stats")
            store._invalidate()
            light = store.status("p", light=True)
            self.assertIsNone(light["updatedAt"])
            self.assertEqual(light["rows"], expected["rows"])
            self.assertEqual(store.status("p")["updatedAt"], expected["updatedAt"])
            # A partial refresh must not mark incomplete legacy stats as ready.
            ingest(store, "p", day, [], ["other"])
            with store.connect() as db:
                self.assertFalse(store._daily_stats_ready(db, "p"))
            self.assertEqual(store.rebuild_daily_stats(), 1)
            self.assertEqual(store.status("p")["rows"], 1)
            self.assertEqual(store.status("p", light=True)["updatedAt"], expected["updatedAt"])
            with mock.patch.object(call_store.CallStore, "cleanup") as cleanup:
                reopened = call_store.CallStore(root, cleanup_on_start=False)
                cleanup.assert_not_called()
            self.assertEqual(reopened.status("p")["rows"], 1)

    def test_launcher_waits_only_when_stale_processes_were_found(self):
        with mock.patch.object(app.sys, "platform", "win32"), mock.patch.object(app, "_run_hidden") as run, mock.patch.object(app.time, "sleep") as sleep:
            run.return_value.stdout = "0\n"
            app._kill_stale_windows("app-profile")
            sleep.assert_not_called()
            run.return_value.stdout = "2\n"
            app._kill_stale_windows("app-profile")
            sleep.assert_called_once_with(1.0)
            self.assertEqual(run.call_args.kwargs["env"]["MPT_EDGE_MARKER"], "app-profile")

    def test_corrected_call_moving_days_cannot_leave_trusted_stale_stats(self):
        with tempfile.TemporaryDirectory() as root:
            store = call_store.CallStore(root)
            today = date.today().isoformat()
            yesterday = (date.today() - timedelta(days=1)).isoformat()
            row = ("a", "1", "10:00:00", 60, 70, "NORMAL_CLEARING", "Outbound")
            ingest(store, "p", yesterday, [row])
            ingest(store, "p", today, [row])
            with store.connect() as db:
                self.assertFalse(store._daily_stats_ready(db, "p"))
            self.assertEqual(store.status("p")["rows"], 1)
            ingest(store, "p", today, [])
            self.assertEqual(store.status("p")["rows"], 0)
            ingest(store, "p", today, [("b", *row[1:])])
            self.assertEqual(store.status("p")["rows"], 1)
            store.rebuild_daily_stats()
            self.assertEqual(store.status("p")["dateMin"], today)


class WorkerQueryTests(unittest.TestCase):
    def test_native_status_predicate_matches_classifier_matrix(self):
        with tempfile.TemporaryDirectory() as root:
            store = call_store.CallStore(root)
            day = date.today().isoformat()
            causes = ['NORMAL_CLEARING','NO_ROUTE_DESTINATION','CALL_REJECTED','USER_BUSY',
                      'ORIGINATOR_CANCEL','UNALLOCATED_NUMBER','UNKNOWN','\tUSER_BUSY\t','\u00a0CALL_REJECTED\u00a0']
            rows = []
            for cause in causes:
                for bs in (-1, 0, 1):
                    for duration in (-1, 0, 1):
                        rows.append((str(len(rows)), '1', f'10:{len(rows)//60:02}:{len(rows)%60:02}', bs, duration, cause, 'Outbound'))
            ingest(store, 'p', day, rows)
            worker = server.AnalyticsWorker(ROOT, store.path)
            source = {'params':{'profile_id':'p','from_day':day,'to_day':day}, 'datasetKey':'matrix'}
            try:
                for status in ['Connected','No Answer','Cancelled','Fail','CID_Blocked','Non-System Failure','Unknown']:
                    detail = {'startDate':day,'endDate':day,'statuses':[status]}
                    actual = worker.request('detail', **source, detailParams=detail, limit=200)
                    expected = worker.request('detail', **source, detailParams=dict(detail, gatewayKey='(chưa map)'), limit=200)
                    self.assertEqual(actual, expected, status)
            finally:
                worker.stop()

    def test_sql_details_and_daily_minutes_match_raw_algorithms(self):
        with tempfile.TemporaryDirectory() as root:
            store = call_store.CallStore(root)
            day = date.today().isoformat()
            data = [
                ("a", "1", "00:00:00", 60, 70, "NORMAL_CLEARING", "Outbound"),
                ("b", "2", "10:00:00", 20, 30, "NORMAL_CLEARING", "Inbound"),
                ("c", "1", "12:00:00", 5, 10, "NO_ROUTE_DESTINATION", "External"),
                ("d", "1", "23:59:59", 0, 0, "CALL_REJECTED", "Outbound"),
                ("e", "2", "22:00:00", 0, 4, "USER_BUSY", "Inbound"),
            ]
            ingest(store, "p", day, data)
            worker = server.AnalyticsWorker(ROOT, store.path)
            source = {"params": {"profile_id":"p", "from_day":day, "to_day":day}, "datasetKey":"first"}
            cube = {"startDate":day,"endDate":day,"startTime":"00:00","endTime":"23:59","account":"all","sections":["time"]}
            try:
                for extra in ({}, {"statuses":["Connected"]}, {"statuses":["Fail","CID_Blocked"]},
                              {"accountIds":["2"]}, {"startTime":"22:00","endTime":"01:00"},
                              {"account":"1","startTime":"12:00","endTime":"12:00"}):
                    p = dict(cube, **extra)
                    direct = worker.request("detail", **source, detailParams=p, offset=1, limit=2)
                    reference = worker.request("detail", **source, detailParams=dict(p, gatewayKey="(chưa map)"), offset=1, limit=2)
                    self.assertEqual(direct, reference, extra)
                summary = worker.request("cube", **source, cubeParams=cube)["cube"]["minutesPerDay"]
                # Force the raw fallback while retaining the same selected calls.
                raw_source = dict(source, params=dict(source["params"], calltype="External"), datasetKey="raw")
                raw = worker.request("cube", **raw_source, cubeParams=cube)["cube"]["minutesPerDay"]
                self.assertEqual(summary, raw)
                with store.connect() as db:
                    db.execute("UPDATE call_daily_stats SET total_billsec=999999")
                    db.execute("UPDATE data_revisions SET revision=revision+1")
                stale = worker.request("cube", **dict(source, datasetKey="changed"), cubeParams=cube)["cube"]["minutesPerDay"]
                self.assertEqual(stale, raw)
            finally:
                worker.stop()


if __name__ == "__main__":
    unittest.main()
