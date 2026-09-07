"""Thu thap lich su Block/Reactive CID tu trang MPT `routing/reports`.

Trang chi tra ve HTML (khong co CSV export) va **chan cung o 2.000 dong** cho moi
truy van, nen module nay keo theo TUNG NGAY roi ghep lai, cache xuong dia va giu
mot cua so cuon 30 ngay.

Cot cua bang: ID | Routing | CID | Time | Notes | Type
  - `ID` la so thu tu HIEN THI (moi truy van deu bat dau tu 1) -> KHONG dung lam khoa.
  - `Notes` chua nha mang dich va actor: "Block VT by Verifier CID at 09-07 16:55:51".
  - Reactive duoc ghi theo lo nen co dong trung cung giay (~8-9%) -> phai dedup.

Cac ham parse deu thuan tuy (khong mang) de test duoc khong can dang nhap.
"""

import json
import re
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path

WINDOW_DAYS = 60           # cua so cuon (2 thang)
ALWAYS_REFETCH_DAYS = 2    # hom nay + hom qua luon tai lai (ngay chua khep)
ROW_CAP = 2000             # tran cua MPT — cham tran nghia la ngay do bi cat


# ---------------------------------------------------------------- chuan hoa

def normalize_cid(raw):
    """Ve dang noi dia `0...`.

    Nguon co 4 dinh dang: `02479929887` (11), `0916407599` (10),
    `842471060319` (12, tien to 84), `919362764` (9, thieu so 0 dau).
    """
    digits = re.sub(r"\D", "", str(raw or ""))
    if not digits:
        return ""
    if digits.startswith("84"):
        digits = "0" + digits[2:]
    elif not digits.startswith("0"):
        digits = "0" + digits
    return digits


_NOTE_RE = re.compile(
    r"^\s*(Block|Reactive)\s+(\w+)\s+by\s+(.+?)\s+at\s+\S+.*$",
    re.IGNORECASE,
)


def parse_notes(notes):
    """`Block VT by Verifier CID at 09-07 16:55:51` -> ('VT', 'Verifier CID').

    Tra ve ('', '') khi khong khop de dong du lieu la van giu duoc, chi mat
    phan telco/actor.
    """
    m = _NOTE_RE.match(str(notes or ""))
    if not m:
        return "", ""
    return m.group(2).upper(), m.group(3).strip()


def normalize_kind(type_cell):
    """Cot Type ghi `Block` / `ReActive` -> 'block' / 'reactive'."""
    v = str(type_cell or "").strip().lower()
    if v.startswith("react"):
        return "reactive"
    if v.startswith("block"):
        return "block"
    return ""


def _strip_tags(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html)).strip()


_TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)


def parse_report_rows(html):
    """Boc bang ket qua thanh cac ban ghi da chuan hoa."""
    out = []
    for tr in _TR_RE.findall(html or ""):
        tds = _TD_RE.findall(tr)
        if len(tds) < 6:
            continue
        cells = [unicodedata.normalize("NFC", _strip_tags(c)) for c in tds]
        _, routing, cid_raw, ts, notes, type_cell = cells[:6]
        kind = normalize_kind(type_cell)
        if not kind or not cid_raw:
            continue
        telco, actor = parse_notes(notes)
        out.append(
            {
                "routing": routing,
                "cid": normalize_cid(cid_raw),
                "cid_raw": cid_raw,
                "ts": ts,
                "kind": kind,
                "telco": telco,
                "actor": actor,
            }
        )
    return out


def event_key(ev):
    """Khoa dedup.

    KHONG dung `ID` (so thu tu hien thi) va KHONG dung `Notes` — cac dong
    reactive trung nhau chi khac moc gio ben trong Notes.
    """
    return (ev.get("routing", ""), ev.get("cid", ""), ev.get("ts", ""),
            ev.get("kind", ""), ev.get("telco", ""))


def dedup_events(events):
    """Giu dong dau tien cho moi khoa, bao toan thu tu."""
    seen = set()
    out = []
    for ev in events or []:
        k = event_key(ev)
        if k in seen:
            continue
        seen.add(k)
        out.append(ev)
    return out


# ---------------------------------------------------------------- cache dia

def day_range(days=WINDOW_DAYS, today=None):
    """Danh sach ngay cua cua so cuon, cu -> moi."""
    end = today or date.today()
    return [(end - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]


class RoutingEventCache:
    """Cache theo ngay, tach rieng theo profile (moi domain la mot the gioi)."""

    def __init__(self, root, profile_id):
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", str(profile_id or "default"))
        self.dir = Path(root) / ".cache" / "cid-events" / safe

    def _path(self, day):
        return self.dir / f"{day}.json"

    def read_day(self, day):
        p = self._path(day)
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    def write_day(self, day, events, truncated=False):
        self.dir.mkdir(parents=True, exist_ok=True)
        self._path(day).write_text(
            json.dumps(
                {
                    "day": day,
                    "fetchedAt": datetime.now().isoformat(timespec="seconds"),
                    "truncated": bool(truncated),
                    "events": events,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    def prune(self, keep_days):
        """Xoa file ngoai cua so cuon."""
        keep = set(keep_days)
        removed = 0
        if not self.dir.exists():
            return 0
        for p in self.dir.glob("*.json"):
            if p.stem not in keep:
                try:
                    p.unlink()
                    removed += 1
                except OSError:
                    pass
        return removed

    def load_window(self, days=WINDOW_DAYS, today=None):
        """Gop toan bo ngay dang co trong cua so -> (events, meta)."""
        wanted = day_range(days, today)
        events, missing, truncated = [], [], []
        for day in wanted:
            rec = self.read_day(day)
            if rec is None:
                missing.append(day)
                continue
            if rec.get("truncated"):
                truncated.append(day)
            events.extend(rec.get("events") or [])
        events = dedup_events(events)
        events.sort(key=lambda e: e.get("ts", ""))
        return events, {
            "days": wanted,
            "missingDays": missing,
            "truncatedDays": truncated,
            "eventCount": len(events),
        }


# ---------------------------------------------------------------- dong bo

def fetch_day(client, day):
    """Keo mot ngay tu MPT. Tra ve (events, truncated)."""
    res = client.post_multipart(
        f"{client.base_url}/routing/reports",
        {
            "routing_id": "0",
            "cid": "",
            "type": "0",
            "from_day": day,
            "to_day": day,
        },
    )
    html = res.read().decode("utf-8", errors="replace")
    rows = parse_report_rows(html)
    return dedup_events(rows), len(rows) >= ROW_CAP


def sync(client, cache, days=WINDOW_DAYS, today=None, progress=None):
    """Bo sung cac ngay con thieu trong cua so cuon.

    Ngay trong `ALWAYS_REFETCH_DAYS` gan nhat luon tai lai vi chua khep so.
    """
    client.login()
    wanted = day_range(days, today)
    end = today or date.today()
    force_from = (end - timedelta(days=ALWAYS_REFETCH_DAYS - 1)).isoformat()

    todo = [d for d in wanted if cache.read_day(d) is None or d >= force_from]
    fetched, truncated_days = 0, []
    for i, day in enumerate(todo):
        if progress:
            progress({"done": i, "total": len(todo), "current": day})
        events, truncated = fetch_day(client, day)
        cache.write_day(day, events, truncated)
        fetched += 1
        if truncated:
            truncated_days.append(day)
    if progress:
        progress({"done": len(todo), "total": len(todo), "current": ""})

    cache.prune(wanted)
    return {"fetchedDays": fetched, "truncatedDays": truncated_days,
            "windowDays": days}
