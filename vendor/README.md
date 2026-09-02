# Tài nguyên cục bộ

Giữ ở đây để dashboard chạy đủ chức năng khi mất Internet.

- `plotly-2.24.2.min.js` — thư viện biểu đồ. HTML chỉ dùng CDN làm phương án dự phòng.
- `UbuntuSans-variable.woff2` — Ubuntu Sans 1.006 (variable, wdth+wght), giấy phép Ubuntu Font Licence trong `UbuntuSans-LICENCE.txt`.
- `NotoSans-vietnamese.woff2` — subset tiếng Việt của Noto Sans (SIL OFL). Ubuntu Sans **không có** glyph tiếng Việt
  (thiếu ạ ả ấ ệ ỗ ữ ợ… và ₫), nên font này phủ đúng dải U+1EA0–U+1EF9 — cùng cách Ubuntu fallback trên desktop.

Server chỉ phục vụ đúng các file trong allowlist của `scripts/mpt_dashboard_server.py`.
