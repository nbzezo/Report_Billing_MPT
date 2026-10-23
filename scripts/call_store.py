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
from collections import OrderedDict, defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import Lock, RLock


RETENTION_DAYS = 60
TODAY_FRESH_SECONDS = 10 * 60
# MPT ghi CDR khi cuộc gọi kết thúc: một ngày chỉ coi là đủ khi đã đồng bộ sau
# nửa đêm hôm sau một khoảng này.
DAY_SETTLE_SECONDS = 15 * 60
# CSV chỉ còn là đường tương thích/xuất file. Không giữ một dataset hàng trăm MB
# trong RAM; dashboard chính đọc cube + preview qua analytics worker.
QUERY_CACHE_BYTES = 64 * 1024 * 1024
QUERY_CACHE_ITEM_BYTES = 16 * 1024 * 1024
# Các tham số quyết định nội dung query_csv (bỏ sync/job_id...).
QUERY_KEYS = ("profile_id", "from_day", "to_day", "account_id", "caller_number",
              "dest_number", "outbound", "hangupcause", "calltype", "telco")

# Một số tenant MPT không xuất cột Direction. Khi đó normalize_row dùng
# Call Type làm fallback, nên chiều gọi ra mang giá trị External thay vì
# Outbound. Biểu đồ đã coi External là Outbound; query phải dùng cùng quy ước.
DIRECTION_FILTERS = {
    "1": ("outbound", "external"),
    "outbound": ("outbound", "external"),
    "external": ("outbound", "external"),
    "2": ("inbound", "internal"),
    "inbound": ("inbound", "internal"),
    "internal": ("inbound", "internal"),
}

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
    "direction": "direction", "outbound": "direction",
    "calldirection": "direction", "calltype": "calltype", "mos": "mos",
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
    return ""


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
    if not row.get("direction"):
        direction = {
            "outbound": "Outbound", "out": "Outbound",
            "inbound": "Inbound", "in": "Inbound",
        }.get(str(row.get("calltype") or "").strip().lower())
        if direction:
            row["direction"] = direction
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
        "account_id", "caller_id_number", "destination_number", "ani",
        "start_stamp", "answer_stamp", "end_stamp", "duration", "billsec",
        "hangup_cause", "status_code", "direction", "calltype", "telco",
        "packet_count", "rtcp_rtt", "jitter_loss_rate", "raw_json",
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
    def __init__(self, root, retention_days=RETENTION_DAYS,
                 cache_bytes=QUERY_CACHE_BYTES):
        self.root = Path(root)
        self.data_dir = self.root / "data"
        self.path = self.data_dir / "calls.sqlite3"
        self.retention_days = int(retention_days)
        self.lock = RLock()
        # Kết quả query_csv gần nhất theo bộ lọc. Mỗi lần dữ liệu đổi (ingest,
        # dọn cuốn chiếu) thì tăng generation nên cache cũ tự hết hiệu lực.
        self.generation = 0
        self.cache_bytes = int(cache_bytes)
        self._cache = OrderedDict()
        self._cache_lock = Lock()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self.cleanup()

    def _invalidate(self):
        with self._cache_lock:
            self.generation += 1
            self._cache.clear()

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
        # auto_vacuum chỉ có hiệu lực nếu đặt TRƯỚC khi file có trang nào; connect()
        # bật WAL ngay (ghi header) nên phải đặt ở kết nối riêng này. DB cũ đã
        # tạo với auto_vacuum=0 cần compact() một lần mới chuyển được.
        raw = sqlite3.connect(self.path, timeout=30)
        try:
            raw.execute("PRAGMA auto_vacuum=INCREMENTAL")
            raw.execute("PRAGMA journal_mode=WAL")
        finally:
            raw.close()
        with self.connect() as db:
            db.executescript("""
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
                CREATE INDEX IF NOT EXISTS idx_sync_days_profile_day_scope
                    ON sync_days(profile_id, day, account_scope);
                CREATE TABLE IF NOT EXISTS sync_partitions (
                    profile_id TEXT NOT NULL,
                    account_scope TEXT NOT NULL,
                    day TEXT NOT NULL,
                    status TEXT NOT NULL,
                    row_count INTEGER NOT NULL DEFAULT 0,
                    source_hash TEXT NOT NULL DEFAULT '',
                    started_at TEXT,
                    completed_at TEXT,
                    error TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(profile_id, account_scope, day)
                );
                CREATE INDEX IF NOT EXISTS idx_sync_partitions_profile_day_scope
                    ON sync_partitions(profile_id, day, account_scope);
                CREATE TABLE IF NOT EXISTS data_revisions (
                    profile_id TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS account_name_maps (
                    profile_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    account_name TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(profile_id, account_id)
                );
                CREATE TABLE IF NOT EXISTS gateway_mappings (
                    profile_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    routing_id TEXT NOT NULL,
                    routing_name TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(profile_id, account_id, routing_id)
                );
                CREATE TABLE IF NOT EXISTS gateway_cids (
                    profile_id TEXT NOT NULL,
                    cid TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    routing_id TEXT NOT NULL,
                    routing_name TEXT NOT NULL DEFAULT '',
                    gateway TEXT NOT NULL DEFAULT '',
                    telco_status_json TEXT NOT NULL DEFAULT '{}',
                    built_at TEXT NOT NULL,
                    PRIMARY KEY(profile_id, cid)
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
                    status TEXT NOT NULL,
                    error TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_ingestion_runs_profile_finished
                    ON ingestion_runs(profile_id, finished_at DESC);
            """)
            # Database files created by older versions do not receive new
            # columns from CREATE TABLE IF NOT EXISTS.
            run_columns = {
                row[1] for row in db.execute("PRAGMA table_info(ingestion_runs)").fetchall()
            }
            if "error" not in run_columns:
                db.execute(
                    "ALTER TABLE ingestion_runs ADD COLUMN error TEXT NOT NULL DEFAULT ''"
                )
            # Promote legacy day markers into the richer partition table once.
            # Existing partition rows (including running/error) always win.
            db.execute(
                "INSERT OR IGNORE INTO sync_partitions("
                "profile_id,account_scope,day,status,row_count,source_hash,"
                "started_at,completed_at,error,revision) "
                "SELECT profile_id,account_scope,day,'complete',0,'',"
                "synced_at,synced_at,'',0 FROM sync_days"
            )

    def data_revision(self, profile_id):
        with self.connect() as db:
            row = db.execute(
                "SELECT revision FROM data_revisions WHERE profile_id=?", (profile_id,)
            ).fetchone()
        return int(row["revision"]) if row else 0

    def analytics_revision(self, profile_id):
        """Revision token for raw calls plus enrichment inputs."""
        with self.connect() as db:
            data = db.execute(
                "SELECT revision FROM data_revisions WHERE profile_id=?", (profile_id,)
            ).fetchone()
            gateway = db.execute(
                "SELECT COALESCE(MAX(built_at),'') FROM gateway_cids WHERE profile_id=?",
                (profile_id,),
            ).fetchone()[0]
            names = db.execute(
                "SELECT COALESCE(MAX(updated_at),'') FROM account_name_maps WHERE profile_id IN (?, '')",
                (profile_id,),
            ).fetchone()[0]
        return f"{int(data['revision']) if data else 0}:{gateway}:{names}"

    def mark_sync_started(self, profile_id, scopes, from_day, to_day):
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with self.connect() as db:
            for day in self._days(from_day, to_day):
                for scope in (scopes or ["*"]):
                    db.execute(
                        "INSERT INTO sync_partitions(profile_id,account_scope,day,status,started_at,error) "
                        "VALUES(?,?,?,'running',?,'') ON CONFLICT(profile_id,account_scope,day) "
                        "DO UPDATE SET status='running',started_at=excluded.started_at,error=''",
                        (profile_id, scope, day, now),
                    )

    def mark_sync_failed(self, profile_id, scopes, from_day, to_day, error):
        message = str(error or "")[:2000]
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        scope_values = [str(scope) for scope in (scopes or ["*"])]
        with self.connect() as db:
            for day in self._days(from_day, to_day):
                for scope in scope_values:
                    db.execute(
                        "UPDATE sync_partitions SET status='error',error=? "
                        "WHERE profile_id=? AND account_scope=? AND day=?",
                        (message, profile_id, scope, day),
                    )
            db.execute(
                "INSERT INTO ingestion_runs(profile_id,started_at,finished_at,from_day,to_day,"
                "account_scope,source_rows,stored_rows,source_hash,status,error) "
                "VALUES(?,?,?,?,?,?,0,0,'','error',?)",
                (profile_id, now, now, from_day, to_day, ",".join(scope_values), message),
            )

    @staticmethod
    def _days(from_day, to_day):
        start = date.fromisoformat(from_day)
        end = date.fromisoformat(to_day)
        while start <= end:
            yield start.isoformat()
            start += timedelta(days=1)

    def _sync_times_by_day(self, db, profile_id, scopes, from_day, to_day):
        """Load sync coverage for the whole range with one indexed query.

        An all-account (``*``) synchronization may satisfy a specific account,
        while an exact account record takes precedence when both exist.
        """
        scopes = [str(scope) for scope in (scopes or ["*"])]
        candidates = list(dict.fromkeys(scopes + ["*"]))
        placeholders = ",".join("?" for _ in candidates)
        query_params = [profile_id, from_day, to_day] + candidates
        rows = db.execute(
            # sync_partitions is authoritative. The UNION keeps databases/tests
            # with legacy sync_days-only rows compatible without a second query.
            "SELECT account_scope,day,"
            "CASE WHEN status='complete' THEN completed_at ELSE NULL END AS synced_at "
            "FROM sync_partitions WHERE profile_id=? AND day>=? AND day<=? "
            f"AND account_scope IN ({placeholders}) "
            "UNION ALL "
            "SELECT d.account_scope,d.day,d.synced_at FROM sync_days d "
            "WHERE d.profile_id=? AND d.day>=? AND d.day<=? "
            f"AND d.account_scope IN ({placeholders}) AND NOT EXISTS ("
            "SELECT 1 FROM sync_partitions p WHERE p.profile_id=d.profile_id "
            "AND p.account_scope=d.account_scope AND p.day=d.day)",
            query_params + query_params,
        ).fetchall()
        indexed = {(row["account_scope"], row["day"]): row["synced_at"] for row in rows}
        result = {}
        for day in self._days(from_day, to_day):
            times = []
            for scope in scopes:
                raw = indexed.get((scope, day))
                if raw is None and scope != "*":
                    raw = indexed.get(("*", day))
                try:
                    times.append(datetime.fromisoformat(raw) if raw else None)
                except (TypeError, ValueError):
                    times.append(None)
            result[day] = times
        return result

    def _day_sync_times(self, db, profile_id, scopes, day):
        """Compatibility helper for callers that inspect a single day."""
        return self._sync_times_by_day(db, profile_id, scopes, day, day)[day]

    def sync_plan(self, profile_id, account_scopes, from_day, to_day,
                  max_age=TODAY_FRESH_SECONDS):
        """Return the minimal date span that needs another MPT download."""
        scopes = [str(scope) for scope in (account_scopes or ["*"])]
        now = datetime.now().astimezone()
        stale, successful = [], []
        with self.connect() as db:
            coverage = self._sync_times_by_day(
                db, profile_id, scopes, from_day, to_day
            )
        for day, times in coverage.items():
            complete_after = datetime.combine(
                date.fromisoformat(day) + timedelta(days=1), datetime.min.time()
            ).astimezone() + timedelta(seconds=DAY_SETTLE_SECONDS)
            day_stale = False
            for synced in times:
                if synced is None:
                    day_stale = True
                    continue
                if synced.tzinfo is None:
                    synced = synced.astimezone()
                successful.append(synced)
                if synced < complete_after and (now - synced).total_seconds() > max_age:
                    day_stale = True
            if day_stale:
                stale.append(day)
        return {
            "staleDays": stale,
            "nextSyncFrom": min(stale) if stale else "",
            "nextSyncTo": max(stale) if stale else "",
            "lastSuccessfulAt": max(successful).isoformat(timespec="seconds") if successful else "",
        }

    def stale_days(self, profile_id, account_scopes, from_day, to_day,
                   max_age=TODAY_FRESH_SECONDS):
        """Days that must be downloaded again from MPT.

        A day is stale when it was never synchronized, or when the last sync
        happened before the day was over (+ settle time) and is older than
        ``max_age``. The second rule also catches "yesterday" that was synced
        while it was still today, which previously stayed incomplete forever.
        ``max_age=0`` means: refresh every incomplete day now.
        """
        return self.sync_plan(
            profile_id, account_scopes, from_day, to_day, max_age
        )["staleDays"]

    def needs_sync(self, profile_id, account_scopes, from_day, to_day, force=False):
        if force:
            return True
        return bool(self.stale_days(profile_id, account_scopes, from_day, to_day))

    def scope_summary(self, params, account_scopes):
        """What the DB holds for one filter: newest call + sync coverage."""
        profile_id = params.get("profile_id", "")
        from_day, to_day = params.get("from_day", ""), params.get("to_day", "")
        scopes = account_scopes or ["*"]
        where, values = self._where(params)
        missing, synced_times = [], []
        with self.connect() as db:
            row = db.execute(
                "SELECT COUNT(*) AS rows, MAX(start_stamp) AS last_call FROM call_records WHERE " + where,
                values,
            ).fetchone()
            coverage = self._sync_times_by_day(
                db, profile_id, scopes, from_day, to_day
            )
            for day, times in coverage.items():
                if any(t is None for t in times):
                    missing.append(day)
                synced_times.extend(t for t in times if t is not None)
        # Oldest sync of the range = how fresh the WHOLE filter is guaranteed to be.
        return {
            "rows": row["rows"], "lastCall": row["last_call"] or "",
            "syncedAt": min(synced_times).isoformat(timespec="seconds") if synced_times else "",
            "missingDays": missing,
        }

    def ingest_csv(self, profile_id, csv_bytes, account_names, account_scopes,
                   from_day, to_day):
        started = datetime.now().astimezone().isoformat(timespec="seconds")
        digest = hashlib.sha256(csv_bytes).hexdigest()
        text = csv_bytes.decode("utf-8-sig", errors="replace")
        csv_reader = csv.DictReader(io.StringIO(text))
        start_field = next((
            name for name in (csv_reader.fieldnames or [])
            if ALIASES.get(_key(name)) == "start_stamp"
        ), None)
        if not start_field:
            raise ValueError("CSV MPT không có header hoặc cột thời gian bắt đầu.")
        reader = list(csv_reader)
        if any(not _timestamp(raw.get(start_field)) for raw in reader):
            raise ValueError("CSV MPT có thời gian bắt đầu trống hoặc không hợp lệ.")
        reader.sort(key=lambda r: (
            str(r.get("start_stamp") or r.get("starttime") or r.get("calldate") or ""),
            str(r.get("caller_id_number") or r.get("caller") or r.get("callernumber") or ""),
            str(r.get("destination_number") or r.get("destination") or r.get("destnumber") or ""),
            str(r.get("duration") or r.get("callduration") or ""),
            str(r.get("account_id") or r.get("account") or ""),
        ))
        occurrence = defaultdict(int)
        rows = [normalize_row(raw, account_names or {}, occurrence) for raw in reader]
        if any(not (from_day <= row["start_stamp"][:10] <= to_day) for row in rows):
            raise ValueError("CSV MPT có dữ liệu nằm ngoài khoảng ngày đang đồng bộ.")
        scopes = [str(scope) for scope in (account_scopes or ["*"])]
        if len(scopes) == 1 and scopes[0] != "*":
            for row in rows:
                if not row.get("account_id"):
                    row["account_id"] = str(scopes[0])
                    row["account_name"] = str(
                        row.get("account_name") or (account_names or {}).get(str(scopes[0]), "")
                    )
        if scopes != ["*"]:
            unexpected = sorted({
                str(row.get("account_id")) for row in rows
                if row.get("account_id") and str(row.get("account_id")) not in scopes
            })
            if unexpected:
                raise ValueError(
                    "MPT trả dữ liệu ngoài account đang đồng bộ: " + ", ".join(unexpected[:10])
                )
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
            # Một export thành công là snapshot chuẩn của partition được yêu cầu.
            # Xóa partition cũ trước khi chèn để các dòng đã biến mất ở MPT không
            # tồn tại mãi do cơ chế upsert.
            range_values = [profile_id, from_day + " 00:00:00", to_day + " 23:59:59"]
            if scopes == ["*"]:
                db.execute(
                    "DELETE FROM call_records WHERE profile_id=? AND start_stamp>=? AND start_stamp<=?",
                    range_values,
                )
            else:
                placeholders_scope = ",".join("?" for _ in scopes)
                db.execute(
                    "DELETE FROM call_records WHERE profile_id=? AND start_stamp>=? AND start_stamp<=? "
                    f"AND account_id IN ({placeholders_scope})",
                    range_values + list(scopes),
                )
            for row in rows:
                if not row.get("start_stamp"):
                    continue
                record_key = row["uuid"]
                values = [profile_id, record_key]
                values.extend(row.get(column) for column in COLUMNS)
                values.extend([row["raw_json"], now])
                db.execute(sql, values)
            partition_counts = defaultdict(int)
            for row in rows:
                stamp = row.get("start_stamp") or ""
                if stamp:
                    partition_counts[(str(row.get("account_id") or "*"), stamp[:10])] += 1
            revision_row = db.execute(
                "SELECT revision FROM data_revisions WHERE profile_id=?", (profile_id,)
            ).fetchone()
            revision = (int(revision_row["revision"]) if revision_row else 0) + 1
            db.execute(
                "INSERT INTO data_revisions(profile_id,revision,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at",
                (profile_id, revision, now),
            )
            for day in self._days(from_day, to_day):
                for scope in scopes:
                    db.execute(
                        "INSERT INTO sync_days(profile_id,account_scope,day,synced_at) VALUES(?,?,?,?) "
                        "ON CONFLICT(profile_id,account_scope,day) DO UPDATE SET synced_at=excluded.synced_at",
                        (profile_id, scope, day, now),
                    )
                    row_count = (
                        sum(count for (account, row_day), count in partition_counts.items()
                            if row_day == day)
                        if scope == "*" else partition_counts.get((str(scope), day), 0)
                    )
                    db.execute(
                        "INSERT INTO sync_partitions(profile_id,account_scope,day,status,row_count,source_hash,started_at,completed_at,error,revision) "
                        "VALUES(?,?,?,'complete',?,?,?,?,'',?) "
                        "ON CONFLICT(profile_id,account_scope,day) DO UPDATE SET "
                        "status='complete',row_count=excluded.row_count,source_hash=excluded.source_hash,"
                        "completed_at=excluded.completed_at,error='',revision=excluded.revision",
                        (profile_id, scope, day, row_count, digest, started, now, revision),
                    )
            stored = len([row for row in rows if row.get("start_stamp")])
            db.execute(
                "INSERT INTO ingestion_runs(profile_id,started_at,finished_at,from_day,to_day,account_scope,source_rows,stored_rows,source_hash,status,error) VALUES(?,?,?,?,?,?,?,?,?,?,'')",
                (profile_id, started, now, from_day, to_day, ",".join(scopes),
                 len(rows), stored, digest, "ok"),
            )
            db.commit()
        self._invalidate()
        return {"sourceRows": len(rows), "storedRows": stored, "sourceHash": digest,
                "revision": revision}

    def query_csv(self, params):
        key = tuple(str(params.get(name, "") or "") for name in QUERY_KEYS)
        with self._cache_lock:
            generation = self.generation
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                return cached
        where, values = self._where(params)
        sql = "SELECT %s FROM call_records WHERE %s ORDER BY start_stamp" % (
            ",".join(COLUMNS), where
        )
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(COLUMNS)
        with self.connect() as db:
            # Tuple thô + writerows nhanh gấp ~2 lần sqlite3.Row đọc từng cột
            # theo tên; csv ghi None thành chuỗi rỗng như trước.
            db.row_factory = None
            cursor = db.execute(sql, values)
            while True:
                chunk = cursor.fetchmany(20000)
                if not chunk:
                    break
                writer.writerows(chunk)
        data = output.getvalue().encode("utf-8-sig")
        with self._cache_lock:
            # Dữ liệu đổi trong lúc đang đọc -> không lưu kết quả có thể đã cũ.
            if (generation == self.generation and
                    len(data) <= min(self.cache_bytes, QUERY_CACHE_ITEM_BYTES)):
                self._cache[key] = data
                total = sum(len(item) for item in self._cache.values())
                while total > self.cache_bytes:
                    _, dropped = self._cache.popitem(last=False)
                    total -= len(dropped)
        return data

    def stream_csv(self, params, write, chunk_size=20000):
        """Stream a compatibility/export CSV without retaining it in memory."""
        where, values = self._where(params)
        sql = "SELECT %s FROM call_records WHERE %s ORDER BY start_stamp" % (
            ",".join(COLUMNS), where
        )
        write(b"\xef\xbb\xbf" + (",".join(COLUMNS) + "\n").encode("utf-8"))
        with self.connect() as db:
            db.row_factory = None
            cursor = db.execute(sql, values)
            while True:
                rows = cursor.fetchmany(chunk_size)
                if not rows:
                    break
                output = io.StringIO(newline="")
                csv.writer(output, lineterminator="\n").writerows(rows)
                write(output.getvalue().encode("utf-8"))

    @staticmethod
    def _where(params):
        profile_id = params.get("profile_id", "")
        clauses = ["profile_id=?", "start_stamp>=?", "start_stamp<=?"]
        values = [profile_id, params.get("from_day", "") + " 00:00:00",
                  params.get("to_day", "") + " 23:59:59"]
        account_ids = [x for x in params.get("account_id", "").split(",") if x and x != "0"]
        if account_ids:
            clauses.append("account_id IN (%s)" % ",".join("?" for _ in account_ids))
            values.extend(account_ids)
        normalized_params = dict(params)
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
                direction_values = DIRECTION_FILTERS.get(value.strip().lower()) if param == "outbound" else None
                if direction_values:
                    clauses.append(
                        "LOWER(TRIM(direction)) IN (%s)" %
                        ",".join("?" for _ in direction_values)
                    )
                    values.extend(direction_values)
                elif param in {"hangupcause", "calltype", "telco"}:
                    # Các nguồn MPT/CSV dùng hoa-thường không đồng nhất
                    # (MOBI/Mobi, external/External...). Giá trị nghiệp vụ của
                    # các cột phân loại này không phân biệt hoa-thường.
                    clauses.append(f"LOWER(TRIM({column}))=?")
                    values.append(value.strip().lower())
                else:
                    clauses.append(f"{column}=?")
                    values.append(value)
        return " AND ".join(clauses), values

    def cleanup(self):
        cutoff = (date.today() - timedelta(days=max(0, self.retention_days - 1))).isoformat()
        with self.lock, self.connect() as db:
            calls = db.execute(
                "DELETE FROM call_records WHERE substr(start_stamp,1,10) < ?", (cutoff,)
            ).rowcount
            db.execute("DELETE FROM sync_days WHERE day < ?", (cutoff,))
            db.execute("DELETE FROM sync_partitions WHERE day < ?", (cutoff,))
            db.execute("DELETE FROM ingestion_runs WHERE finished_at < ?", (
                (datetime.now().astimezone() - timedelta(days=90)).isoformat(timespec="seconds"),
            ))
            # Trả trang trống về cho hệ điều hành (chỉ tác dụng khi auto_vacuum
            # đã là INCREMENTAL — DB cũ cần compact() một lần).
            db.execute("PRAGMA incremental_vacuum")
        if calls:
            self._invalidate()
        return calls

    def _file_bytes(self):
        total = 0
        for suffix in ("", "-wal"):
            path = Path(str(self.path) + suffix)
            if path.exists():
                total += path.stat().st_size
        return total

    def compact(self):
        """VACUUM toàn bộ file: thu hồi chỗ trống và bật auto_vacuum=INCREMENTAL.

        Chặn mọi ghi trong lúc chạy (giữ self.lock); cần chỗ trống tạm thời
        bằng khoảng kích thước file. Dữ liệu không đổi nên cache vẫn hợp lệ.
        """
        before = self._file_bytes()
        with self.lock:
            db = sqlite3.connect(self.path, timeout=120)
            try:
                db.execute("PRAGMA busy_timeout=120000")
                db.execute("PRAGMA auto_vacuum=INCREMENTAL")
                db.execute("VACUUM")
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                db.close()
        return {"beforeBytes": before, "afterBytes": self._file_bytes()}

    def status(self, profile_id):
        with self.connect() as db:
            row = db.execute(
                "SELECT COUNT(*) AS rows, MIN(substr(start_stamp,1,10)) AS min_day, "
                "MAX(substr(start_stamp,1,10)) AS max_day, MAX(ingested_at) AS updated_at "
                "FROM call_records WHERE profile_id=?", (profile_id,),
            ).fetchone()
            total_rows = db.execute("SELECT COUNT(*) FROM call_records").fetchone()[0]
            page_size = db.execute("PRAGMA page_size").fetchone()[0]
            free_pages = db.execute("PRAGMA freelist_count").fetchone()[0]
            auto_vacuum = db.execute("PRAGMA auto_vacuum").fetchone()[0]
            last_run = db.execute(
                "SELECT started_at,finished_at,from_day,to_day,account_scope,"
                "source_rows,stored_rows,status,error FROM ingestion_runs "
                "WHERE profile_id=? ORDER BY id DESC LIMIT 1",
                (profile_id,),
            ).fetchone()
        run = dict(last_run) if last_run else None
        return {
            "rows": row["rows"], "dateMin": row["min_day"], "dateMax": row["max_day"],
            "updatedAt": row["updated_at"], "retentionDays": self.retention_days,
            "totalRows": total_rows,
            "databaseBytes": self._file_bytes(),
            "freeBytes": free_pages * page_size,
            # 0 = file được tạo trước bản sửa: xoá dữ liệu cũ không làm file nhỏ lại.
            "autoVacuum": auto_vacuum,
            "lastSync": run,
        }

    # --- Account Name Map persistence ---

    def load_account_names(self, profile_id="default"):
        with self.connect() as db:
            rows = db.execute(
                "SELECT account_id, account_name FROM account_name_maps WHERE profile_id=?",
                (profile_id or "default",),
            ).fetchall()
            return {r["account_id"]: r["account_name"] for r in rows}

    def save_account_names(self, profile_id="default", name_map=None):
        if name_map is None and isinstance(profile_id, dict):
            name_map = profile_id
            profile_id = "default"
        now = datetime.now().isoformat(timespec="seconds")
        pid = profile_id or "default"
        with self.connect() as db:
            db.execute("DELETE FROM account_name_maps WHERE profile_id=?", (pid,))
            for acc, name in (name_map or {}).items():
                acc = str(acc).strip()
                if acc:
                    db.execute(
                        "INSERT OR REPLACE INTO account_name_maps (profile_id, account_id, account_name, updated_at) "
                        "VALUES (?, ?, ?, ?)",
                        (pid, acc, str(name or "").strip(), now),
                    )
        return self.load_account_names(profile_id)

    # --- Gateway Map & CIDs persistence ---

    def load_gateway_map(self, profile_id):
        with self.connect() as db:
            rows = db.execute(
                "SELECT account_id, routing_id, routing_name FROM gateway_mappings WHERE profile_id=?",
                (profile_id or "default",),
            ).fetchall()
            out = {}
            for r in rows:
                out.setdefault(r["account_id"], []).append({
                    "routing_id": r["routing_id"],
                    "routing_name": r["routing_name"],
                })
            return out

    def has_gateway_maps(self):
        with self.connect() as db:
            return bool(db.execute("SELECT 1 FROM gateway_mappings LIMIT 1").fetchone())

    def save_gateway_map(self, profile_id, clean_mapping):
        now = datetime.now().isoformat(timespec="seconds")
        pid = profile_id or "default"
        with self.connect() as db:
            db.execute("DELETE FROM gateway_mappings WHERE profile_id=?", (pid,))
            for acc, entries in (clean_mapping or {}).items():
                for e in entries:
                    db.execute(
                        "INSERT OR REPLACE INTO gateway_mappings (profile_id, account_id, routing_id, routing_name, updated_at) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (pid, acc, e["routing_id"], e.get("routing_name", ""), now),
                    )
        return self.load_gateway_map(profile_id)

    def load_gateway_cids_index(self, profile_id):
        with self.connect() as db:
            rows = db.execute(
                "SELECT cid, account_id, routing_id, routing_name, gateway, telco_status_json, built_at "
                "FROM gateway_cids WHERE profile_id=?",
                (profile_id or "default",),
            ).fetchall()
            if not rows:
                return {"cidCount": 0, "index": {}, "builtAt": None}
            idx = {}
            built_at = None
            for r in rows:
                built_at = r["built_at"]
                try:
                    ts = json.loads(r["telco_status_json"])
                except Exception:
                    ts = {}
                idx[r["cid"]] = {
                    "account_id": r["account_id"],
                    "routing_id": r["routing_id"],
                    "routing_name": r["routing_name"],
                    "gateway": r["gateway"],
                    "telco_status": ts,
                }
            return {
                "cidCount": len(idx),
                "builtAt": built_at,
                "index": idx,
            }

    def save_gateway_cids_index(self, profile_id, index_dict, built_at=None):
        now = built_at or datetime.now().isoformat(timespec="seconds")
        pid = profile_id or "default"
        with self.connect() as db:
            db.execute("DELETE FROM gateway_cids WHERE profile_id=?", (pid,))
            for cid, item in (index_dict or {}).items():
                db.execute(
                    "INSERT OR REPLACE INTO gateway_cids "
                    "(profile_id, cid, account_id, routing_id, routing_name, gateway, telco_status_json, built_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        pid,
                        cid,
                        item.get("account_id", ""),
                        item.get("routing_id", ""),
                        item.get("routing_name", ""),
                        item.get("gateway", ""),
                        json.dumps(item.get("telco_status", {}), ensure_ascii=False),
                        now,
                    ),
                )
