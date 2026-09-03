# MPT Call Dashboard

Dashboard phan tich Call Data MPT voi workflow mot man hinh:
1. Chon/sua ket noi MPT ngay tren Dashboard
2. Chon Account, ngay, huong... trong **Nguon du lieu MPT**
3. Nhan **Tai / Cap nhat bao cao** -> du lieu va bieu do cap nhat tai cho

## Chay

```powershell
cd "C:\X1 Gen7 _ Document\Update Call Data - Copy"
.\scripts\run-dashboard.ps1
```

Hoac bam dup shortcut `MPT Call Dashboard` tren Desktop. Shortcut khoi dong an va mo thang Dashboard hop nhat, khong de lai cua so terminal.

Script se:
- Khoi chay server noi bo
- Mo Dashboard tren trinh duyet
- Khong hoi password o terminal nua

## Ung dung Windows (ban portable)

Dong goi thanh mot thu muc chay doc lap, **khong can cai Python**, copy sang may khac la chay.

```powershell
python -m pip install -r build\requirements-build.txt
.\build\build.ps1
```

Ket qua: `dist\MPT Call Dashboard\` — chay `MPT Call Dashboard.exe`. Cua so native (WebView2),
khong con tab trinh duyet, khong cua so terminal. Lan chay dau tu tao `config\`, `logs\`,
`data\webview2\` ngay trong thu muc do.

**Chep sang may khac:** copy ca thu muc `MPT Call Dashboard\` (ke ca `config\`) — mat khau MPT
da luu van dung duoc vi `config\secret.key` di kem. May dich can Windows 10 (1803+)/11 co
**Microsoft Edge WebView2 Runtime** (gan nhu may nao cung co san).

Chi tiet + luu y ky ich: [`build/README.md`](build/README.md).

Chay cua so native tu ma nguon (dev): `python -m pip install -r requirements.txt` roi
`.\scripts\run-app.ps1`.

## Flow su dung

1. Mo Dashboard tai `http://127.0.0.1:8787/`
2. Trong **Nguon du lieu MPT**, chon ket noi da luu; danh sach Account duoc nap tu dong.
3. Neu them moi: mo **Quan ly ket noi**, nhap Domain/Username/Password -> **Kiem tra ket noi** -> **Luu ket noi**.
4. Chon mot hoac nhieu Account. Khong chon account nao = All Account.
5. Chon ngay bat dau, ngay ket thuc
6. Chon Direction, Hangup Cause, Call Type, Telco (neu can)
7. Nhan **Tai / Cap nhat bao cao** -> Dashboard cap nhat ngay, khong chuyen trang.
8. Dung **Bo loc chinh** de loc nhanh ngay, gio va Account tren du lieu da tai ma khong goi lai MPT.

## Hieu nang

- Nhieu Account duoc export bang session rieng tung Account de tranh MPT tra nham filter.
- Ket qua filter duoc cache trong RAM 10 phut (toi da 8 filter). Chay lai cung profile/filter se nhanh hon va dashboard hien `MPT cache: HIT`.
- Cache bi xoa khi luu hoac xoa profile, va tu mat khi dung local server.

## Luu profile

Profiles duoc luu cuc bo tai:

`config/profiles.json`

Mat khau duoc ma hoa bang `config/secret.key` (AES-256-GCM). Ca thu muc `config/` nam trong
`.gitignore`. Vi khoa di kem thu muc nen ban portable copy sang may khac van dung duoc mat khau —
doi lai, ai doc duoc thu muc deu giai ma duoc (xem **Bao mat**).

## File chinh

- `V2_0_Call_Dashboard_MPT.html` - Dashboard chinh
- `mpt_filter.html` - Trang filter cu, duoc giu lai de tuong thich
- `scripts/mpt_dashboard_server.py` - Server noi bo (proxy MPT API)
- `scripts/mpt_dashboard_app.py` - Cua so native (dung cho ban portable)
- `scripts/run-dashboard.ps1` - Chay tren trinh duyet
- `scripts/run-app.ps1` - Chay cua so native tu ma nguon
- `build/` - Spec + script dong goi ban portable

## Bao mat

Khong commit/chia se thu muc `config/` vi trong do co profile dang nhap da luu.

Ban portable danh doi bao mat lay tinh tien loi: khoa giai ma (`config/secret.key`) nam ngay
canh `profiles.json`, nen **bat ky ai doc duoc thu muc app (hoac USB chua no) deu giai ma duoc
mat khau MPT**. Dung dat thu muc portable len o dia/USB dung chung cong khai.

## Giao diện

Dashboard dựng theo UI/UX của Ubuntu (Yaru + GNOME HIG):

- **Header bar** cố định: tên app, dòng trạng thái nguồn dữ liệu, nút chính **Tải báo cáo** (cam Ubuntu `#E95420`) và menu ☰.
- **Sidebar** thay cho thanh tab ngang: 5 nhóm báo cáo, hàng đang chọn tô cam.
- **Thanh lọc** dính ngay dưới header cho **Bộ lọc chính** — thứ dùng liên tục.
- **Dialog** kiểu Adwaita cho Nguồn dữ liệu MPT, Tải file thủ công, Tùy chọn phân tích & màu sắc, Gán tên Account.
  Đóng bằng nút X, nút Đóng, phím Esc hoặc bấm ra ngoài.
- **Menu ☰** gom Xuất PNG/PDF, Đặt lại bố cục, Chế độ tối (công tắc kiểu GNOME).
- **Sáng/tối** theo hệ thống khi người dùng chưa tự chọn; biểu đồ Plotly dùng chung nền, phông và bảng màu Yaru.
- Font **Ubuntu Sans** nằm trong `vendor/`; vì Ubuntu Sans không có glyph tiếng Việt nên subset tiếng Việt của
  Noto Sans đi kèm để phủ dải đó — vẫn chạy được khi mất Internet.

## Nâng cấp trải nghiệm và bảo mật

- Danh sách Account đã lưu được nạp tự động sau khi chọn kết nối; chọn **Làm mới tài khoản** khi cần đồng bộ lại từ MPT.
- Bộ lọc gần nhất được ghi nhớ trong trình duyệt. Ngày mặc định dùng đúng múi giờ máy tính.
- Màn hình tải báo cáo hiển thị thời gian chờ và cho phép hủy/thử lại. Khi tải lỗi có thêm nút **Đóng** (hoặc phím Esc) để quay lại dashboard; tham số `?csv=` cũng được gỡ khỏi URL nên lần F5 sau không tự chạy lại và kẹt tiếp.
- Tải nhiều Account hiển thị tiến độ thật: *Đang tải tài khoản 7/40 — tên account*, lấy từ `/api/export-progress`.
- **Bộ lọc chính** hiển thị phạm vi dữ liệu đang có. Nếu khoảng lọc nằm ngoài dữ liệu đã tải, dashboard cảnh báo kèm nút **Tải khoảng này từ MPT** thay vì im lặng trả về 0.
- Không nạp được danh sách Account không còn chặn cả luồng: chỉ cần chọn kết nối là bấm được **Tải / Cập nhật báo cáo** (bỏ trống account = tất cả).
- **Bộ lọc chính** đổi thành *Áp dụng thay đổi* khi có thay đổi chưa áp dụng; nhấn Enter trong ô ngày/giờ cũng áp dụng.
- Nhãn tách bạch: **Tài khoản cần tải** (lấy từ MPT) và **Tài khoản đang xem** (lọc trên dữ liệu đã tải).
- Dữ liệu lần gần nhất được nhớ trong IndexedDB (tối đa 200.000 dòng). Mở lại app sẽ hiện banner
  *Dữ liệu lần trước… [Dùng lại] [Bỏ qua]* thay vì phải export lại từ MPT.
- Lưu kết nối trùng domain + tên đăng nhập sẽ hỏi lại trước khi tạo thêm.
- Bỏ nút *Lưu vào HTML* ở phần gán tên Account: mapping đã tự lưu trong trình duyệt, và file HTML tải về
  không nằm trong allowlist nên mở qua server không chạy. Vẫn còn Export/Import JSON.
- CSV thông thường được parse bằng Web Worker; CSV trên 20 MB tiếp tục dùng parser streaming.
- Plotly nằm trong `vendor/`, nên biểu đồ vẫn hoạt động khi mất Internet.
- Mật khẩu profile được mã hóa bằng keyfile `config/secret.key` (AES-256-GCM) đi kèm thư mục, nên bản portable copy sang máy khác vẫn dùng được. Profile cũ mã hóa bằng Windows DPAPI vẫn đọc được trên đúng máy đã tạo và tự chuyển sang scheme mới ở lần khởi động kế tiếp; sang máy khác thì cần nhập lại mật khẩu.
- Server chỉ phục vụ file giao diện cần thiết; `config/`, `logs/`, backup và mã nguồn bị chặn qua HTTP.

## Kiểm thử

```powershell
python -m unittest discover -s tests -v
```

Bộ test kiểm tra profile encryption/migration (keyfile + DPAPI cũ), keyfile portable đi theo thư mục, `app_root()`/`create_server()`, static-file allowlist, ngày local, thứ tự khởi tạo biểu đồ, loading/accessibility và Web Worker.
