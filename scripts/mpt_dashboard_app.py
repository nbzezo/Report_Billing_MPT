#!/usr/bin/env python3
"""Native desktop window for the MPT Call Dashboard (portable Windows build).

Runs the existing local server on an ephemeral port and shows it in a WebView2
window instead of a browser tab. Data (``config/``, ``logs/``, ``data/webview2/``)
lives next to the executable so the whole app is portable: copy the folder,
double-click ``MPT Call Dashboard.exe``.
"""
import ctypes
import sys
import threading
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


def main():
    guard = _single_instance_guard()
    root = app_root()
    storage = root / "data" / "webview2"
    storage.mkdir(parents=True, exist_ok=True)

    try:
        server = create_server(host="127.0.0.1", port=0, root=root)
    except OSError as exc:
        _fatal(f"Không khởi động được máy chủ nội bộ:\n{exc}")
        return

    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, name="mpt-server", daemon=True).start()

    def shutdown():
        try:
            server.shutdown()
        except Exception:
            pass

    try:
        import webview
    except ImportError:
        shutdown()
        _fatal("Bản đóng gói thiếu thư viện giao diện (pywebview). Hãy build lại.")
        return

    window = webview.create_window(
        APP_TITLE,
        f"http://127.0.0.1:{port}/",
        width=1440,
        height=920,
        min_size=(1024, 680),
    )
    window.events.closed += shutdown

    try:
        webview.start(storage_path=str(storage), private_mode=False)
    except Exception as exc:
        _fatal(
            "Không mở được cửa sổ ứng dụng.\n"
            "Máy có thể thiếu 'Microsoft Edge WebView2 Runtime'.\n"
            "Cài tại: https://developer.microsoft.com/microsoft-edge/webview2/\n\n"
            f"Chi tiết: {exc}"
        )
    finally:
        shutdown()
        del guard


if __name__ == "__main__":
    main()
