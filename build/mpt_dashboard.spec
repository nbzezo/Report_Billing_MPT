# -*- mode: python ; coding: utf-8 -*-
# Bản portable one-folder của MPT Call Dashboard.
# Build qua build/build.ps1 (script này còn copy HTML + vendor/ cạnh .exe sau đó).
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

ROOT = Path(SPECPATH).parent
ICON = ROOT / "build" / "app.ico"

datas, binaries, hiddenimports = [], [], ["mpt_dashboard_server", "clr"]
for pkg in ("webview", "clr_loader"):
    try:
        pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    except Exception:
        continue
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

a = Analysis(
    [str(ROOT / "scripts" / "mpt_dashboard_app.py")],
    pathex=[str(ROOT / "scripts")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter"],
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="MPT Call Dashboard",
    console=False,
    disable_windowed_traceback=False,
    icon=str(ICON) if ICON.exists() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="MPT Call Dashboard",
)
