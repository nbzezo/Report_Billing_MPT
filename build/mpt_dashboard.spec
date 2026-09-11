# -*- mode: python ; coding: utf-8 -*-
# Bản portable one-folder của MPT Call Dashboard.
# Build qua build/build.ps1 (script này còn copy HTML + core + worker + vendor/
# cạnh .exe sau đó).
#
# App native mở dashboard bằng cửa sổ Edge/Chrome --app, KHÔNG nhúng thư viện
# GUI nào -> bundle gọn, không cần pywebview / pythonnet / WebView2.
from pathlib import Path

ROOT = Path(SPECPATH).parent
ICON = ROOT / "build" / "app.ico"

a = Analysis(
    [str(ROOT / "scripts" / "mpt_dashboard_app.py")],
    pathex=[str(ROOT / "scripts")],
    binaries=[],
    datas=[],
    hiddenimports=[
        "mpt_dashboard_server", "routing_events",
        "llm_client", "llm_providers", "llm_providers._openai_compat",
        "llm_providers.anthropic_provider", "llm_providers.gemini_provider",
        "llm_providers.deepseek_provider", "llm_providers.gateway_provider",
        "risk_engine",
    ],
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
