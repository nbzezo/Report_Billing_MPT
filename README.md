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

Ket qua: `dist\MPT Call Dashboard\` — chay `MPT Call Dashboard.exe`. No chay server noi bo
roi mo dashboard bang **cua so Microsoft Edge / Chrome che do `--app`** (khong thanh dia chi,
ho so rieng trong `data\edge\`), khong cua so terminal. Lan chay dau tu tao `config\`,
`logs\`, `data\edge\` ngay trong thu muc do.

**Chep sang may khac:** copy ca thu muc `MPT Call Dashboard\` (ke ca `config\`) — mat khau MPT
da luu van dung duoc vi `config\secret.key` di kem. May dich can Windows 10/11 co san
**Microsoft Edge** (moi may Win10/11 deu co) hoac Chrome.

Chi tiet + luu y ky ich: [`build/README.md`](build/README.md).

Chay cua so native tu ma nguon (dev): `python -m pip install -r requirements.txt` roi
`.\scripts\run-app.ps1`.

Loi tat Desktop cho cua so native: tao shortcut tro toi
`pythonw.exe "<repo>\scripts\mpt_dashboard_app.py"` (workdir = thu muc repo).
`pythonw.exe` khong hien cua so terminal; server da tu gan stdout/stderr vao
devnull khi khong co console nen van chay binh thuong.

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

- `V2_0_Call_Dashboard_MPT.html` - Dashboard chinh (giao dien + ve bieu do)
- `dashboard-core.js` - Logic thuan (khong DOM): normalize/classify/enrich +
  ~40 ham tong hop + `buildCube()`. Dung chung boi trang, Web Worker va Node test.
- `dashboard-csv-worker.js` - Web Worker: giu du lieu da enrich, dung "cube" tong
  hop NGOAI luong UI (parse/normalize/enrich/aggregate deu chay o day).
- `mpt_filter.html` - Trang filter cu, duoc giu lai de tuong thich
- `scripts/mpt_dashboard_server.py` - Server noi bo (proxy MPT API)
- `scripts/mpt_dashboard_app.py` - Cua so native (dung cho ban portable)
- `scripts/routing_events.py` - Thu thap lich su Block/Reactive CID tu trang MPT
  `routing/reports` (scrape theo tung ngay, cache cuon trong `.cache/`)
- `scripts/run-dashboard.ps1` - Chay tren trinh duyet
- `scripts/run-app.ps1` - Chay cua so native tu ma nguon
- `scripts/run-worktree.py` - Chay tu git worktree, dung lai `config/` cua checkout chinh
- `build/` - Spec + script dong goi ban portable
- `docs/cid-lifecycle-analysis.md` - **Ghi chep phan tich tab Vong doi CID**: so
  lieu do duoc, cac quyet dinh va **cac gia thuyet DA THU VA THAT BAI**. Doc truoc
  khi danh gia lai hoac bo sung tab nay de khoi phan tich lai tu dau.

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
- **Xử lý nặng chạy trong Web Worker.** Parse CSV, chuẩn hoá schema, phân loại cuộc gọi, enrich và toàn bộ ~40 phép tổng hợp (kể cả CCU/concurrency và tính cước) chạy trong `dashboard-csv-worker.js`, không khoá luồng giao diện. Trang chỉ nhận một "cube" gọn (`buildCube`) rồi vẽ. Với ~40.000 dòng: ingest ~0,85s + cube ~0,6s, đều ngoài luồng UI. Không có Worker thì tự chạy lại trên main thread (`buildCube(enriched, params)`).
- **Vẽ biểu đồ tăng dần.** Mỗi tab vẽ từng biểu đồ rồi nhả luồng (`renderSteps`/`yieldFrame` — ưu tiên trước paint, fallback `setTimeout` khi cửa sổ ẩn), kèm tiến độ *Đang vẽ biểu đồ X/Y* trên màn chờ. Cửa sổ phản hồi liên tục trong lúc dựng ~20 biểu đồ.
- CSV trên 20 MB tiếp tục dùng parser streaming.
- Plotly nằm trong `vendor/`, nên biểu đồ vẫn hoạt động khi mất Internet.
- Mật khẩu profile được mã hóa bằng keyfile `config/secret.key` (AES-256-GCM) đi kèm thư mục, nên bản portable copy sang máy khác vẫn dùng được. Profile cũ mã hóa bằng Windows DPAPI vẫn đọc được trên đúng máy đã tạo và tự chuyển sang scheme mới ở lần khởi động kế tiếp; sang máy khác thì cần nhập lại mật khẩu.
- Server chỉ phục vụ file giao diện cần thiết; `config/`, `logs/`, backup và mã nguồn bị chặn qua HTTP.

## Kiểm thử

```powershell
python -m unittest discover -s tests -v   # Python: server, đóng gói, cấu trúc HTML/worker/core
node --test tests/core.test.mjs           # Node: đối chiếu số của dashboard-core.js + buildCube
```

`python -m unittest` cũng tự gọi `node --test` nếu có Node.

Bộ test kiểm tra: profile encryption/migration (keyfile + DPAPI cũ), keyfile portable đi theo thư mục, `app_root()`/`create_server()`, static-file allowlist; `dashboard-core.js` là nguồn duy nhất và không tham chiếu DOM; `buildCube` khớp số trên dữ liệu mẫu (2 định dạng nguồn); giao thức Web Worker + fallback main-thread; render đọc từ cube; tab Cước phí qua worker; vẽ tăng dần có `yieldFrame`.
