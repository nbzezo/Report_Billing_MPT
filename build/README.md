# Đóng gói bản portable (ứng dụng Windows)

Tạo một thư mục chạy độc lập, **không cần cài Python**, copy sang máy khác là chạy.

## Yêu cầu trên máy build

- Windows 10/11, Python 3.11+
- `python -m pip install -r build/requirements-build.txt`

## Build

```powershell
.\build\build.ps1
```

Kết quả: `dist\MPT Call Dashboard\`

```
MPT Call Dashboard\
├─ MPT Call Dashboard.exe        ← chạy cái này
├─ _internal\                    ← Python runtime + thư viện (pywebview, cryptography…)
├─ V2_0_Call_Dashboard_MPT.html  ← file rời, sửa nóng được
├─ mpt_filter.html
├─ dashboard-core.js            ← logic thuần dùng chung
├─ dashboard-csv-worker.js      ← Web Worker (tổng hợp ngoài luồng UI)
└─ vendor\                       ← plotly + font
```

Lần chạy đầu tự tạo `config\` (có `profiles.json` + `secret.key`), `logs\`, `data\webview2\`
ngay trong thư mục app.

## Chép sang máy khác

Copy **cả thư mục** `MPT Call Dashboard\`. Kể cả `config\` → mật khẩu MPT đã lưu vẫn dùng
được vì `secret.key` đi kèm.

> ⚠️ **Bảo mật:** ai đọc được thư mục (hoặc USB chứa nó) đều giải mã được mật khẩu MPT,
> vì khóa nằm ngay trong `config\secret.key`. Đừng đặt thư mục lên ổ chia sẻ công khai.

## Yêu cầu trên máy chạy

- Windows 10 (1803+) / 11
- **Microsoft Edge WebView2 Runtime** — có sẵn trên gần như mọi máy Win10/11 (Edge tự cài).
  Nếu thiếu, app hiện thông báo kèm link tải:
  <https://developer.microsoft.com/microsoft-edge/webview2/>

## Ghi chú

- `.exe` **chưa ký số** → Windows SmartScreen có thể cảnh báo "unknown publisher" và một số
  antivirus báo nhầm ở lần đầu. Chấp nhận được khi copy nội bộ giữa máy quen; muốn hết cảnh
  báo thì cần chứng chỉ Authenticode để ký.
- Đóng gói `pywebview` đôi khi vướng `pythonnet`/hidden-import. Nếu `.exe` mở lên tắt ngay,
  build lại với `console=True` trong `build/mpt_dashboard.spec` để đọc traceback.
- Icon: đặt file `build\app.ico` là spec tự nhận.
