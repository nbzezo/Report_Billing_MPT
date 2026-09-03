#!/usr/bin/env python3
"""Native desktop window for the MPT Call Dashboard (portable Windows build).

Runs the existing local server on an ephemeral port and opens it as a chromeless
Microsoft Edge / Chrome window (``--app`` mode) with an isolated profile under the
app folder. No pywebview / WebView2 wrapper — the browser engine that the
dashboard is tested against renders it directly.

Data (``config/``, ``logs/``, ``data/edge/``) lives next to the executable so the
whole app is portable: copy the folder, run ``MPT Call Dashboard.exe``.
"""
import ctypes
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mpt_dashboard_server import app_root, create_server  # noqa: E402

APP_TITLE = "MPT Call Dashboard"
MUTEX_NAME = "Global\\MPTCallDashboard.SingleInstance"
_ERROR_ALREADY_EXISTS = 183
_MB_ICONERROR = 0x10
_MB_ICONINFO = 0x40


def _message(text, flags):
    if sys.platform.startswith("win"):
        ctypes.windll.user32.MessageBoxW(None, text, APP_TITLE, flags)
    else:
        stream = sys.stderr if flags == _MB_ICONERROR else sys.stdout
        print(text, file=stream)


def _fatal(text):
    _message(text, _MB_ICONERROR)
    sys.exit(1)


def _single_instance_guard():
    """Return a handle to keep alive, or exit if the app is already running."""
    if not sys.platform.startswith("win"):
        return None
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.windll.kernel32.GetLastError() == _ERROR_ALREADY_EXISTS:
        _message(f"{APP_TITLE} đang chạy rồi.", _MB_ICONINFO)
        sys.exit(0)
    return handle


def _find_browser():
    """Path to msedge.exe (preferred) or chrome.exe, or None."""
    bases = [os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"),
             os.environ.get("LOCALAPPDATA")]
    rel = [("Microsoft", "Edge", "Application", "msedge.exe"),
           ("Google", "Chrome", "Application", "chrome.exe")]
    for parts in rel:
        for base in bases:
            if not base:
                continue
            cand = Path(base).joinpath(*parts)
            if cand.exists():
                return str(cand)
    for name in ("msedge", "chrome", "chrome.exe", "msedge.exe"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _profile_windows_alive(marker):
    """True while a browser process still has our --user-data-dir open."""
    if not sys.platform.startswith("win"):
        return False
    ps = (
        "$m=$env:MPT_EDGE_MARKER;"
        "(@(Get-CimInstance Win32_Process -Filter \"name='msedge.exe' or name='chrome.exe'\""
        " -ErrorAction SilentlyContinue |"
        " Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) })).Count"
    )
    try:
        env = dict(os.environ, MPT_EDGE_MARKER=marker)
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=15, env=env,
        )
        return (out.stdout or "").strip() not in ("", "0")
    except Exception:
        return False


def main():
    guard = _single_instance_guard()  # noqa: F841 (kept alive for process lifetime)
    root = app_root()
    profile = root / "data" / "edge"
    profile.mkdir(parents=True, exist_ok=True)

    try:
        server = create_server(host="127.0.0.1", port=0, root=root)
    except OSError as exc:
        _fatal(f"Không khởi động được máy chủ nội bộ:\n{exc}")
        return

    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    threading.Thread(target=server.serve_forever, name="mpt-server", daemon=True).start()

    def shutdown():
        try:
            server.shutdown()
        except Exception:
            pass

    browser = _find_browser()
    if not browser:
        shutdown()
        _fatal(
            "Không tìm thấy Microsoft Edge hoặc Google Chrome để mở cửa sổ ứng dụng.\n"
            "Cài Edge (có sẵn trên Windows 10/11) rồi chạy lại."
        )
        return

    args = [
        browser,
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--disable-features=Translate,msEdgeSplitScreen",
        "--window-size=1440,920",
    ]
    if str(os.environ.get("MPT_DASHBOARD_DEBUG", "")).strip() not in ("", "0"):
        args.append("--auto-open-devtools-for-tabs")

    try:
        proc = subprocess.Popen(args)
    except Exception as exc:
        shutdown()
        _fatal(f"Không mở được cửa sổ ứng dụng:\n{exc}")
        return

    try:
        started = time.monotonic()
        proc.wait()
        # Edge/Chrome đôi khi bàn giao cho tiến trình khác rồi thoát ngay. Nếu
        # thoát quá nhanh, theo dõi cho tới khi không còn cửa sổ nào của profile.
        if time.monotonic() - started < 4:
            time.sleep(1.5)
            while _profile_windows_alive(str(profile)):
                time.sleep(2)
    finally:
        shutdown()
        del guard


if __name__ == "__main__":
    main()
