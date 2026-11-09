"""Compare exact SQLite, daily aggregates, DuckDB and Parquet on a read-only snapshot.

Install the optional benchmark dependency with:
python -m pip install --target .cache/duckdb-benchmark duckdb==2.0.0
"""

import argparse
import csv
import json
import math
import sqlite3
import sys
import tempfile
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".cache" / "duckdb-benchmark"))


def timed(query):
    start = perf_counter()
    result = query()
    return result, round((perf_counter() - start) * 1000, 3)


def same(actual, expected):
    if len(actual) != len(expected):
        return False
    for left, right in zip(actual, expected):
        if len(left) != len(right):
            return False
        for a, b in zip(left, right):
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                if not math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-6):
                    return False
            elif a != b:
                return False
    return True


def main():
    import duckdb
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=ROOT / "data" / "calls.sqlite3")
    parser.add_argument("--output", type=Path, default=ROOT / ".cache" / "query-benchmark.json")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True)
    source.execute("BEGIN")
    try:
        profile = source.execute("SELECT profile_id,COUNT(*) n FROM call_records GROUP BY profile_id ORDER BY n DESC LIMIT 1").fetchone()
        if not profile:
            raise RuntimeError("No calls to benchmark")
        pid = profile[0]
        bounds = source.execute("SELECT MIN(start_stamp),MAX(start_stamp) FROM call_records WHERE profile_id=?", (pid,)).fetchone()
        params = (pid, bounds[0], bounds[1])
        report = {"duckdbVersion":duckdb.__version__, "profileCalls":profile[1], "mode":"warm-query; conversion measured separately", "queries":{}}
        with tempfile.TemporaryDirectory(prefix="query-benchmark-", dir=args.output.parent.resolve()) as scratch:
            scratch = Path(scratch)
            export = scratch / "calls.csv"
            started = perf_counter()
            print("Exporting a snapshot without phone numbers...", flush=True)
            columns = "profile_id,account_id,start_stamp,billsec,telco,direction,ingested_at"
            with export.open("w", newline="", encoding="utf-8") as stream:
                writer = csv.writer(stream)
                writer.writerow(columns.split(","))
                cursor = source.execute(f"SELECT {columns} FROM call_records")
                while batch := cursor.fetchmany(20000):
                    writer.writerows(batch)
            report["exportSeconds"] = round(perf_counter()-started, 3)
            engine = duckdb.connect(str(scratch / "analytics.duckdb"))
            try:
                engine.execute("SET memory_limit='1GB'")
                engine.execute("SET threads=2")
                started = perf_counter()
                engine.execute("CREATE TABLE calls AS SELECT * FROM read_csv(?, all_varchar=true) ORDER BY profile_id,start_stamp", [str(export)])
                engine.execute("ALTER TABLE calls ALTER billsec TYPE DOUBLE")
                report["duckdbPrepareSeconds"] = round(perf_counter()-started, 3)
                parquet = scratch / "calls.parquet"
                started = perf_counter()
                engine.execute("COPY calls TO ? (FORMAT PARQUET, COMPRESSION ZSTD)", [str(parquet)])
                report["parquetPrepareSeconds"] = round(perf_counter()-started, 3)
                report["parquetMB"] = round(parquet.stat().st_size/1048576, 2)
                where = " WHERE profile_id=? AND start_stamp>=? AND start_stamp<=?"
                queries = {
                    "range_totals": "SELECT COUNT(*),SUM(COALESCE(billsec,0)) FROM {table}" + where,
                    "by_day": "SELECT substr(start_stamp,1,10),COUNT(*),SUM(COALESCE(billsec,0)) FROM {table}" + where + " GROUP BY 1 ORDER BY 1",
                    "by_account": "SELECT COALESCE(account_id,''),COUNT(*),SUM(COALESCE(billsec,0)) FROM {table}" + where + " GROUP BY 1 ORDER BY 1",
                    "by_telco": "SELECT COALESCE(telco,''),COUNT(*),SUM(COALESCE(billsec,0)) FROM {table}" + where + " GROUP BY 1 ORDER BY 1",
                    "by_hour": "SELECT substr(start_stamp,1,13),COUNT(*),SUM(COALESCE(billsec,0)) FROM {table}" + where + " GROUP BY 1 ORDER BY 1",
                    "status": "SELECT COUNT(*),MIN(start_stamp),MAX(start_stamp),MAX(ingested_at) FROM {table}" + where,
                }
                for name, sql in queries.items():
                    print("Measuring " + name + "...", flush=True)
                    expected, sqlite_ms = timed(lambda: source.execute(sql.format(table="call_records"), params).fetchall())
                    actual, duck_ms = timed(lambda: engine.execute(sql.format(table="calls"), params).fetchall())
                    parquet_sql = sql.format(table="read_parquet(?)")
                    columnar, parquet_ms = timed(lambda: engine.execute(parquet_sql, (str(parquet), *params)).fetchall())
                    if not same(actual, expected) or not same(columnar, expected):
                        raise AssertionError("Result mismatch: " + name)
                    report["queries"][name] = {"sqliteMs":sqlite_ms,"duckdbMs":duck_ms,"parquetMs":parquet_ms,"equal":True}
                report["totalCalls"] = source.execute("SELECT COUNT(*) FROM call_records").fetchone()[0]
                if source.execute("SELECT 1 FROM sqlite_master WHERE name='call_daily_stats'").fetchone():
                    stats, stats_ms = timed(lambda: source.execute(
                        "SELECT day,SUM(row_count),SUM(total_billsec) FROM call_daily_stats WHERE profile_id=? GROUP BY day ORDER BY day", (pid,),
                    ).fetchall())
                    raw = source.execute(queries["by_day"].format(table="call_records"), params).fetchall()
                    if not same(stats, raw):
                        raise AssertionError("Daily aggregate mismatch")
                    report["dailyAggregateMs"] = stats_ms
                args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                print(json.dumps(report, indent=2), flush=True)
            finally:
                engine.close()
    finally:
        source.close()


if __name__ == "__main__":
    main()
