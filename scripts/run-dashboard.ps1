param(
  [int]$Port = 8787,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $python) { throw 'Python is required.' }

$argsList = @()
if ($python.Name -eq 'py.exe') { $argsList += '-3' }
$argsList += @(
  (Join-Path $PSScriptRoot 'mpt_dashboard_server.py'),
  '--root', $root,
  '--port', $Port
)

$logDir = Join-Path $root 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stderrLog = Join-Path $logDir 'mpt-dashboard-server.err.log'
$stdoutLog = Join-Path $logDir 'mpt-dashboard-server.out.log'

function Quote-Arg([string]$Value) {
  if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
  return $Value
}

$argumentString = ($argsList | ForEach-Object { Quote-Arg $_ }) -join ' '

$url = "http://127.0.0.1:$Port/"

if ($Foreground) {
  Start-Process $url | Out-Null
  & $python.Source @argsList
  exit $LASTEXITCODE
}

$process = Start-Process -FilePath $python.Source -ArgumentList $argumentString -WorkingDirectory $root -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Start-Sleep -Seconds 3
if ($process.HasExited) {
  Write-Error "Dashboard server exited. See: $stderrLog"
  if (Test-Path -LiteralPath $stderrLog) { Get-Content -LiteralPath $stderrLog -ErrorAction SilentlyContinue }
  exit 1
}
Start-Process $url | Out-Null

"Integrated dashboard opened: $url"
"Server process id: $($process.Id)"
"Stop server: Stop-Process -Id $($process.Id)"
"Server logs: $stdoutLog ; $stderrLog"
