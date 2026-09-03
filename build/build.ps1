# Đóng gói bản portable vào  dist\MPT Call Dashboard\
#   .\build\build.ps1            # build
#   .\build\build.ps1 -Clean     # xóa build cũ rồi build
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$work = Join-Path $root 'build\_pyi'
$dist = Join-Path $root 'dist'
if ($Clean) {
    Remove-Item -Recurse -Force $work, $dist -ErrorAction SilentlyContinue
}

python -m pip install -r (Join-Path $root 'build\requirements-build.txt')
python -m PyInstaller (Join-Path $root 'build\mpt_dashboard.spec') --noconfirm `
    --distpath $dist --workpath $work

$appDir = Join-Path $dist 'MPT Call Dashboard'
if (-not (Test-Path $appDir)) { throw "PyInstaller không tạo được $appDir" }

# Dashboard + tài nguyên đi kèm dạng file rời cạnh .exe (sửa nóng được).
Copy-Item (Join-Path $root 'V2_0_Call_Dashboard_MPT.html') $appDir
Copy-Item (Join-Path $root 'mpt_filter.html')             $appDir
Copy-Item (Join-Path $root 'dashboard-csv-worker.js')     $appDir
Copy-Item (Join-Path $root 'vendor')                      $appDir -Recurse -Force

Write-Host ''
Write-Host "Bản portable đã sẵn sàng: $appDir"
Write-Host "Copy cả thư mục này sang máy Windows 10/11 khác và chạy 'MPT Call Dashboard.exe'."
Write-Host "Lần chạy đầu sẽ tạo config\, logs\, data\ ngay trong thư mục đó."
