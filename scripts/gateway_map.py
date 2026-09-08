"""Gateway theo CID, lay tu trang MPT `routing/cids/<routing_id>`.

Trang co nut Export -> GET `/routing/exportCid/<routing_id>` tra ve mot file
.xlsx that (Content-Disposition attachment). Cot cua sheet:

    Position | Gateway | CID | Status | Viettel | Mobi | Vina | Other | Desc | Notes

MPT KHONG gan account vao trang nay. `account_id` do nguoi dung gan tay voi
`routing_id` (config/gateway-map.json) qua giao dien app. Moi CID trong export
cua routing 6151 => thuoc account da map voi 6151 (suy mot lan, cache lai).

Parse .xlsx bang stdlib (zipfile + xml) de ban portable khong phai them openpyxl
— dung tinh than routing_events.py chi dung urllib + re. Cac ham parse la thuan
tuy (khong mang), test duoc khong can dang nhap.
"""

import io
import json
import re
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime
from pathlib import Path

import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent))
from routing_events import normalize_cid  # noqa: E402  (cung nguon CID, cung 4 dinh dang)

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


# ---------------------------------------------------------------- cache + chi muc

class GatewayMapStore:
    """config/gateway-map.json (mapping tay) + cache raw theo routing +
    chi muc CID hop nhat (thu dashboard doc)."""

    def __init__(self, root, profile_id):
        self.root = Path(root)
        self.config_dir = self.root / "config"
        self.map_path = self.config_dir / "gateway-map.json"
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", str(profile_id or "default"))
        self.cache_dir = self.config_dir / ".cache" / "gateway" / safe
        self.index_path = self.cache_dir / "gateway-cids.json"

    # --- mapping tay: {account_id: [{routing_id, routing_name}]} ---

    def load_map(self):
        if not self.map_path.exists():
            return {}
        try:
            data = json.loads(self.map_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

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
                if rid and rid not in seen:
                    seen.add(rid)
                    lst.append({"routing_id": rid, "routing_name": rname})
            if lst:
                clean[acc] = lst
        return clean

    def save_map(self, mapping):
        clean = self._clean_map(mapping)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.map_path.write_text(
            json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8"
        )
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

    def write_routing(self, routing_id, rows, meta):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        (self.cache_dir / f"routing_{routing_id}.json").write_text(
            json.dumps({"meta": meta, "rows": rows}, ensure_ascii=False),
            encoding="utf-8",
        )

    def read_routing(self, routing_id):
        p = self.cache_dir / f"routing_{routing_id}.json"
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
        payload = {
            "builtAt": datetime.now().isoformat(timespec="seconds"),
            "cidCount": len(index),
            "routingIds": sorted(r2a),
            "multiAccountRoutings": {r: a for r, a in r2a.items() if len(a) > 1},
            "conflicts": conflicts,
            "index": index,
        }
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        return payload

    def read_index(self):
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
