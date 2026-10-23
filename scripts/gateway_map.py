"""Gateway theo CID, lay tu trang MPT `routing/cids/<routing_id>`.

Trang co nut Export -> GET `/routing/exportCid/<routing_id>` tra ve mot file
.xlsx that (Content-Disposition attachment). Cot cua sheet:

    Position | Gateway | CID | Status | Viettel | Mobi | Vina | Other | Desc | Notes

MPT KHONG gan account vao trang nay. `account_id` do nguoi dung gan tay voi
`routing_id` (SQLite; file JSON cũ chỉ được migration một lần) qua giao dien app. Moi CID trong export
cua routing 6151 => thuoc account da map voi 6151 (suy mot lan, cache lai).

Parse .xlsx bang stdlib (zipfile + xml) de ban portable khong phai them openpyxl
— dung tinh than routing_events.py chi dung urllib + re. Cac ham parse la thuan
tuy (khong mang), test duoc khong can dang nhap.
"""

import io
import json
import re
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime
from pathlib import Path

import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent))
from routing_events import normalize_cid  # noqa: E402  (cung nguon CID, cung 4 dinh dang)
import call_store  # noqa: E402

_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
EXPECTED_HEADER = ["Position", "Gateway", "CID", "Status",
                   "Viettel", "Mobi", "Vina", "Other", "Desc", "Notes"]


# ---------------------------------------------------------------- doc .xlsx

def _col_to_idx(ref):
    """'C12' -> 2 (chi so cot, 0-based). None neu ref rong/sai."""
    m = re.match(r"[A-Za-z]+", ref or "")
    if not m:
        return None
    n = 0
    for ch in m.group(0).upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_xlsx_rows(data):
    """bytes .xlsx -> list[list[str]] (ke ca dong header).

    Ho tro inlineStr (MPT dung toan bo) + shared string + so tho. Du cho file
    routing: khong ngay/cong thuc.
    """
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = zf.namelist()

    shared = []
    if "xl/sharedStrings.xml" in names:
        sroot = ET.fromstring(zf.read("xl/sharedStrings.xml"))
        for si in sroot.findall(f"{_NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{_NS}t")))

    sheet = "xl/worksheets/sheet1.xml"
    if sheet not in names:
        cand = sorted(n for n in names
                      if n.startswith("xl/worksheets/") and n.endswith(".xml"))
        if not cand:
            return []
        sheet = cand[0]

    root = ET.fromstring(zf.read(sheet))
    out = []
    for row in root.iter(f"{_NS}row"):
        cells = []
        for c in row.findall(f"{_NS}c"):
            idx = _col_to_idx(c.get("r", ""))
            ctype = c.get("t")
            if ctype == "inlineStr":
                is_el = c.find(f"{_NS}is")
                val = ("".join(x.text or "" for x in is_el.iter(f"{_NS}t"))
                       if is_el is not None else "")
            elif ctype == "s":
                v = c.find(f"{_NS}v")
                try:
                    val = shared[int(v.text)] if v is not None and v.text else ""
                except (ValueError, IndexError):
                    val = ""
            else:
                v = c.find(f"{_NS}v")
                val = (v.text or "") if v is not None else ""
            if idx is None:
                cells.append(val)
            else:
                while len(cells) <= idx:
                    cells.append("")
                cells[idx] = val
        out.append(cells)
    return out


# ---------------------------------------------------------------- parse bang

def parse_gateway_rows(rows):
    """list[list[str]] (ke ca header) -> list[dict], mot ban ghi moi CID.

    Doc theo TEN cot (khong phu thuoc thu tu tuyet doi) de con chiu duoc neu MPT
    doi vi tri cot. CID chuan hoa ve dang noi dia `0...` de join voi CDR.
    """
    if not rows:
        return []
    header = [str(h or "").strip() for h in rows[0]]
    col = {name.lower(): i for i, name in enumerate(header) if name}

    def cell(r, key):
        i = col.get(key)
        if i is None or i >= len(r) or r[i] is None:
            return ""
        return str(r[i]).strip()

    out = []
    for r in rows[1:]:
        if not r or not any(str(x or "").strip() for x in r):
            continue
        cid_raw = cell(r, "cid")
        if not cid_raw:
            continue
        out.append({
            "position": cell(r, "position"),
            "gateway": cell(r, "gateway"),
            "cid_raw": cid_raw,
            "cid": normalize_cid(cid_raw),
            "status": cell(r, "status"),
            "telco_status": {
                "viettel": cell(r, "viettel"),
                "mobi": cell(r, "mobi"),
                "vina": cell(r, "vina"),
                "other": cell(r, "other"),
            },
            "notes": cell(r, "notes"),
        })
    return out


def gateway_summary(rows):
    """{gateway: so CID} — de hien thi nhanh sau khi dong bo."""
    out = {}
    for row in rows:
        g = row.get("gateway") or "(trong)"
        out[g] = out.get(g, 0) + 1
    return out


# ---------------------------------------------------------------- tai tu MPT

def fetch_routing_cids(client, routing_id):
    """GET /routing/exportCid/<routing_id> -> (rows: list[dict], meta: dict).

    Nem RuntimeError neu MPT khong tra .xlsx (thuong la do het phien dang nhap
    hoac routing_id sai — luc do no tra lai trang HTML).
    """
    url = f"{client.base_url}/routing/exportCid/{routing_id}"
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0 MPT Dashboard Local")
    res = client.opener.open(req, timeout=120)
    ctype = res.headers.get("Content-Type", "")
    data = res.read()
    if data[:2] != b"PK":
        raise RuntimeError(
            f"routing {routing_id}: MPT khong tra .xlsx (Content-Type={ctype!r}, "
            f"{len(data)} bytes). Kiem tra dang nhap va routing_id."
        )
    rows = parse_gateway_rows(read_xlsx_rows(data))
    meta = {
        "routing_id": str(routing_id),
        "url": url,
        "cidCount": len(rows),
        "gateways": gateway_summary(rows),
        "fetchedAt": datetime.now().isoformat(timespec="seconds"),
    }
    return rows, meta


# ----------------------------------------------- tu dong suy mapping tu monitoring
# Trang `/routing/monitoring`, muc "Routing Auto": moi routing la mot bang nho,
# caption `<h5><a href=".../routing/cids/<id>">TEN_ROUTING</a></h5>`. Ten routing
# o day thuong TRUNG ten account (vd HNI_IMAP_DIDONG_PS3) nen suy duoc
# account_id <-> routing_id ma khong phai go tay.

_CIDS_LINK_RE = re.compile(
    r'<a\b[^>]*href=["\'][^"\']*?/routing/cids/(\d+)[^"\']*["\'][^>]*>(.*?)</a>',
    re.I | re.S,
)


def _clean_text(html_fragment):
    txt = re.sub(r"<[^>]+>", "", html_fragment or "")
    return unicodedata.normalize("NFC", re.sub(r"\s+", " ", txt)).strip()


def parse_monitoring_routings(html):
    """HTML trang monitoring -> list[{routing_id, routing_name}] (khong trung).

    Doc theo link `/routing/cids/<id>` nen khong phu thuoc bo cuc bang.
    """
    seen, out = set(), []
    for rid, label in _CIDS_LINK_RE.findall(html or ""):
        if rid in seen:
            continue
        seen.add(rid)
        out.append({"routing_id": rid, "routing_name": _clean_text(label)})
    return out


def fetch_monitoring_routings(client):
    """GET /routing/monitoring -> parse_monitoring_routings.

    Nem RuntimeError neu khong thay routing nao (thuong la het phien -> MPT tra
    ve trang dang nhap).
    """
    url = f"{client.base_url}/routing/monitoring"
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0 MPT Dashboard Local")
    html = client.opener.open(req, timeout=90).read().decode("utf-8", errors="replace")
    routings = parse_monitoring_routings(html)
    if not routings:
        raise RuntimeError(
            "routing/monitoring: khong thay routing nao "
            "(co the het phien dang nhap)."
        )
    return routings


def _norm_name(value):
    """Ten -> khoa so khop: bo dau, ha thuong, bo ky tu khong phai chu-so."""
    s = unicodedata.normalize("NFKD", str(value or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s.lower())


def match_routings_to_accounts(routings, accounts):
    """(routings tu monitoring, accounts [{id,name}]) ->
    ({account_id: [{routing_id, routing_name}]}, unmatched: list).

    Khop ten routing == ten account: uu tien khop chinh xac roi khop chuan hoa.
    """
    by_exact, by_norm = {}, {}
    for acc in accounts or []:
        aid = str(acc.get("id") or "").strip()
        name = str(acc.get("name") or "").strip()
        if not aid or not name:
            continue
        by_exact.setdefault(name, aid)
        by_norm.setdefault(_norm_name(name), aid)

    mapping, unmatched = {}, []
    for r in routings:
        rid, rname = r["routing_id"], r["routing_name"]
        aid = by_exact.get(rname) or by_norm.get(_norm_name(rname))
        if not aid:
            unmatched.append(r)
            continue
        entries = mapping.setdefault(aid, [])
        if not any(e["routing_id"] == rid for e in entries):
            entries.append({"routing_id": rid, "routing_name": rname})
    return mapping, unmatched


def merge_maps(base, discovered):
    """Gop mapping tu dong vao mapping tay: giu het cai cu, them cai moi, KHONG
    xoa gi (nguoi dung co the da sua tay). Trung routing_id thi giu ban cu,
    chi dien routing_name neu ban cu con trong. -> (merged, so dong them moi).
    """
    out = {}
    for acc, entries in (base or {}).items():
        acc = str(acc).strip()
        if acc:
            out[acc] = [dict(e) for e in entries]

    added = 0
    for acc, entries in (discovered or {}).items():
        cur = out.setdefault(acc, [])
        for e in entries:
            hit = next((x for x in cur if x.get("routing_id") == e["routing_id"]), None)
            if hit is None:
                cur.append(dict(e))
                added += 1
            elif not hit.get("routing_name") and e.get("routing_name"):
                hit["routing_name"] = e["routing_name"]
    return out, added


# ---------------------------------------------------------------- cache + chi muc

class GatewayMapStore:
    """SQLite gateway mapping + cache raw theo routing +
    chi muc CID hop nhat (thu dashboard doc)."""

    def __init__(self, root, profile_id, call_store_instance=None):
        self.root = Path(root)
        self.profile_id = profile_id or "default"
        self.config_dir = self.root / "config"
        self.map_path = self.config_dir / "gateway-map.json"
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", str(self.profile_id))
        self.cache_dir = self.config_dir / ".cache" / "gateway" / safe
        self.index_path = self.cache_dir / "gateway-cids.json"
        self.call_store = call_store_instance or call_store.CallStore(self.root)

    # --- mapping tay: {account_id: [{routing_id, routing_name}]} ---

    def load_map(self):
        with self.call_store.lock:
            db_map = self.call_store.load_gateway_map(self.profile_id)
            if db_map:
                return db_map
            if not self.map_path.exists() or self.call_store.has_gateway_maps():
                return {}
            try:
                data = json.loads(self.map_path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data:
                    # File cũ là dữ liệu toàn cục: chỉ nhập đúng một lần vào DB.
                    clean = self._clean_map(data)
                    self.call_store.save_gateway_map(self.profile_id, clean)
                    return clean
            except Exception:
                return {}
            return {}

    @staticmethod
    def _clean_map(mapping):
        clean = {}
        for acc, entries in (mapping or {}).items():
            acc = str(acc).strip()
            if not acc:
                continue
            lst, seen = [], set()
            for e in (entries if isinstance(entries, list) else [entries]):
                if isinstance(e, dict):
                    rid = str(e.get("routing_id", "")).strip()
                    rname = str(e.get("routing_name", "")).strip()
                else:
                    rid, rname = str(e).strip(), ""
                if rid.isdigit() and rid not in seen:
                    seen.add(rid)
                    lst.append({"routing_id": rid, "routing_name": rname})
            if lst:
                clean[acc] = lst
        return clean

    def save_map(self, mapping):
        clean = self._clean_map(mapping)
        self.call_store.save_gateway_map(self.profile_id, clean)
        return clean

    def routing_to_account(self, mapping=None):
        mapping = self.load_map() if mapping is None else mapping
        out = {}
        for acc, entries in mapping.items():
            for e in entries:
                out.setdefault(e["routing_id"], [])
                if acc not in out[e["routing_id"]]:
                    out[e["routing_id"]].append(acc)
        return out

    # --- cache raw theo routing ---

    def _routing_path(self, routing_id):
        routing_id = str(routing_id).strip()
        if not routing_id.isdigit():
            raise ValueError("routing_id phải là số.")
        return self.cache_dir / f"routing_{routing_id}.json"

    def write_routing(self, routing_id, rows, meta):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._routing_path(routing_id).write_text(
            json.dumps({"meta": meta, "rows": rows}, ensure_ascii=False),
            encoding="utf-8",
        )

    def read_routing(self, routing_id):
        p = self._routing_path(routing_id)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None

    # --- chi muc CID hop nhat ---

    def rebuild_index(self, mapping=None):
        mapping = self.load_map() if mapping is None else mapping
        r2a = self.routing_to_account(mapping)
        rname = {e["routing_id"]: e.get("routing_name", "")
                 for entries in mapping.values() for e in entries}
        index, conflicts = {}, []
        for routing_id, accounts in r2a.items():
            rec = self.read_routing(routing_id)
            if not rec:
                continue
            for row in rec.get("rows", []):
                cid = row.get("cid") or ""
                if not cid:
                    continue
                entry = {
                    "account_id": accounts[0],
                    "routing_id": routing_id,
                    "routing_name": rname.get(routing_id, ""),
                    "gateway": row.get("gateway", ""),
                    "telco_status": row.get("telco_status", {}),
                }
                prev = index.get(cid)
                if prev is not None:
                    if (prev["account_id"], prev["gateway"]) != \
                       (entry["account_id"], entry["gateway"]):
                        conflicts.append({"cid": cid, "keep": prev, "drop": entry})
                    continue
                index[cid] = entry
        built_at = datetime.now().isoformat(timespec="seconds")
        payload = {
            "builtAt": built_at,
            "cidCount": len(index),
            "routingIds": sorted(r2a),
            "multiAccountRoutings": {r: a for r, a in r2a.items() if len(a) > 1},
            "conflicts": conflicts,
            "index": index,
        }
        self.call_store.save_gateway_cids_index(self.profile_id, index, built_at)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.index_path.write_text(
                json.dumps(payload, ensure_ascii=False), encoding="utf-8"
            )
        except Exception:
            pass
        return payload

    def read_index(self):
        db_index = self.call_store.load_gateway_cids_index(self.profile_id)
        if db_index and db_index.get("cidCount", 0) > 0:
            return db_index
        if not self.index_path.exists():
            return {"cidCount": 0, "index": {}, "builtAt": None}
        try:
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        except Exception:
            return {"cidCount": 0, "index": {}, "builtAt": None}

    def status(self):
        """Tom tat cho giao dien: da map gi, cache co gi, dong bo luc nao."""
        mapping = self.load_map()
        r2a = self.routing_to_account(mapping)
        routings = []
        for rid in sorted(r2a):
            rec = self.read_routing(rid)
            meta = (rec or {}).get("meta") or {}
            routings.append({
                "routing_id": rid,
                "accounts": r2a[rid],
                "cached": rec is not None,
                "cidCount": meta.get("cidCount", 0),
                "gateways": meta.get("gateways", {}),
                "fetchedAt": meta.get("fetchedAt"),
            })
        idx = self.read_index()
        return {
            "map": mapping,
            "routings": routings,
            "index": {
                "cidCount": idx.get("cidCount", 0),
                "builtAt": idx.get("builtAt"),
                "conflicts": idx.get("conflicts", []),
                "multiAccountRoutings": idx.get("multiAccountRoutings", {}),
            },
        }


def sync(client, store, mapping=None, progress=None):
    """Dang nhap -> tai .xlsx cho tung routing_id da map -> dung lai chi muc."""
    client.login()
    mapping = store.load_map() if mapping is None else mapping
    routing_ids = sorted({e["routing_id"]
                          for entries in mapping.values() for e in entries})
    done, errors = [], []
    for i, rid in enumerate(routing_ids):
        if progress:
            progress({"done": i, "total": len(routing_ids), "current": rid})
        try:
            rows, meta = fetch_routing_cids(client, rid)
            store.write_routing(rid, rows, meta)
            done.append({"routing_id": rid, "cidCount": len(rows),
                         "gateways": meta["gateways"]})
        except Exception as exc:  # giu cac routing khac, bao loi tung cai
            errors.append({"routing_id": rid, "error": str(exc)})
    if progress:
        progress({"done": len(routing_ids), "total": len(routing_ids), "current": ""})
    built = store.rebuild_index(mapping)
    return {
        "routings": done,
        "errors": errors,
        "index": {
            "cidCount": built["cidCount"],
            "conflicts": built["conflicts"],
            "multiAccountRoutings": built["multiAccountRoutings"],
            "builtAt": built["builtAt"],
        },
    }


def auto_map(client, store, accounts, do_sync=True, progress=None):
    """Suy account_id <-> routing_id tu /routing/monitoring, gop vao map hien
    co, luu lai. do_sync=True thi tai luon CID + Gateway cho tung routing
    (giong nut "Dong bo Gateway"); nguoc lai chi dung lai chi muc tu cache cu.
    """
    client.login()
    routings = fetch_monitoring_routings(client)
    discovered, unmatched = match_routings_to_accounts(routings, accounts)
    merged, added = merge_maps(store.load_map(), discovered)
    clean = store.save_map(merged)

    result = {
        "monitoringRoutings": len(routings),
        "discovered": discovered,
        "unmatched": unmatched,
        "added": added,
        "map": clean,
    }
    if do_sync:
        result["sync"] = sync(client, store, clean, progress=progress)
    else:
        built = store.rebuild_index(clean)
        result["index"] = {
            "cidCount": built["cidCount"],
            "conflicts": built["conflicts"],
            "multiAccountRoutings": built["multiAccountRoutings"],
            "builtAt": built["builtAt"],
        }
    return result


# ---------------------------------------------------------------- CLI (tuy chon)

def _main(argv):
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("xlsx", help="duong dan file .xlsx da tai ve (che do offline)")
    args = ap.parse_args(argv)
    rows = parse_gateway_rows(read_xlsx_rows(Path(args.xlsx).read_bytes()))
    print(f"{len(rows)} CID")
    print("gateways:", json.dumps(gateway_summary(rows), ensure_ascii=False))
    for row in rows[:5]:
        print(" ", row["cid"], row["gateway"], row["telco_status"])


if __name__ == "__main__":
    _main(_sys.argv[1:])
