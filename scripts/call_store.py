"""SQLite store for normalized MPT call data.

CSV payloads are parsed directly from memory and committed transactionally.  No
temporary CSV is written.  Records are retained for a rolling 31-day window.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import sqlite3
from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import RLock


RETENTION_DAYS = 31
TODAY_FRESH_SECONDS = 10 * 60

ALIASES = {
    "accountid": "account_id", "account": "account_id", "tenant": "account_id",
    "accountname": "account_name",
    "calleridnumber": "caller_id_number", "caller": "caller_id_number",
    "callernumber": "caller_id_number", "callerid": "caller_id_number",
    "fromnumber": "caller_id_number", "outnumber": "caller_id_number",
    "destinationnumber": "destination_number", "destination": "destination_number",
    "destnumber": "destination_number", "called": "destination_number",
    "tonumber": "destination_number", "ani": "ani",
    "uuid": "uuid", "calluuid": "uuid", "callid": "uuid",
    "startstamp": "start_stamp", "starttime": "start_stamp", "calldate": "start_stamp",
    "answerstamp": "answer_stamp", "answertime": "answer_stamp",
    "endstamp": "end_stamp", "endtime": "end_stamp",
    "duration": "duration", "callduration": "duration",
    "billsec": "billsec", "billsecs": "billsec", "billseconds": "billsec",
    "hangupcause": "hangup_cause", "cause": "hangup_cause",
    "statuscode": "status_code", "sipcode": "status_code",
    "telco": "telco", "carrier": "telco", "operator": "telco",
    "direction": "direction", "calltype": "calltype", "mos": "mos",
    "quality": "quality_pct", "qualitypercent": "quality_pct",
    "jitterminms": "jitter_min", "jittermin": "jitter_min",
    "jittermaxms": "jitter_max", "jittermax": "jitter_max",
    "jitterlossrate": "jitter_loss_rate", "packetcount": "packet_count",
    "skippacketcount": "skip_packet_count", "rtcppacketcount": "rtcp_packet_count",
    "rtcprttms": "rtcp_rtt", "rtcprtt": "rtcp_rtt",
}

COLUMNS = (
    "uuid", "account_id", "account_name", "caller_id_number",
    "destination_number", "ani", "direction", "calltype", "start_stamp",
    "answer_stamp", "end_stamp", "duration", "billsec", "hangup_cause",
    "status_code", "telco", "mos", "quality_pct", "jitter_min",
    "jitter_max", "jitter_loss_rate", "packet_count", "skip_packet_count",
    "rtcp_packet_count", "rtcp_rtt", "gateway",
)

NUMERIC = {
    "duration", "billsec", "status_code", "mos", "quality_pct", "jitter_min",
    "jitter_max", "jitter_loss_rate", "packet_count", "skip_packet_count",
    "rtcp_packet_count", "rtcp_rtt",
}


def _key(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _number(value, default=None):
    text = str(value if value is not None else "").strip().replace(",", "")
    if not text:
        return default
    try:
        number = float(text)
        return int(number) if number.is_integer() else number
    except ValueError:
        return default


def _timestamp(value):
    text = str(value or "").strip().strip('"')
    if not text:
        return ""
    patterns = (
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
        "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
    )
    normalized = text.replace("T", " ")
    for pattern in patterns:
        try:
            return datetime.strptime(normalized, pattern).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return normalized


def normalize_row(raw, account_names, occurrence):
    row = {}
    extras = {}
    for original, value in raw.items():
        mapped = ALIASES.get(_key(original))
        if mapped:
            if row.get(mapped) in (None, ""):
                row[mapped] = value
        else:
            extras[original] = value
    if not row.get("direction") and row.get("calltype"):
        row["direction"] = row["calltype"]
    for field in NUMERIC:
        if field in row:
            row[field] = _number(row[field], 0 if field in {"duration", "billsec"} else None)
    row.setdefault("duration", 0)
    row.setdefault("billsec", 0)
    for field in ("start_stamp", "answer_stamp", "end_stamp"):
        row[field] = _timestamp(row.get(field))
    account_id = str(row.get("account_id") or "").strip()
    row["account_id"] = account_id
    row["account_name"] = str(row.get("account_name") or account_names.get(account_id, ""))
    signature = "|".join(str(row.get(k) or "") for k in (
        "account_id", "caller_id_number", "destination_number", "start_stamp",
        "end_stamp", "duration", "billsec", "hangup_cause",
    ))
    uuid = str(row.get("uuid") or "").strip()
    if not uuid:
        occurrence[signature] += 1
        uuid = "gen-" + hashlib.sha256(signature.encode("utf-8")).hexdigest()[:16]
        uuid += f"-{occurrence[signature]}"
    row["uuid"] = uuid
    row["raw_json"] = json.dumps(extras, ensure_ascii=False, separators=(",", ":"))
    return row


class CallStore:
    def __init__(self, root, retention_days=RETENTION_DAYS):
        self.root = Path(root)
        self.data_dir = self.root / "data"
        self.path = self.data_dir / "calls.sqlite3"
        self.retention_days = int(retention_days)
        self.lock = RLock()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self.cleanup()

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=30000")
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _initialize(self):
        with self.connect() as db:
            db.executescript("""
                PRAGMA auto_vacuum=INCREMENTAL;
                CREATE TABLE IF NOT EXISTS call_records (
                    profile_id TEXT NOT NULL,
                    record_key TEXT NOT NULL,
                    uuid TEXT NOT NULL,
                    account_id TEXT,
                    account_name TEXT,
                    caller_id_number TEXT,
                    destination_number TEXT,
                    ani TEXT,
                    direction TEXT,
                    calltype TEXT,
                    start_stamp TEXT NOT NULL,
                    answer_stamp TEXT,
                    end_stamp TEXT,
                    duration REAL,
                    billsec REAL,
                    hangup_cause TEXT,
                    status_code REAL,
                    telco TEXT,
                    mos REAL,
                    quality_pct REAL,
                    jitter_min REAL,
                    jitter_max REAL,
                    jitter_loss_rate REAL,
                    packet_count REAL,
                    skip_packet_count REAL,
                    rtcp_packet_count REAL,
                    rtcp_rtt REAL,
                    gateway TEXT,
                    raw_json TEXT NOT NULL DEFAULT '{}',
                    ingested_at TEXT NOT NULL,
                    PRIMARY KEY (profile_id, record_key)
                );
                CREATE INDEX IF NOT EXISTS idx_calls_profile_time
                    ON call_records(profile_id, start_stamp);
                CREATE INDEX IF NOT EXISTS idx_calls_profile_account_time
                    ON call_records(profile_id, account_id, start_stamp);
                CREATE INDEX IF NOT EXISTS idx_calls_profile_telco_time
                    ON call_records(profile_id, telco, start_stamp);
                CREATE INDEX IF NOT EXISTS idx_calls_profile_caller_time
                    ON call_records(profile_id, caller_id_number, start_stamp);
                CREATE TABLE IF NOT EXISTS sync_days (
                    profile_id TEXT NOT NULL,
                    account_scope TEXT NOT NULL,
                    day TEXT NOT NULL,
                    synced_at TEXT NOT NULL,
                    PRIMARY KEY(profile_id, account_scope, day)
                );
                CREATE TABLE IF NOT EXISTS ingestion_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT NOT NULL,
                    from_day TEXT,
                    to_day TEXT,
                    account_scope TEXT,
                    source_rows INTEGER NOT NULL,
                    stored_rows INTEGER NOT NULL,
                    source_hash TEXT NOT NULL,
                    status TEXT NOT NULL
                );
            """)

    @staticmethod
    def _days(from_day, to_day):
        start = date.fromisoformat(from_day)
        end = date.fromisoformat(to_day)
        while start <= end:
            yield start.isoformat()
            start += timedelta(days=1)

    def needs_sync(self, profile_id, account_scopes, from_day, to_day, force=False):
        if force:
            return True
        scopes = account_scopes or ["*"]
        now = datetime.now().astimezone()
        today = date.today().isoformat()
        with self.connect() as db:
            for day in self._days(from_day, to_day):
                for scope in scopes:
                    row = db.execute(
                        "SELECT synced_at FROM sync_days WHERE profile_id=? AND account_scope IN (?, '*') AND day=? ORDER BY account_scope=? DESC LIMIT 1",
                        (profile_id, scope, day, scope),
                    ).fetchone()
                    if not row:
                        return True
                    if day == today:
                        try:
                            synced = datetime.fromisoformat(row["synced_at"])
                            if (now - synced).total_seconds() > TODAY_FRESH_SECONDS:
                                return True
                        except ValueError:
                            return True
        return False

    def ingest_csv(self, profile_id, csv_bytes, account_names, account_scopes,
                   from_day, to_day):
        started = datetime.now().astimezone().isoformat(timespec="seconds")
        digest = hashlib.sha256(csv_bytes).hexdigest()
        text = csv_bytes.decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        occurrence = defaultdict(int)
        rows = [normalize_row(raw, account_names or {}, occurrence) for raw in reader]
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        placeholders = ",".join("?" for _ in range(2 + len(COLUMNS) + 2))
        sql = f"""
            INSERT INTO call_records (
                profile_id, record_key, {','.join(COLUMNS)}, raw_json, ingested_at
            ) VALUES ({placeholders})
            ON CONFLICT(profile_id, record_key) DO UPDATE SET
                account_id=excluded.account_id, account_name=excluded.account_name,
                caller_id_number=excluded.caller_id_number,
                destination_number=excluded.destination_number, ani=excluded.ani,
                direction=excluded.direction, calltype=excluded.calltype,
                start_stamp=excluded.start_stamp, answer_stamp=excluded.answer_stamp,
                end_stamp=excluded.end_stamp, duration=excluded.duration,
                billsec=excluded.billsec, hangup_cause=excluded.hangup_cause,
                status_code=excluded.status_code, telco=excluded.telco,
                mos=excluded.mos, quality_pct=excluded.quality_pct,
                jitter_min=excluded.jitter_min, jitter_max=excluded.jitter_max,
                jitter_loss_rate=excluded.jitter_loss_rate,
                packet_count=excluded.packet_count,
                skip_packet_count=excluded.skip_packet_count,
                rtcp_packet_count=excluded.rtcp_packet_count,
                rtcp_rtt=excluded.rtcp_rtt, gateway=excluded.gateway,
                raw_json=excluded.raw_json, ingested_at=excluded.ingested_at
        """
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for row in rows:
                if not row.get("start_stamp"):
                    continue
                record_key = row["uuid"]
                values = [profile_id, record_key]
                values.extend(row.get(column) for column in COLUMNS)
                values.extend([row["raw_json"], now])
                db.execute(sql, values)
            scopes = account_scopes or ["*"]
            for day in self._days(from_day, to_day):
                for scope in scopes:
                    db.execute(
                        "INSERT INTO sync_days(profile_id,account_scope,day,synced_at) VALUES(?,?,?,?) "
                        "ON CONFLICT(profile_id,account_scope,day) DO UPDATE SET synced_at=excluded.synced_at",
                        (profile_id, scope, day, now),
                    )
            stored = len([row for row in rows if row.get("start_stamp")])
            db.execute(
                "INSERT INTO ingestion_runs(profile_id,started_at,finished_at,from_day,to_day,account_scope,source_rows,stored_rows,source_hash,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (profile_id, started, now, from_day, to_day, ",".join(scopes),
                 len(rows), stored, digest, "ok"),
            )
            db.commit()
        return {"sourceRows": len(rows), "storedRows": stored, "sourceHash": digest}

    def query_csv(self, params):
        profile_id = params.get("profile_id", "")
        clauses = ["profile_id=?", "start_stamp>=?", "start_stamp<=?"]
        values = [profile_id, params.get("from_day", "") + " 00:00:00",
                  params.get("to_day", "") + " 23:59:59"]
        account_ids = [x for x in params.get("account_id", "").split(",") if x and x != "0"]
        if account_ids:
            clauses.append("account_id IN (%s)" % ",".join("?" for _ in account_ids))
            values.extend(account_ids)
        normalized_params = dict(params)
        normalized_params["outbound"] = {
            "1": "Outbound", "2": "Inbound",
        }.get(str(params.get("outbound", "")), params.get("outbound", ""))
        normalized_params["calltype"] = {
            "1": "Unknown", "2": "Local", "3": "External",
        }.get(str(params.get("calltype", "")), params.get("calltype", ""))
        for param, column in (("caller_number", "caller_id_number"),
                              ("dest_number", "destination_number"),
                              ("outbound", "direction"),
                              ("hangupcause", "hangup_cause"),
                              ("calltype", "calltype"), ("telco", "telco")):
            value = str(normalized_params.get(param, "") or "")
            if value and value != "0":
                clauses.append(f"{column}=?")
                values.append(value)
        sql = "SELECT %s FROM call_records WHERE %s ORDER BY start_stamp" % (
            ",".join(COLUMNS), " AND ".join(clauses)
        )
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(COLUMNS)
        with self.connect() as db:
            for row in db.execute(sql, values):
                writer.writerow([row[column] if row[column] is not None else "" for column in COLUMNS])
        return output.getvalue().encode("utf-8-sig")

    def cleanup(self):
        cutoff = (date.today() - timedelta(days=max(0, self.retention_days - 1))).isoformat()
        with self.lock, self.connect() as db:
            calls = db.execute(
                "DELETE FROM call_records WHERE substr(start_stamp,1,10) < ?", (cutoff,)
            ).rowcount
            db.execute("DELETE FROM sync_days WHERE day < ?", (cutoff,))
            db.execute("DELETE FROM ingestion_runs WHERE finished_at < ?", (
                (datetime.now().astimezone() - timedelta(days=90)).isoformat(timespec="seconds"),
            ))
            db.execute("PRAGMA incremental_vacuum(2000)")
        return calls

    def status(self, profile_id):
        with self.connect() as db:
            row = db.execute(
                "SELECT COUNT(*) AS rows, MIN(substr(start_stamp,1,10)) AS min_day, "
                "MAX(substr(start_stamp,1,10)) AS max_day, MAX(ingested_at) AS updated_at "
                "FROM call_records WHERE profile_id=?", (profile_id,),
            ).fetchone()
        return {
            "rows": row["rows"], "dateMin": row["min_day"], "dateMax": row["max_day"],
            "updatedAt": row["updated_at"], "retentionDays": self.retention_days,
            "databaseBytes": self.path.stat().st_size if self.path.exists() else 0,
        }
