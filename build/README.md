# Đóng gói bản portable (ứng dụng Windows)

Tạo một thư mục chạy độc lập, **không cần cài Python**, copy sang máy khác là chạy.

## Yêu cầu trên máy build

- Windows 10/11, Python 3.11+, Node.js 22.5+

Script tự tạo `build\_venv\` và cài đúng phiên bản dependency đã khóa.

## Build

```powershell
.\build\build.ps1
```

Kết quả: `dist\MPT Call Dashboard\`

```
MPT Call Dashboard\
├─ MPT Call Dashboard.exe        ← chạy cái này
├─ _internal\                    ← Python runtime + cryptography (rất gọn)
├─ V2_0_Call_Dashboard_MPT.html  ← file rời, sửa nóng được
├─ dashboard-core.js             ← logic thuần dùng chung
├─ dashboard-csv-worker.js       ← Web Worker (tổng hợp ngoài luồng UI)
├─ analytics-worker.js           ← analytics backend đọc SQLite trực tiếp
├─ node.exe                      ← Node runtime được đóng gói sẵn
└─ vendor\                       ← plotly + font
```

`MPT Call Dashboard.exe` chạy server nội bộ rồi mở dashboard bằng **cửa sổ Microsoft Edge
(hoặc Chrome) ở chế độ `--app`** — không thanh địa chỉ, hồ sơ Edge riêng trong `data\edge\`.
Không nhúng thư viện GUI nào nên bundle nhỏ và ổn định.

Lần chạy đầu tự tạo `config\` (có `profiles.json` + `secret.key`), `logs\`, `data\edge\`
ngay trong thư mục app.

## Chép sang máy khác

Copy **cả thư mục** `MPT Call Dashboard\`. Kể cả `config\` → mật khẩu MPT đã lưu vẫn dùng
được vì `secret.key` đi kèm.

> ⚠️ **Bảo mật:** ai đọc được thư mục (hoặc USB chứa nó) đều giải mã được mật khẩu MPT,
> vì khóa nằm ngay trong `config\secret.key`. Đừng đặt thư mục lên ổ chia sẻ công khai.

## Yêu cầu trên máy chạy

- Windows 10 / 11
- **Microsoft Edge** (có sẵn trên mọi máy Win10/11) hoặc **Google Chrome**. Node đã
  nằm trong thư mục portable, máy đích không cần cài thêm. Thiếu cả hai trình duyệt
  thì app báo lỗi kèm hướng dẫn.

## Ghi chú

- `.exe` **chưa ký số** → Windows SmartScreen có thể cảnh báo "unknown publisher" và một số
  antivirus báo nhầm ở lần đầu. Chấp nhận được khi copy nội bộ giữa máy quen; muốn hết cảnh
  báo thì cần chứng chỉ Authenticode để ký.
- `.exe` mở lên tắt ngay → build lại với `console=True` trong `build/mpt_dashboard.spec` để
  đọc traceback.
- `MPT_DASHBOARD_DEBUG=1` → cửa sổ mở kèm DevTools.
- Icon dùng chung cho `.exe` và cửa sổ ứng dụng: `favicon.ico` ở thư mục gốc.
```
