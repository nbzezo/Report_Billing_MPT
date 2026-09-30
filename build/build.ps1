# Đóng gói bản portable vào  dist\MPT Call Dashboard\
#   .\build\build.ps1            # build
#   .\build\build.ps1 -Clean     # xóa build cũ rồi build
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$work = Join-Path $root 'build\_pyi'
$dist = Join-Path $root 'dist'
$appDir = Join-Path $dist 'MPT Call Dashboard'
$runtimePreserve = Join-Path $root 'build\_runtime-preserve'
$runtimeDirs = @('config', 'data', '.cache', 'logs')

Remove-Item -Recurse -Force $runtimePreserve -ErrorAction SilentlyContinue
if (Test-Path $appDir) {
    New-Item -ItemType Directory -Path $runtimePreserve | Out-Null
    foreach ($name in $runtimeDirs) {
        $source = Join-Path $appDir $name
        if (Test-Path -LiteralPath $source) {
            Move-Item -LiteralPath $source -Destination $runtimePreserve -Force
        }
    }
}

if ($Clean) {
    Remove-Item -Recurse -Force $work, $dist -ErrorAction SilentlyContinue
}

python -m pip install -r (Join-Path $root 'build\requirements-build.txt')
python -m PyInstaller (Join-Path $root 'build\mpt_dashboard.spec') --noconfirm `
    --distpath $dist --workpath $work

if (-not (Test-Path $appDir)) { throw "PyInstaller không tạo được $appDir" }

# Giữ dữ liệu runtime của bản portable khi build lại tại chỗ.
foreach ($name in $runtimeDirs) {
    $saved = Join-Path $runtimePreserve $name
    if (Test-Path -LiteralPath $saved) {
        Move-Item -LiteralPath $saved -Destination $appDir -Force
    }
}
Remove-Item -Recurse -Force $runtimePreserve -ErrorAction SilentlyContinue

# Dashboard + tài nguyên đi kèm dạng file rời cạnh .exe (sửa nóng được).
Copy-Item (Join-Path $root 'V2_0_Call_Dashboard_MPT.html') $appDir
Copy-Item (Join-Path $root 'mpt_filter.html')             $appDir
Copy-Item (Join-Path $root 'dashboard-core.js')           $appDir
Copy-Item (Join-Path $root 'dashboard-csv-worker.js')     $appDir
Copy-Item (Join-Path $root 'analytics-worker.js')         $appDir
Copy-Item (Join-Path $root 'vendor')                      $appDir -Recurse -Force

# Backend analytics dùng chính dashboard-core.js qua Node và đọc SQLite trực
# tiếp. Đóng gói node.exe để máy đích không cần cài Node riêng.
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $nodePath --version).TrimStart('v').Split('.')
$nodeMajor = [int]$nodeVersion[0]
$nodeMinor = [int]$nodeVersion[1]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 5)) {
    throw 'Cần Node.js >= 22.5 để đóng gói analytics worker (node:sqlite).'
}
Copy-Item $nodePath (Join-Path $appDir 'node.exe')

Write-Host ''
Write-Host "Bản portable đã sẵn sàng: $appDir"
Write-Host "Copy cả thư mục này sang máy Windows 10/11 khác và chạy 'MPT Call Dashboard.exe'."
Write-Host "Lần chạy đầu sẽ tạo config\, logs\, data\ ngay trong thư mục đó."
