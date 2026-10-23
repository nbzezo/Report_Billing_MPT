# MPT Call Dashboard

Dashboard phân tích dữ liệu cuộc gọi MPT theo một luồng làm việc thống nhất: chọn kết nối và phạm vi xem trên thanh lọc, dùng **Cập nhật** khi cần tải thêm dữ liệu từ MPT, rồi đọc KPI và báo cáo ngay trên cùng màn hình.

## Chay

```powershell
cd "C:\X1 Gen7 _ Document\Update Call Data - Copy"
.\scripts\run-app.ps1
```

Hoac bam dup `Run Dashboard.vbs` / shortcut `MPT Call Dashboard` tren Desktop. Launcher khoi dong an, mo Dashboard nhu mot cua so ung dung va khong de lai cua so terminal. `Run Dashboard.bat` van dung duoc nhu fallback nhanh, nhung Windows co the nhoang mot cua so cmd rat ngan.

Launcher se:
- Khoi chay server noi bo
- Mo Dashboard trong cua so Edge/Chrome che do app
- Tu tat server khi dong cua so Dashboard
- Khong hoi password o terminal nua

Can xem log/debug thi chay:

```powershell
.\scripts\run-app.ps1 -Foreground
```

## Ung dung Windows (ban portable)

Dong goi thanh mot thu muc chay doc lap, **khong can cai Python**, copy sang may khac la chay.

```powershell
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

1. Mở Dashboard tại `http://127.0.0.1:8787/`.
2. Chọn **Kết nối**, **Thời gian** và **Tài khoản đang xem** trên thanh lọc. Mở **Bộ lọc khác** khi cần lọc hướng gọi, nhà mạng, nguyên nhân kết thúc, loại gọi hoặc số điện thoại.
3. Bộ lọc chỉ đọc dữ liệu đã lưu. Dòng độ mới ở header cho biết phạm vi và thời điểm đồng bộ gần nhất.
4. Bấm **Cập nhật** để tải dữ liệu mới từ MPT. Mũi tên cạnh nút mở **Tài khoản cần tải**; phạm vi này độc lập với tài khoản đang xem.
5. Nếu chưa có kết nối, vào **Cài đặt → Kết nối MPT**, nhập Domain/Username/Password, kiểm tra rồi lưu.
6. Đọc KPI Tổng quan trước, sau đó chuyển nhóm báo cáo bằng sidebar. Mỗi nhóm mở tối đa 4–6 báo cáo chính; dùng **Hiển thị thêm** để xem phân tích chuyên sâu.
7. Bấm KPI hoặc chip trạng thái để mở drilldown; nhấn `Esc` để đóng và quay lại đúng vị trí.
8. Mở trợ lý AI bằng nút nổi hoặc `Ctrl+/`. Trợ lý chỉ dùng phạm vi lọc đã áp dụng;
   các số CID/người gọi/đích được loại khỏi payload trước khi gửi nhà cung cấp AI.

## Hieu nang

- Nhieu Account duoc export bang session rieng tung Account de tranh MPT tra nham filter.
- Ket qua filter duoc cache trong RAM 10 phut (toi da 8 filter). Chay lai cung profile/filter se nhanh hon va dashboard hien `MPT cache: HIT`.
- Cache filter MPT bi xoa khi luu hoac xoa profile, va tu mat khi dung local server.
- Bundle bao cao chi gui 5.000 dong xem truoc lay deu theo thoi gian; KPI va cube van tinh tren toan bo du lieu. Chi tiet tung cuoc goi duoc truy van tu server khi mo.
- Cube duoc cache trong tien trinh Node va bundle duoc luu o `.cache/analytics-bundles/` (toi da 8 pham vi). Khoa cache gom revision du lieu, bo loc va phien ban ma nguon; cap nhat du lieu se tu dong dung ket qua moi.
- Do toc do xu ly cuc bo: `node scripts/benchmark_loading.js 2026-10-09 2026-10-16 5000` (thay hai moc ngay theo du lieu cua ban; moc thu hai khong bao gom).

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
  hop NGOAI luong UI cho file nguoi dung tai thu cong va lam fallback.
- `analytics-worker.js` - tien trinh Node ben vung: doc SQLite truc tiep, dung cube,
  drilldown va bao cao cuoc ma khong gui toan bo CDR sang trinh duyet.
- `/mpt_filter.html` - URL cu duoc redirect sang Dashboard chinh de giu bookmark
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

Dashboard dùng hệ thiết kế Ubuntu/Yaru và đáp ứng từ 600–1440 px:

- **Header cố định**: độ mới dữ liệu, một hành động chính **Cập nhật**, phạm vi tài khoản cần tải và menu ứng dụng.
- **Thanh lọc gọn**: kết nối, ngày và tài khoản luôn hiện; bộ lọc phụ nằm trong popover và bộ lọc đang áp dụng hiện thành chip có thể xóa.
- **Sidebar 7 nhóm**: Tổng quan, Chất lượng, Vận hành, Dữ liệu & Tài khoản, Cước phí, Vòng đời CID và Cài đặt. Ở màn hình nhỏ sidebar chuyển thành thanh điều hướng ngang.
- **KPI Tổng quan** ưu tiên tổng cuộc, tỷ lệ kết nối, ASR và tổng phút. Màu trạng thái có cùng ý nghĩa trên KPI, biểu đồ và bảng.
- **Progressive disclosure**: mỗi nhóm chỉ mở các báo cáo quyết định; báo cáo chuyên sâu nằm dưới **Hiển thị thêm N báo cáo**.
- **Trạng thái rỗng và skeleton** giải thích bước tiếp theo, không dùng KPI 0 hoặc màn chờ modal khi chỉ đổi bộ lọc.
- **Cài đặt** chia theo danh mục; nơi duy nhất quản lý kết nối MPT là **Cài đặt → Kết nối MPT**.
- **Sáng/tối** theo hệ thống khi chưa có lựa chọn riêng. Plotly dùng chung token màu, font và định dạng số vi-VN; font và thư viện nằm trong `vendor/` để chạy offline.
- Toàn bộ popover, dialog, drilldown và side sheet hỗ trợ bàn phím, `Esc`, focus rõ ràng và trả focus về nút mở.

Quy ước giao diện cho người phát triển nằm tại [`docs/ui-guidelines.md`](docs/ui-guidelines.md).
- Font **Ubuntu Sans** nằm trong `vendor/`; vì Ubuntu Sans không có glyph tiếng Việt nên subset tiếng Việt của
  Noto Sans đi kèm để phủ dải đó — vẫn chạy được khi mất Internet.

## Nâng cấp trải nghiệm và bảo mật

- Bấm KPI **Tổng cuộc** hoặc từng chip **Fail / No Answer / Huỷ / Connected** để mở bảng chi tiết theo đúng bộ lọc đã bấm **Áp dụng**. Tại các bảng **Account summary** và **Gateway**, bấm tên/key để lọc tiếp theo `account_id` và gateway gốc; bảng chi tiết có phân trang và vẫn giữ tab/bộ lọc hiện tại.
- Danh sách Account đã lưu được nạp tự động sau khi chọn kết nối; chọn **Làm mới tài khoản** khi cần đồng bộ lại từ MPT.
- Bộ lọc gần nhất được ghi nhớ trong trình duyệt. Ngày mặc định dùng đúng múi giờ máy tính.
- Màn hình tải báo cáo hiển thị thời gian chờ và cho phép hủy/thử lại. Khi tải lỗi có thêm nút **Đóng** (hoặc phím Esc) để quay lại dashboard; tham số `?csv=` cũng được gỡ khỏi URL nên lần F5 sau không tự chạy lại và kẹt tiếp.
- Tải nhiều Account hiển thị tiến độ thật: *Đang tải tài khoản 7/40 — tên account*, lấy từ `/api/export-progress`.
- **Bộ lọc chính** gom kết nối MPT, tài khoản, ngày/giờ, hướng gọi, nhà mạng, nguyên nhân kết thúc và loại cuộc gọi. Nút **Xem** chỉ đọc dữ liệu đã lưu trong SQLite (không gọi MPT) rồi mở popup cho biết cuộc gọi cuối cùng và thời điểm cập nhật từ MPT của bộ lọc đó, kèm các ngày còn thiếu. Nút **Cập nhật báo cáo** mới tải từ MPT, và chỉ tải khoảng ngày còn thiếu hoặc chưa trọn vẹn (hôm nay, hoặc ngày được đồng bộ khi chưa kết thúc); ngày đã đủ lấy thẳng từ DB. F5/bookmark luôn chỉ đọc DB. API vẫn nhận `sync=force` nếu cần ép tải lại toàn bộ.
- CSV tải mới từ MPT được chuẩn hoá trực tiếp trong bộ nhớ vào `data/calls.sqlite3`, không tạo file CSV tạm. Kho dữ liệu giữ cuốn chiếu **60 ngày**, tự dọn dữ liệu cũ khi khởi động và định kỳ mỗi 6 giờ. Các file CSV cũ do người dùng tải thủ công không bị xoá.
- Đọc DB theo mô hình server-side analytics: Node worker đọc SQLite trực tiếp và giữ tối đa một dataset gần nhất; dashboard chỉ nhận cube đầy đủ cùng preview tối đa 50.000 dòng. Drilldown và cước phí truy vấn backend trên toàn bộ dữ liệu. CSV legacy/xuất file được stream theo lô, còn cache CSV trong RAM chỉ nhận item nhỏ tối đa 16 MB.
- Nạp dữ liệu lớn trong trình duyệt (đo trên 972 nghìn dòng, kết quả được kiểm là giống hệt bản cũ):
  - Worker parse/chuẩn hoá/enrich **45 s → 9 s** (Node) / **35 s → 16 s** (trình duyệt). Nguyên nhân chính: dựng object bằng `o[tênCột] = v` quá 12 khoá làm V8 chuyển object sang chế độ bảng băm; nay dựng bằng object literal khoá cố định (`makeRowFactory`), kèm đường nhanh cho timestamp/số/đầu số/tên nhà mạng.
  - Cube gửi từ worker sang trang **158 MB → 4 MB** (`slimCubeForTransfer`): `topDest`/`callbackStats` chỉ giữ top 500 + histogram, chuỗi đồng thời rút về đúng 1.800 điểm mà biểu đồ vẫn vẽ. Heap của trang ~600 MB → ~80 MB.
  - Không đổi cấu trúc bảng SQLite sang WITHOUT ROWID: đã đo, đọc 972 nghìn dòng vẫn ~7 s (chi phí nằm ở Python dựng dòng, không ở ổ đĩa).
- Dòng trạng thái DB ghi riêng số dòng của kết nối đang chọn và tổng dòng/dung lượng của cả file. File tạo trước khi bật `auto_vacuum=INCREMENTAL` hiện nút **Thu gọn DB** (`POST /api/db-compact`, VACUUM một lần) để từ đó xoá dữ liệu quá hạn làm file nhỏ lại thật.
- Đồng bộ được tuần tự hoá theo từng kết nối MPT: các yêu cầu trùng đang chờ dùng chung kết quả vừa hoàn tất, không thể ghi đè bộ lọc phiên của nhau. Giao diện khóa cả hai nút trong lúc xử lý và worker chỉ chấp nhận dataset của yêu cầu mới nhất, nên phản hồi cũ đến muộn không thể thay thế báo cáo đang xem.
- **Bộ lọc chính** hiển thị phạm vi dữ liệu đang có. Nếu khoảng lọc nằm ngoài dữ liệu đã nạp, dashboard cảnh báo kèm nút **Xem khoảng này** thay vì im lặng trả về 0.
- Không nạp được danh sách Account không còn chặn cả luồng: chỉ cần chọn kết nối là bấm được **Xem** / **Cập nhật báo cáo** (bỏ trống account = tất cả).
- **Bộ lọc chính** đánh dấu nút *Xem* khi có thay đổi chưa áp dụng; nhấn Enter trong ô lọc tương đương bấm **Xem**.
- Nhãn tách bạch: **Tài khoản cần tải** (lấy từ MPT) và **Tài khoản đang xem** (lọc trên dữ liệu đã tải).
- Dữ liệu lần gần nhất được nhớ trong IndexedDB (tối đa 200.000 dòng). Mở lại app sẽ hiện banner
  *Dữ liệu lần trước… [Dùng lại] [Bỏ qua]* thay vì phải export lại từ MPT.
- Biểu đồ **Phân bổ Hangup Cause theo Gateway** dùng thanh ngang 100% stacked: mỗi Gateway là một dòng, mỗi nguyên nhân là một màu và không gộp các nguyên nhân nhỏ. Chiều cao tăng theo số Gateway để giữ nhãn dễ đọc; bảng bên dưới vẫn hiển thị số lượng tuyệt đối.
- Lưu kết nối trùng domain + tên đăng nhập sẽ hỏi lại trước khi tạo thêm.
- Bỏ nút *Lưu vào HTML* ở phần gán tên Account: mapping đã tự lưu trong trình duyệt, và file HTML tải về
  không nằm trong allowlist nên mở qua server không chạy. Vẫn còn Export/Import JSON.
- **Báo cáo Random Number (RN)** trong tab *Dữ liệu & Tài khoản*. RN = số cuộc xen giữa hai lần dùng lại cùng `(account_id, out_number)`, nên RN thấp nghĩa là đầu số bị quay vòng dày. Hai mức xem: **theo số gọi ra** (số cuộc, min/median/avg/max RN) và **theo account** (p10/p25/median/p75). Ngưỡng RN thấp tự đặt — mặc định 2, khớp KPI *Median Random Number* — kèm ô tìm kiếm, sắp xếp theo cột và Export CSV (có BOM UTF-8 để Excel mở đúng tiếng Việt). Lần đầu một số xuất hiện không có RN nên không tính vào thống kê.
- **Xử lý nặng chạy ngoài giao diện.** Nguồn SQLite đi qua `analytics-worker.js`; nguồn CSV/JSON tải thủ công vẫn đi qua `dashboard-csv-worker.js`. Cả hai dùng chung `dashboard-core.js`, nên chỉ có một bộ công thức cho ~40 phép tổng hợp. Trang chỉ nhận cube gọn rồi vẽ.
- Đồng bộ được ghi theo partition `profile + account + day`: dữ liệu mới được chuẩn hoá trước rồi thay thế phạm vi cũ trong một transaction, tăng `data_revision`, lưu số dòng/hash/trạng thái trong `sync_partitions`; dòng đã biến mất ở MPT không còn bị giữ lại vô thời hạn bởi upsert.
- **Vẽ biểu đồ tăng dần.** Mỗi tab vẽ từng biểu đồ rồi nhả luồng (`renderSteps`/`yieldFrame` — ưu tiên trước paint, fallback `setTimeout` khi cửa sổ ẩn), kèm tiến độ *Đang vẽ biểu đồ X/Y* trên màn chờ. Cửa sổ phản hồi liên tục trong lúc dựng ~20 biểu đồ.
- CSV trên 20 MB tiếp tục dùng parser streaming.
- Plotly nằm trong `vendor/`, nên biểu đồ vẫn hoạt động khi mất Internet.
- Mật khẩu profile được mã hóa bằng keyfile `config/secret.key` (AES-256-GCM) đi kèm thư mục, nên bản portable copy sang máy khác vẫn dùng được. Profile cũ mã hóa bằng Windows DPAPI vẫn đọc được trên đúng máy đã tạo và tự chuyển sang scheme mới ở lần khởi động kế tiếp; sang máy khác thì cần nhập lại mật khẩu.
- Server chỉ phục vụ file giao diện cần thiết; `config/`, `logs/`, backup và mã nguồn bị chặn qua HTTP.

## Kiểm thử

```powershell
python -m unittest discover -s tests -v   # Python: server, đóng gói, cấu trúc HTML/worker/core
node --test tests/core.test.mjs           # Node: đối chiếu số của dashboard-core.js + buildCube
node tests/ui/snap.mjs                    # 7 màn hình × 2 theme × 3 độ rộng, KPI baseline và axe
```

`python -m unittest` cũng tự gọi `node --test` nếu có Node.

Bộ test kiểm tra: profile encryption/migration (keyfile + DPAPI cũ), keyfile portable đi theo thư mục, `app_root()`/`create_server()`, static-file allowlist; `dashboard-core.js` là nguồn duy nhất và không tham chiếu DOM; `buildCube` khớp số trên dữ liệu mẫu (2 định dạng nguồn); giao thức Web Worker + fallback main-thread; render đọc từ cube; tab Cước phí qua worker; vẽ tăng dần có `yieldFrame`.
