"""Chay dashboard tu worktree nay, dung lai config/ cua checkout chinh.

`config/` (profiles.json + secret.key) bi gitignore nen KHONG duoc sao chep vao
worktree. Neu chay thang thi khong co ket noi MPT nao. Script nay phuc vu file
giao dien tu worktree nhung tro profile store sang checkout chinh, de kiem thu
ban dang phat trien ma khong phai nhan lai mat khau (va khong nhan ban credential).

    python scripts/run-worktree.py [--port 8787]
"""

import argparse
import sys
import threading
import webbrowser
from pathlib import Path

WT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WT / "scripts"))

import mpt_dashboard_server as server  # noqa: E402


def main_checkout(start):
    """Tim thu muc repo goc bang cach di nguoc len khoi .claude/worktrees/<ten>."""
    for parent in start.parents:
        if parent.name == "worktrees" and parent.parent.name == ".claude":
            return parent.parent.parent
    return start


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    root = main_checkout(WT)
    config = root / "config" / "profiles.json"

    srv = server.create_server(args.host, args.port, root=str(WT))
    if config.exists():
        srv.profile_store = server.ProfileStore(str(root))
        print(f"Profile   : {config}")
    else:
        print(f"Profile   : KHONG THAY {config} — se phai nhap lai ket noi MPT.")

    cache = WT / ".cache" / "cid-events"
    days = len(list(cache.glob("*/[0-9]*.json"))) if cache.exists() else 0
    print(f"Giao dien : {WT}")
    print(f"Cache CID : {days} ngay")

    url = f"http://{args.host}:{args.port}/"
    print(f"Dashboard : {url}", flush=True)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nDa dung.")


if __name__ == "__main__":
    main()
