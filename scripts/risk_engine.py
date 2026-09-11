"""TELECOM CID RISK OPTIMIZER — Calculation Engine (port vao du an).

Nguon: skill `telecom-cid-risk-optimizer` (scripts/engine.py) — giu nguyen toan
bo logic tinh toan (section 4-31 cua SKILL.md: EOD lock truth, hangup class,
rolling 5m density, effective number_random, concurrent, reuse interval,
number_random simulation, backtest call_fail, ReActive/ReBlock survival, R net
loss, gateway typing). Nguyen tac 1.1 cua skill: CODE TINH SO LIEU, LLM CHI
DOC VA DIEN GIAI — module nay khong goi LLM, chi tra ve dict da tong hop
(analysis_result). scripts/llm_client.py moi la noi goi LLM de viet bao cao.

Khac voi ban goc trong skill:
  - CID duoc chuan hoa bang `routing_events.normalize_cid` (ve dang noi dia
    `0...`, xu ly ca 4 dinh dang nguon: 84xxx/0xxx/thieu so 0/09 chu so) thay vi
    chi strip ky tu khong phai so cua ban goc — quan trong de CDR/routing/events
    khop dung CID (xem docs/cid-lifecycle-analysis.md muc 1).
  - Khong doc file .xlsx/.csv rieng cho routing/events: du an nay da co san cache
    JSON cua GatewayMapStore (config/.cache/gateway/) va RoutingEventCache
    (.cache/cid-events/) — `routing_df_from_gateway_index()` va
    `events_df_from_cache()` xay DataFrame thang tu 2 cache do, khong can
    re-export file trung gian.
  - `run_analysis()` la entrypoint dung boi server (nhan CSV bytes CDR da co
    san tu handle_calldata + 2 cache tren) — khong ghi file. CLI (`__main__`)
    van giu de dung doc lap/test tay, dung file loader rieng.
"""
import argparse
import io
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from routing_events import normalize_cid  # noqa: E402  (cung nguon CID, 4 dinh dang)

# ---------- alias mapping (skill SKILL.md section 2 / 4) ----------
ALIASES = {
    'cid':        ['caller_id_number', 'caller_id', 'cid', 'callerid', 'from_number'],
    'callee':     ['destination_number', 'callee', 'to_number', 'dest'],
    'account_id': ['account_id', 'account', 'acc_id'],
    'telco':      ['telco', 'carrier', 'operator', 'network'],
    'start':      ['start_stamp', 'start', 'start_time', 'setup_time'],
    'answer':     ['answer_stamp', 'answer', 'answer_time'],
    'end':        ['end_stamp', 'end', 'end_time', 'hangup_time'],
    'billsec':    ['billsec', 'bill_sec', 'billed_seconds'],
    'duration':   ['duration', 'dur'],
    'hangup':     ['hangup_cause', 'cause', 'hangupcause', 'sip_cause'],
    'uuid':       ['uuid', 'call_id', 'id'],
}
TELCO_MAP = {'VT': 'Viettel', 'VIETTEL': 'Viettel', 'MB': 'Mobi', 'MOBIFONE': 'Mobi', 'MOBI': 'Mobi',
             'VN': 'Vina', 'VINAPHONE': 'Vina', 'VINA': 'Vina'}
HARD_ERRORS = {'CALL_REJECTED', 'RECOVERY_ON_TIMER_EXPIRE', 'NORMAL_TEMPORARY_FAILURE',
               'INCOMPATIBLE_DESTINATION', 'SERVICE_NOT_IMPLEMENTED', 'NETWORK_OUT_OF_ORDER'}
BEHAVIORAL = {'USER_BUSY', 'ORIGINATOR_CANCEL', 'NO_USER_RESPONSE', 'NO_ANSWER'}
CARRIER_STATUS_COLS = ['Viettel', 'Mobi', 'Vina', 'Other']


def pick(cols, keys):
    low = {c.lower(): c for c in cols}
    for k in keys:
        if k.lower() in low:
            return low[k.lower()]
    return None


def norm_telco(x):
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return 'Unknown'
    return TELCO_MAP.get(str(x).strip().upper(), str(x).strip())


# ---------------------------------------------------------------- CDR

def load_cdr_df(df):
    """df: DataFrame CDR THO (chua qua alias mapping) -> DataFrame chuan hoa
    CID/telco/start/end/billsec/hangup/account_id/uuid + cac co (flag) phan
    loai. Day la ham thuan (khong doc file) de server truyen thang DataFrame
    da co san (vd tu CSV export cua MPT)."""
    m = {k: pick(df.columns, v) for k, v in ALIASES.items()}
    if not m['cid'] or not m['start']:
        raise ValueError("CDR thiếu cột CID hoặc start_stamp — kiểm tra ALIASES trong risk_engine.py.")
    out = pd.DataFrame()
    out['CID'] = df[m['cid']].astype(str).map(normalize_cid)
    out['telco'] = df[m['telco']].map(norm_telco) if m['telco'] else 'Unknown'
    out['start'] = pd.to_datetime(df[m['start']], errors='coerce')
    out['end'] = pd.to_datetime(df[m['end']], errors='coerce') if m['end'] else pd.NaT
    out['billsec'] = pd.to_numeric(df[m['billsec']], errors='coerce').fillna(0) if m['billsec'] else 0
    out['hangup'] = df[m['hangup']].astype(str) if m['hangup'] else ''
    out['account_id'] = df[m['account_id']].astype(str) if m['account_id'] else 'NA'
    out['uuid'] = df[m['uuid']].astype(str) if m['uuid'] else range(len(out))
    out = out[out['CID'] != ''].copy()
    out = out[out['start'].notna()].copy()
    out['success'] = (out['billsec'] > 0).astype(int)
    out['is_hard'] = out['hangup'].isin(HARD_ERRORS).astype(int)
    out['is_reject'] = (out['hangup'] == 'CALL_REJECTED').astype(int)
    out['is_anyfail'] = (out['billsec'] == 0).astype(int)
    return out


def load_cdr_bytes(csv_bytes):
    """CSV bytes (nhu tra ve tu /api/calldata.csv) -> DataFrame chuan hoa."""
    raw = pd.read_csv(io.BytesIO(csv_bytes), encoding='utf-8-sig')
    return load_cdr_df(raw)


def load_cdr_file(path):
    df = pd.read_csv(path) if str(path).lower().endswith('.csv') else pd.read_excel(path)
    return load_cdr_df(df)


# ---------------------------------------------------------------- Routing

def routing_df_from_gateway_index(index):
    """index: dict CID -> {gateway, telco_status:{viettel,mobi,vina,other}}
    (GatewayMapStore.read_index()['index'], da co san trong project — xem
    scripts/gateway_map.py). Tra ve DataFrame CID/Gateway/Viettel/Mobi/Vina/Other
    voi gia tri 'ON'/'PAUSE' y het engine goc doc tu .xlsx routing export."""
    rows = []
    for cid, info in (index or {}).items():
        status = (info or {}).get('telco_status') or {}
        rows.append({
            'CID': normalize_cid(cid),
            'Gateway': (info or {}).get('gateway') or '',
            'Viettel': status.get('viettel') or '',
            'Mobi': status.get('mobi') or '',
            'Vina': status.get('vina') or '',
            'Other': status.get('other') or '',
        })
    return pd.DataFrame(rows, columns=['CID', 'Gateway'] + CARRIER_STATUS_COLS)


def load_routing_file(path):
    rt = pd.read_excel(path) if str(path).lower().endswith(('.xlsx', '.xls')) else pd.read_csv(path)
    cid = pick(rt.columns, ['CID', 'cid', 'caller_id'])
    rt = rt.copy()
    rt['CID'] = rt[cid].astype(str).map(normalize_cid)
    return rt


# ---------------------------------------------------------------- Events

def events_df_from_cache(events):
    """events: list tu RoutingEventCache.load_window() — moi phan tu la dict
    {routing,cid,cid_raw,ts,kind,telco,actor} (xem scripts/routing_events.py).
    `telco` o day la ma goc (VT/MB/VN...) da doc san tu cot Notes luc dong bo -
    dung thang qua norm_telco(), KHONG doan lai tu chuoi Notes nhu engine goc
    (parse_events() cua ban goc phai regex Notes vi khong co san telco)."""
    rows = []
    for e in (events or []):
        cid = normalize_cid(e.get('cid') or e.get('cid_raw') or '')
        ts = e.get('ts') or ''
        kind = str(e.get('kind') or '').upper()
        if not cid or not ts or not kind:
            continue
        rows.append({
            'CID': cid,
            'telco': norm_telco(e.get('telco')) if e.get('telco') else None,
            'event_type': kind,
            'time': ts,
        })
    df = pd.DataFrame(rows, columns=['CID', 'telco', 'event_type', 'time'])
    if df.empty:
        return df
    df['time'] = pd.to_datetime(df['time'], errors='coerce')
    return df.dropna(subset=['time'])


def parse_events_file(path):
    """File Block/ReActive rieng (.xlsx/.csv, cot Notes chua ten nha mang) -
    giu cho dung CLI/tuong thich nguoc; production dung events_df_from_cache()."""
    ev = pd.read_excel(path) if str(path).lower().endswith(('.xlsx', '.xls')) else pd.read_csv(path)
    cid = pick(ev.columns, ['CID', 'cid'])
    tcol = pick(ev.columns, ['Time', 'time', 'event_time', 'block_time'])
    typ = pick(ev.columns, ['Type', 'type', 'event_type'])
    notes = pick(ev.columns, ['Notes', 'notes', 'desc'])
    ev = ev.copy()
    ev['CID'] = ev[cid].astype(str).map(normalize_cid)
    ev['time'] = pd.to_datetime(ev[tcol], errors='coerce')
    ev['event_type'] = ev[typ].astype(str).str.upper() if typ else 'BLOCK'

    def carrier(n):
        m = re.search(r'(Block|[Rr]eactive)\s+(\w+)', str(n))
        return norm_telco(m.group(2)) if m else None

    ev['telco'] = ev[notes].apply(carrier) if notes else None
    return ev[['CID', 'telco', 'event_type', 'time']].dropna(subset=['time'])


# ---------------------------------------------------------------- helpers

def pctile(a, qs):
    a = np.asarray(a)
    return {f'p{q}': (round(float(np.percentile(a, q)), 1) if len(a) else None) for q in qs}


def rolling_counts(df, flag=None, win=300):
    """Per-CID rolling count over `win` seconds of rows (or of rows where flag==1)."""
    res = np.zeros(len(df), dtype=int)
    for _, g in df.groupby('CID'):
        ts = g['start'].values.astype('datetime64[s]').astype('int64')
        vals = np.ones(len(ts)) if flag is None else g[flag].values
        j = 0
        run = 0
        idx = g.index.to_list()
        for i in range(len(ts)):
            run += vals[i]
            while ts[i] - ts[j] > win:
                run -= vals[j]
                j += 1
            res[df.index.get_loc(idx[i])] = run
    return res


def backtest(vt, flag, final_block, xs=range(1, 7), windows=(5, 10, 15)):
    positives = set(final_block)
    total = len(positives)
    out = {}
    grouped = list(vt.groupby('CID'))
    for W in windows:
        for x in xs:
            trig = tp = 0
            caught = set()
            for cid, g in grouped:
                g = g.sort_values('start')
                flags = g[flag].values
                times = g['start'].values
                fb = final_block.get(cid)
                streak = 0
                for i in range(len(flags)):
                    streak = streak + 1 if flags[i] == 1 else 0
                    if streak == x:
                        trig += 1
                        streak = 0
                        if fb is not None:
                            dt = (fb - pd.Timestamp(times[i])).total_seconds() / 60
                            if 0 <= dt <= W:
                                tp += 1
                                caught.add(cid)
            prec = tp / trig if trig else 0
            rec = len(caught) / total if total else 0
            f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0
            f2 = 5 * prec * rec / (4 * prec + rec) if (4 * prec + rec) else 0
            out[f'W{W}_x{x}'] = dict(triggers=trig, tp=tp, unique_locks=len(caught),
                                      precision=round(prec, 3), recall=round(rec, 3),
                                      f1=round(f1, 3), f2=round(f2, 3))
    return out, total


# ---------------------------------------------------------------- core

def compute(cdr, rt, ev, telco):
    """cdr/rt/ev: DataFrame da chuan hoa (load_cdr_df/routing_df_from_gateway_index/
    events_df_from_cache hoac tuong duong file-based). ev co the None. Tra ve
    dict `analysis_result` — KHONG goi LLM, KHONG ghi file."""
    cid2gw = (
        dict(zip(rt['CID'], rt[pick(rt.columns, ['Gateway', 'gateway'])]))
        if pick(rt.columns, ['Gateway', 'gateway']) is not None and len(rt) else {}
    )
    cdr = cdr.copy()
    cdr['Gateway'] = cdr['CID'].map(cid2gw)
    T = telco
    R = {'meta': {
        'telco_focus': T, 'cdr_rows': len(cdr),
        'date_min': str(cdr['start'].min()) if len(cdr) else None,
        'date_max': str(cdr['start'].max()) if len(cdr) else None,
        'accounts': int(cdr['account_id'].nunique()) if len(cdr) else 0,
    }}

    # --- Data quality (section 5) ---
    R['data_quality'] = {
        'cid_match_routing_pct': round(cdr['CID'].isin(set(rt['CID'])).mean() * 100, 1) if len(cdr) and len(rt) else 0.0,
        'multiple_account_id': bool(cdr['account_id'].nunique() > 1) if len(cdr) else False,
        'cost_available': False,
        'events_available': ev is not None and len(ev) > 0,
    }

    # --- EOD lock truth (section 1.4 / 4) ---
    R['eod_lock_truth'] = {}
    for cstat in CARRIER_STATUS_COLS:
        if cstat in rt.columns:
            R['eod_lock_truth'][cstat] = {
                s: int((rt[cstat] == s).sum()) for s in ['ON', 'PAUSE'] if (rt[cstat] == s).any()
            }
    locked = set(rt.loc[rt.get(T, '') == 'PAUSE', 'CID']) if T in rt.columns else set()
    alive = set(rt.loc[rt.get(T, '') == 'ON', 'CID']) if T in rt.columns else set()
    R['locked_n'], R['alive_n'] = len(locked), len(alive)

    tf = cdr[cdr['telco'] == T].sort_values('start').reset_index(drop=True)
    R['telco_calls'] = len(tf)

    # --- Final block time per CID (section 6.2) ---
    final_block = {}
    if ev is not None and len(ev):
        b = ev[(ev['event_type'].str.contains('BLOCK')) & ((ev['telco'] == T) | (ev['telco'].isna()))]
        final_block = {cid: g['time'].max() for cid, g in b.groupby('CID')}
    R['cids_with_block'] = len(final_block)

    # --- Hangup classification (section 7) ---
    if len(tf):
        R['hangup_class_pct'] = {
            'success': round(tf['success'].mean() * 100, 1),
            'hard_error': round(tf['is_hard'].mean() * 100, 1),
            'behavioral': round(tf['hangup'].isin(BEHAVIORAL).mean() * 100, 1),
            'call_rejected': round(tf['is_reject'].mean() * 100, 1),
        }

    # --- Rolling 5m density (section 9/16) ---
    if len(tf):
        tf['calls_5m'] = rolling_counts(tf, None, 300)
        R['calls_5m'] = pctile(tf['calls_5m'], [50, 75, 90, 95, 99])
        R['calls_5m']['max'] = int(tf['calls_5m'].max())

        # --- Effective number_random (section 10) ---
        tf['bkt5'] = tf['start'].dt.floor('5min')
        eff = tf.groupby('bkt5')['CID'].nunique()
        R['effective_number_random'] = {f'p{q}': int(np.percentile(eff, q)) for q in [25, 50, 75, 95]}
        R['effective_number_random']['max'] = int(eff.max())
        R['distinct_cid_total'] = int(tf['CID'].nunique())
        calls5 = tf.groupby('bkt5').size()
        peak = calls5.idxmax()
        R['peak_calls_5m'] = int(calls5.max())
        R['eff_cid_at_peak'] = int(eff.loc[peak])
        R['calls_per_eff_cid_at_peak'] = round(calls5.max() / eff.loc[peak], 1)

        # --- Concurrent (section 12) ---
        c2 = tf[tf['end'].notna() & (tf['end'] >= tf['start'])]
        events_sweep = []
        for s, e in zip(c2['start'].values, c2['end'].values):
            events_sweep += [(s, 1), (e, -1)]
        events_sweep.sort(key=lambda z: (z[0], z[1]))
        cur = 0
        ser = []
        for _, d in events_sweep:
            cur += d
            ser.append(cur)
        R['concurrent'] = {f'p{q}': int(np.percentile(ser, q)) for q in [50, 90, 95, 99]}
        R['concurrent']['max'] = int(max(ser)) if ser else 0

        # --- Reuse interval (section 13) ---
        gaps = []
        for _, g in tf.groupby('CID'):
            ts = np.sort(g['start'].values.astype('datetime64[s]').astype('int64'))
            if len(ts) > 1:
                gaps.extend(np.diff(ts).tolist())
        R['reuse_sec'] = {f'p{q}': int(np.percentile(gaps, q)) for q in [5, 10, 25, 50, 90]} if gaps else None

        # --- number_random simulation (section 20) ---
        ts_all = tf['start'].values.astype('datetime64[s]').astype('int64')
        bkt = ts_all // 300
        sim = {}
        for N in [10, 20, 30, 40, 50, 75, 100, 150]:
            slot = np.arange(len(tf)) % N
            pk = pd.DataFrame({'s': slot, 'b': bkt}).groupby(['s', 'b']).size()
            sim[N] = dict(peak_calls_per_cid_5m=int(pk.max()), p95=int(np.percentile(pk, 95)))
        R['number_random_sim'] = sim

        # --- Backtest call_fail (section 18) — three definitions to compare ---
        if final_block:
            R['backtest'] = {'total_positive_locks': len(final_block)}
            for name, flag in [('CALL_REJECTED', 'is_reject'), ('HARD_ERROR', 'is_hard'), ('ANYFAIL', 'is_anyfail')]:
                bt, _ = backtest(tf, flag, final_block)
                R['backtest'][name] = bt

    # --- ReActive/ReBlock survival (section 6.3 / 26) ---
    if ev is not None and len(ev):
        allev = ev[ev['telco'] == T].sort_values('time')
        surv = []
        reblk = 0
        durable = 0
        for cid, g in allev.groupby('CID'):
            evs = list(zip(g['event_type'], g['time']))
            for i, (ty, tm) in enumerate(evs):
                if 'REACTIVE' in ty:
                    nxt = [t for (t2, t) in evs[i + 1:] if 'BLOCK' in t2]
                    if nxt:
                        reblk += 1
                        surv.append((nxt[0] - tm).total_seconds() / 60)
                    elif cid in alive:
                        durable += 1
        R['reactive'] = {
            'total': int((allev['event_type'].str.contains('REACTIVE')).sum()),
            'reblocked': reblk, 'durable_est': durable,
            'time_to_reblock_min': (pctile(surv, [25, 50, 75, 90]) if surv else 'insufficient'),
            'confidence': 'LOW' if len(surv) < 30 else 'MEDIUM',
        }
        # --- R durable net loss (section 27) ---
        allev = allev.copy()
        allev['date'] = allev['time'].dt.date
        piv = allev.pivot_table(index='date', columns='event_type', values='CID', aggfunc='count', fill_value=0)
        for col in ['BLOCK', 'REACTIVE']:
            if col not in piv:
                piv[col] = 0
        R['R_net_loss_by_day'] = {str(k): int(v) for k, v in (piv['BLOCK'] - piv['REACTIVE']).items()}
        R['R_confidence'] = 'LOW' if len(piv) < 7 else 'MEDIUM'

    # --- Gateway typing (section 19/28) ---
    if len(tf) and cid2gw:
        gw = {}
        for g, gd in tf.groupby('Gateway'):
            if g is None or (isinstance(g, float) and pd.isna(g)):
                continue
            cids = set(gd['CID'])
            dens = float(gd['calls_5m'].median())
            lr = len(cids & locked) / max(len(cids), 1)
            gtype = (
                'TYPE_C_STRUCTURAL' if (lr > 0.9 and dens < 20 and gd['is_reject'].mean() < 0.02)
                else 'TYPE_A_LOAD_SENSITIVE' if dens >= 50
                else 'TYPE_B_ERROR_SENSITIVE' if gd['is_hard'].mean() > 0.15
                else 'MIXED'
            )
            gw[str(g)] = dict(
                cids=len(cids), locked=len(cids & locked), alive=len(cids & alive),
                lock_rate=round(lr, 3), reject_rate=round(gd['is_reject'].mean(), 3),
                hard_rate=round(gd['is_hard'].mean(), 3), success_rate=round(gd['success'].mean(), 3),
                prelock_density_5m=round(dens, 1), risk_type=gtype,
            )
        R['gateway'] = gw

    return R


def run_analysis(cdr_csv_bytes, gateway_index, events, telco):
    """Entrypoint dung boi server (scripts/mpt_dashboard_server.py):

    cdr_csv_bytes  -- bytes CSV nhu server da co san (cung nguon voi
                      /api/calldata.csv, schema chuan hoa cua du an).
    gateway_index  -- dict tu GatewayMapStore.read_index()['index'].
    events         -- list tu RoutingEventCache.load_window()[0] (co the []).
    telco          -- 'Viettel' | 'Mobi' | 'Vina' | ...

    Tra ve dict analysis_result (nho, da tong hop — an toan gui nguyen cho LLM,
    xem scripts/llm_client.py mode 'risk_report').
    """
    cdr = load_cdr_bytes(cdr_csv_bytes)
    rt = routing_df_from_gateway_index(gateway_index)
    ev = events_df_from_cache(events) if events else None
    return compute(cdr, rt, ev, telco)


# ---------------------------------------------------------------- CLI

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--cdr', required=True)
    ap.add_argument('--routing', required=True)
    ap.add_argument('--events', default=None)
    ap.add_argument('--telco', default='Viettel', help='Hướng nhà mạng cần soi sâu')
    ap.add_argument('--out', default='analysis_result.json')
    a = ap.parse_args()

    cdr = load_cdr_file(a.cdr)
    rt = load_routing_file(a.routing)
    ev = parse_events_file(a.events) if a.events else None
    result = compute(cdr, rt, ev, a.telco)
    Path(a.out).write_text(
        json.dumps(result, indent=2, default=str, ensure_ascii=False), encoding='utf-8'
    )
    print(f"[OK] Wrote {a.out}  (telco={a.telco}, calls={result.get('telco_calls')}, locked={result.get('locked_n')})")


if __name__ == '__main__':
    main()
