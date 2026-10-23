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

# pythonw.exe và bản đóng gói --windowed KHÔNG có console: sys.stdout/stderr là
# None. http.server ghi một dòng log mỗi request ra stderr; nếu stderr là None
# thread xử lý request sẽ chết giữa chừng -> trình duyệt báo "response ended
# prematurely". Gắn devnull để server chạy bình thường khi không có console.
for _stream in ("stdout", "stderr"):
    if getattr(sys, _stream, None) is None:
        try:
            setattr(sys, _stream, open(os.devnull, "w", encoding="utf-8"))
        except OSError:
            pass

from mpt_dashboard_server import app_root, create_server  # noqa: E402

APP_TITLE = "MPT Call Dashboard"
MUTEX_NAME = "Global\\MPTCallDashboard.SingleInstance"
_ERROR_ALREADY_EXISTS = 183
_MB_ICONERROR = 0x10
_MB_ICONINFO = 0x40
# Chạy powershell/icacls mà KHÔNG có cửa sổ console. Dưới pythonw.exe hoặc bản
# đóng gói --windowed (không có console sẵn), mỗi lần subprocess gọi một tiến
# trình console sẽ bung MỘT cửa sổ terminal mới. CREATE_NO_WINDOW một mình từng
# không đủ trên vài máy -> kèm luôn STARTUPINFO ẩn cửa sổ cho chắc.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _hidden_startupinfo():
    if not sys.platform.startswith("win"):
        return None
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0  # SW_HIDE
    return si


def _run_hidden(cmd, **kwargs):
    """subprocess.run() nhưng đảm bảo không bao giờ hiện cửa sổ terminal."""
    kwargs["creationflags"] = kwargs.get("creationflags", 0) | _NO_WINDOW
    si = _hidden_startupinfo()
    if si is not None:
        kwargs.setdefault("startupinfo", si)
    return subprocess.run(cmd, **kwargs)


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


def _kill_stale_windows(marker):
    """Đóng mọi cửa sổ Edge/Chrome đang mở hồ sơ này (từ lần chạy trước) để
    không còn cửa sổ trỏ vào server đã chết — Edge --app cùng --user-data-dir
    sẽ mở thêm cửa sổ trong tiến trình cũ thay vì tiến trình mới."""
    if not sys.platform.startswith("win"):
        return
    ps = (
        "Get-CimInstance Win32_Process -Filter \"name='msedge.exe' or name='chrome.exe'\" "
        "-ErrorAction SilentlyContinue | "
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:MPT_EDGE_MARKER) } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    try:
        _run_hidden(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, timeout=15,
            env=dict(os.environ, MPT_EDGE_MARKER=marker),
        )
        time.sleep(1.0)
    except Exception:
        pass


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
        out = _run_hidden(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=15, env=env,
        )
        return (out.stdout or "").strip() not in ("", "0")
    except Exception:
        return True  # lỗi poll -> coi như còn sống, không tắt server nhầm


def _kill_profile_windows(marker):
    """Terminate browser processes that belong exclusively to this app profile.

    Edge/Chrome may keep the ``--app`` process alive after its last window is
    closed (for background services or a shared browser process). The profile
    marker scopes the cleanup to this portable app and leaves the user's normal
    browser windows untouched.
    """
    if not sys.platform.startswith("win"):
        return
    ps = (
        "$m=$env:MPT_EDGE_MARKER;"
        "Get-CimInstance Win32_Process -Filter \"name='msedge.exe' or name='chrome.exe'\""
        " -ErrorAction SilentlyContinue |"
        " Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) } |"
        " ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    try:
        _run_hidden(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, timeout=15,
            env=dict(os.environ, MPT_EDGE_MARKER=marker),
        )
    except Exception:
        pass


def main():
    guard = _single_instance_guard()  # noqa: F841 (kept alive for process lifetime)
    root = app_root()
    profile = root / "data" / "edge"
    profile.mkdir(parents=True, exist_ok=True)

    try:
        server = create_server(host="127.0.0.1", port=0, root=root)
    except Exception as exc:
        _fatal(f"Không khởi động được máy chủ nội bộ:\n{exc}")
        return

    port = server.server_address[1]
    debug_env = str(os.environ.get("MPT_DASHBOARD_DEBUG", "")).strip() not in ("", "0")
    url = f"http://127.0.0.1:{port}/"
    threading.Thread(target=server.serve_forever, name="mpt-server", daemon=True).start()

    def shutdown():
        try:
            server.shutdown()
        except Exception:
            pass
        try:
            # server.shutdown() only stops serve_forever(). server_close() also
            # terminates the long-lived analytics worker and closes the socket.
            server.server_close()
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
        # Không nạp tiện ích mở rộng / thành phần thừa của Edge — chúng hay chèn
        # lớp phủ hoặc bắt sự kiện chuột làm hỏng nút bấm của dashboard.
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-features=Translate,msEdgeSplitScreen,MSShopping,EdgeCollections,"
        "EdgeSidebarUI,msWebOOUI,msEdgeSidebarV2,EdgeDiscoverFeatureSettings",
        "--window-size=1440,920",
    ]
    if debug_env:
        args.append("--auto-open-devtools-for-tabs")

    _kill_stale_windows(str(profile))

    try:
        proc = subprocess.Popen(args)
    except Exception as exc:
        shutdown()
        _fatal(f"Không mở được cửa sổ ứng dụng:\n{exc}")
        return

    try:
        marker = str(profile)
        # Vừa kill hết cửa sổ hồ sơ này ở trên -> lần mở đầu gần như luôn là
        # tiến trình của chính `proc`, nên proc.wait() đủ và KHÔNG cần gọi
        # powershell trong lúc chạy. Chỉ khi Edge bàn giao URL cho một msedge.exe
        # sẵn có rồi proc thoát sớm thì mới poll (chậm, 8s) để bắt lúc đóng.
        try:
            proc.wait()
        except Exception:
            pass
        time.sleep(3)  # để cửa sổ / tiến trình con kịp xuất hiện nếu có bàn giao
        if _profile_windows_alive(marker):
            misses = 0
            while misses < 2:
                time.sleep(8)
                misses = 0 if _profile_windows_alive(marker) else misses + 1
    finally:
        # The app window can disappear while Edge keeps the profile process in
        # the background. Clean it up before returning from the launcher so the
        # portable app really exits instead of leaving a hidden process behind.
        _kill_profile_windows(marker)
        shutdown()
        del guard


if __name__ == "__main__":
    main()
