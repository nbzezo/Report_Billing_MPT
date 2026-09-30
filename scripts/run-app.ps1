param(
  [switch]$Foreground
)

# Chạy cửa sổ ứng dụng native từ mã nguồn (dev).
# Mặc định dùng pythonw/pyw để không hiện terminal. Dùng -Foreground khi cần log.
# Cần: python -m pip install -r requirements.txt
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'mpt_dashboard_app.py'
$root = Split-Path -Parent $PSScriptRoot

if ($Foreground) {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
  if (-not $python) { throw 'Python is required.' }

  if ($python.Name -eq 'py.exe') {
    & $python.Source -3 $script
  } else {
    & $python.Source $script
  }
  exit $LASTEXITCODE
}

$python = Get-Command pythonw -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command pyw -ErrorAction SilentlyContinue }
if (-not $python) { throw 'Python is required.' }

$argsList = @()
if ($python.Name -eq 'pyw.exe') { $argsList += '-3' }
$argsList += $script

Start-Process `
  -FilePath $python.Source `
  -ArgumentList $argsList `
  -WorkingDirectory $root `
  -WindowStyle Hidden | Out-Null
