# Chạy cửa sổ ứng dụng native từ mã nguồn (dev).
# Cần: python -m pip install -r requirements.txt
$ErrorActionPreference = 'Stop'
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $python) { throw 'Python is required.' }
& $python.Source (Join-Path $PSScriptRoot 'mpt_dashboard_app.py')
