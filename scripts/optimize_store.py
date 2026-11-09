"""Build query indexes and daily aggregates without deleting historical calls."""

import argparse
import json
from pathlib import Path
from time import perf_counter

from call_store import CallStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    if not (args.root / "data" / "calls.sqlite3").is_file():
        parser.error("No data/calls.sqlite3 in the supplied root")
    started = perf_counter()
    print("Preparing SQLite indexes...", flush=True)
    store = CallStore(args.root, cleanup_on_start=False)
    indexed = perf_counter()
    print("Rebuilding daily aggregates (raw calls are preserved)...", flush=True)
    profiles = store.rebuild_daily_stats()
    finished = perf_counter()
    with store.connect() as db:
        stats = db.execute("SELECT COALESCE(SUM(row_count),0),COUNT(*) FROM call_daily_stats").fetchone()
        raw_count = db.execute("SELECT COUNT(*) FROM call_records").fetchone()[0]
        if stats[0] != raw_count:
            raise RuntimeError("Aggregate row counts do not match raw calls")
        db.execute("PRAGMA optimize")
    print(json.dumps({"profiles": profiles, "calls": raw_count, "aggregateRows": stats[1],
                      "indexSeconds": round(indexed-started, 3),
                      "aggregateSeconds": round(finished-indexed, 3)}, indent=2), flush=True)


if __name__ == "__main__":
    main()
