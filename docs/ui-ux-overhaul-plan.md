# Kế hoạch cải tổ UI/UX — MPT Call Dashboard

Tài liệu giao việc cho agent lập trình (Codex). Mỗi task là một đơn vị độc lập, có phạm vi, việc cần làm, tiêu chí nghiệm thu và cách kiểm thử. Làm theo thứ tự đợt; trong một đợt có thể làm song song các task không phụ thuộc nhau (xem cột "Phụ thuộc").

Nguồn: đánh giá UI/UX ngày 13/10/2026 (chạy dashboard thật với 8.000 cuộc gọi giả lập, 7 tab, sáng/tối, 1440/1280/1024/390 px, axe-core WCAG 2.1 AA, thử bàn phím). Điểm hiện tại 5,7/10. Mục tiêu sau cải tổ: không còn lỗi axe mức serious/critical, mọi số liệu cùng một định dạng vi-VN, thanh lọc một hàng, mỗi tab có trạng thái rỗng/lỗi/tải rõ ràng.

---

## 0. Quy tắc chung cho mọi task (đọc trước khi làm)

1. **Bảo toàn công việc đang dở.** Workspace hiện có thay đổi chưa commit ở `V2_0_Call_Dashboard_MPT.html`, `dashboard-core.js`, `scripts/mpt_dashboard_app.py`, `tests/core.test.mjs`. Không `checkout`/`reset`/`stash` chúng. Task UX-00 sẽ xử lý việc này trước.
2. **Một task = một nhánh/commit riêng**, tên commit `ux(UX-xx): …`. Không gộp nhiều task vào một commit.
3. **Dùng CodeGraph trước khi tìm/đọc mã** (repo có `.codegraph/`). File HTML chính dài ~12.000 dòng: tìm theo id/hàm, không đọc toàn bộ.
4. **Không đổi logic nghiệp vụ** trong `dashboard-core.js` (classifyCall, normalize, aggregate, buildCube, billing). Chỉ thêm hàm hiển thị/định dạng. Số đếm KPI trước và sau phải giống hệt nhau.
5. **Không gọi MPT thật, không dùng tài khoản thật**, không đưa thông tin kết nối vào commit, log hay ảnh chụp. Kiểm thử bằng bộ dữ liệu giả lập và API giả của UX-00.
6. **Chạy offline.** Không thêm CDN, framework hay bước build. Giữ vanilla JS + Plotly 2.24.2 đã vendor. Font giữ Ubuntu Sans + Noto Sans VN trong `vendor/`.
7. **File tĩnh mới phải được khai báo ở 2 chỗ**, nếu không server sẽ trả 404 và bản portable thiếu file:
   - `scripts/mpt_dashboard_server.py` → hàm `is_allowed_static_path()` (danh sách đường dẫn cho phép).
   - `build/build.ps1` → thêm `Copy-Item` tương ứng (cạnh dòng copy `dashboard-core.js`).
8. **Giữ nguyên các id DOM mà JS đang dùng.** Nếu bắt buộc đổi, đổi mọi tham chiếu (grep `getElementById('…')`, `querySelector`, `mptEl('…')`) trong cùng commit.
9. **Escape mọi dữ liệu đưa vào HTML** (tên account, gateway, số điện thoại). Ưu tiên `textContent`.
10. **Mỗi task kết thúc bằng:**
    - `node --test tests/core.test.mjs` đạt toàn bộ.
    - `python -m pytest tests/test_dashboard.py -q -k "not ProfileStoreTests and not PortableSecretTests and not LlmConfigStoreTests"` đạt (nhóm bị loại có lỗi môi trường `WinError 5` từ trước, không liên quan).
    - Chạy `node tests/ui/snap.mjs` (từ UX-00) và xem ảnh của các tab bị ảnh hưởng ở cả sáng và tối.
    - Ghi vào cuối mô tả commit: đã kiểm gì, chưa kiểm được gì.
11. **Ngôn ngữ giao diện:** tiếng Việt có dấu, theo bảng thuật ngữ ở mục 3. Mã nguồn/comment giữ phong cách hiện có.

---

## 1. Các quyết định đã chốt

| Chủ đề | Quyết định |
|---|---|
| Phong cách | Giữ tinh thần Ubuntu/Yaru (headerbar, sidebar, dialog Adwaita) nhưng thay toàn bộ token màu/chữ theo mục 2. |
| Màu nhấn | `#E95420` chỉ dùng cho logo và mảng lớn trang trí. Nút, chữ nhấn, mục đang chọn dùng `#C2410C` (5,18:1 trên trắng). |
| Kiến trúc file | Tách CSS ra `dashboard.css`, phần định dạng ra `dashboard-core.js` (namespace `UIFormat`). Không tách JS giao diện trong đợt này (rủi ro cao), chỉ dọn trong file. |
| Hành động dữ liệu | Một nút chính **Cập nhật** (đồng bộ ngày thiếu từ MPT, ngày đủ đọc DB). "Chỉ xem dữ liệu đã lưu" và "Tải lại toàn bộ từ MPT" vào menu phụ. |
| Kết nối MPT | Quản lý (thêm/sửa/xoá/kiểm tra) chỉ ở **Cài đặt › Kết nối MPT**. Thanh lọc chỉ có ô chọn kết nối. Bỏ hộp thoại "Nguồn dữ liệu MPT" và nút cùng tên ở header. |
| Màu KPI | Số KPI màu trung tính. Chỉ tô màu khi vượt ngưỡng, luôn kèm ký hiệu ▲/▼/⚠ (không chỉ dựa vào màu). |
| Giao diện hẹp | Đối tượng chính là cửa sổ app 1024–1920 px. Dưới 900 px chỉ cần dùng được (không vỡ, không cuộn ngang), không cần tối ưu. |

---

## 2. Đặc tả hệ thống thiết kế (dùng cho UX-03 và mọi task sau)

### 2.1 Token màu

Đặt trên `body.adw` (sáng) và `body.adw.dark` (tối). Giữ các alias cũ (`--accent`, `--text`, `--dim`, `--border`, `--success`…) trỏ sang token mới để mã cũ không vỡ.

| Token | Sáng | Tối | Dùng cho |
|---|---|---|---|
| `--bg` | `#FAF9F7` | `#1A1A1A` | nền cửa sổ |
| `--surface` | `#FFFFFF` | `#262626` | thẻ, header, dialog |
| `--surface-2` | `#F3F1EC` | `#2F2F2F` | sidebar, vùng phụ, hover |
| `--border` | `#E4E1DA` | `rgba(255,255,255,.12)` | viền |
| `--text` | `#1C1B19` | `#F2F1EE` | chữ chính |
| `--text-2` | `#4A4843` | `#C9C6BF` | chữ phụ, nhãn |
| `--text-3` | `#6B6862` | `#A19E97` | chú thích (≥ 4,9:1 trên mọi nền) |
| `--accent` | `#C2410C` | `#C2410C` | nền nút chính, mục chọn (chữ trắng) |
| `--accent-hover` | `#9A3412` | `#9A3412` | hover nút chính |
| `--accent-text` | `#C2410C` | `#FDBA74` | chữ/link màu nhấn |
| `--accent-soft` | `#FDF1ED` | `#3A2418` | nền chip/nút phụ nhấn |
| `--on-accent-soft` | `#9A3412` | `#FDBA74` | chữ trên `--accent-soft` |
| `--brand` | `#E95420` | `#E95420` | chỉ logo |
| `--focus` | `#C2410C` | `#FDBA74` | viền focus 2 px, offset 2 px |

Màu trạng thái cuộc gọi (dùng chung cho chip, thanh phân bố, biểu đồ):

| Trạng thái | Nhãn | Màu đồ hoạ (sáng / tối) | Chip: nền / chữ (sáng) | Chip: nền / chữ (tối) |
|---|---|---|---|---|
| Connected | Kết nối | `#2E7D32` / `#4ADE80` | `#E7F4EA` / `#1B5E20` | `#12301A` / `#86EFAC` |
| No Answer | Không nghe | `#D97706` / `#FBBF24` | `#FEF3E2` / `#B45309` | `#3A2508` / `#FCD34D` |
| Cancelled | Hủy | `#8A877F` / `#A8A29E` | `#EEECE6` / `#4A4843` | `#3A3A3A` / `#D4D2CC` |
| Fail | Lỗi | `#B42318` / `#F87171` | `#FEE4E2` / `#B42318` | `#3B1D1A` / `#FCA5A5` |

Tên token: `--st-connected`, `--st-connected-bg`, `--st-connected-fg`, tương tự `noanswer`, `cancelled`, `fail`. Ngưỡng cảnh báo: `--sev-ok` (= connected), `--sev-warn` (= noanswer), `--sev-bad` (= fail).

Tất cả cặp chữ/nền ở trên đã kiểm ≥ 4,5:1.

### 2.2 Chữ, khoảng cách, bo góc

- Thang cỡ chữ duy nhất: `--fs-xs 12px`, `--fs-sm 13px`, `--fs-md 14px` (mặc định), `--fs-lg 16px`, `--fs-xl 20px`, `--fs-2xl 28px`. Không dùng 10, 10.5, 11, 11.5, 12.5, 13.5 px nữa. Không chữ nào dưới 12 px.
- Đậm: 400 / 600 / 700.
- Số liệu KPI: `font-variant-numeric: tabular-nums`.
- Khoảng cách: `--sp-1 4px` … `--sp-2 8px`, `--sp-3 12px`, `--sp-4 16px`, `--sp-5 20px`, `--sp-6 24px`, `--sp-8 32px`.
- Bo góc: `--r-sm 6px`, `--r-md 8px`, `--r-lg 12px`, chip `999px`.
- Vùng bấm tối thiểu 32 px chiều cao trên desktop (nút trong thanh lọc 36 px).
- `:root { color-scheme: light; } body.adw.dark { color-scheme: dark; }` để icon ngày/giờ và thanh cuộn theo theme.

### 2.3 Thành phần dùng chung (class CSS)

| Class | Mô tả |
|---|---|
| `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-icon` | Nút. `btn-icon` luôn có `aria-label`. |
| `.chip`, `.chip-status[data-status]`, `.chip-filter` (có nút × bên trong) | Chip. |
| `.card`, `.card-header`, `.card-body`, `.card-footer` | Thẻ báo cáo. |
| `.kpi`, `.kpi-primary`, `.kpi-secondary`, `.kpi-value`, `.kpi-label`, `.kpi-delta[data-trend=up|down|flat]`, `.kpi[data-severity=ok|warn|bad]` | KPI. |
| `.info-btn` | Nút "?" giải thích, mở popover (thay `<span>ⓘ</span>` + `title`). |
| `.popover` | Lớp nổi gắn với nút, đóng bằng Esc / bấm ngoài, trả focus. |
| `.empty-state` (icon, tiêu đề, mô tả, hành động) | Trạng thái rỗng. Biến thể `.empty-state--group` cho cả nhóm báo cáo. |
| `.skeleton` | Khung chờ khi lọc lại. |
| `.field`, `.field-label`, `.field-hint`, `.field-error` | Ô nhập kèm nhãn. |

Không dùng `style="…"` inline cho màu, cỡ chữ, khoảng cách ở mã mới. Không thêm `!important` mới.

---

## 3. Bảng thuật ngữ giao diện

Áp dụng ở UX-26 và mọi task có viết chữ. Lưu thành hằng số `UI_LABELS` (một nơi duy nhất) để biểu đồ, bảng, chip, tooltip cùng dùng.

| Hiện tại | Dùng | Ghi chú tooltip |
|---|---|---|
| Connected | Kết nối | billsec > 0 |
| NoAnswer / No Answer | Không nghe | |
| Huỷ / Cancelled | Hủy | chuẩn hoá "Hủy" |
| Fail | Lỗi | |
| ASR hợp lệ | ASR hợp lệ (giữ) | thêm giải thích công thức trong popover |
| Tỷ lệ kết nối / tổng lượt gọi | Tỷ lệ kết nối | |
| Kết nối loại Fail | Tỷ lệ kết nối (trừ cuộc lỗi) | |
| Billsec trung bình | Thời lượng tính cước TB | "billsec" để trong tooltip |
| Max Call Fail | Chuỗi lỗi dài nhất | |
| Median Random Number | Trung vị số ngẫu nhiên (RN) | |
| Destination lặp | Số đích lặp | |
| attempts | cuộc gọi | |
| Stacked % | (bỏ khỏi tiêu đề) | |
| Account summary | Tổng hợp theo tài khoản | |
| Xem từ DB | Chỉ xem dữ liệu đã lưu (menu phụ) | |
| Đồng bộ MPT | Cập nhật (nút chính) | |
| Auto loaded N records / M account(s)… | Đã tải 8.000 cuộc gọi của 6 tài khoản | toast |
| Không có dữ liệu | theo mẫu trạng thái rỗng ở UX-24 | |

Tên hangup cause (NORMAL_CLEARING…) giữ nguyên vì là mã hệ thống, nhưng thêm mô tả tiếng Việt trong tooltip/bảng nếu có sẵn.

---

## 4. Tổng quan các đợt

| Đợt | Mục tiêu | Task | Ước lượng |
|---|---|---|---|
| 0 · Nền móng | Chuẩn bị an toàn + công cụ kiểm thử giao diện + hệ token/định dạng | UX-00 → UX-04 | 3–4 ngày |
| 1 · Sửa lỗi nhanh | Sửa lỗi người dùng đang gặp, rủi ro thấp | UX-10 → UX-14 | 2–3 ngày |
| 2 · Luồng chính | Thanh lọc, hành động dữ liệu, KPI, trạng thái rỗng, Cước phí, ngôn từ | UX-20 → UX-26 | 6–8 ngày |
| 3 · Hệ thống & hoàn thiện | Dọn CSS, responsive, skeleton, Cài đặt, rà biểu đồ, QA cuối | UX-30 → UX-35 | 5–7 ngày |

| Task | Tên | Phụ thuộc |
|---|---|---|
| UX-00 | Baseline, nhánh, harness chụp ảnh | — |
| UX-01 | Bảng thuật ngữ `UI_LABELS` | UX-00 |
| UX-02 | Bộ định dạng số/thời gian `UIFormat` | UX-00 |
| UX-03 | Token + tách `dashboard.css` | UX-00 |
| UX-04 | Theme Plotly dùng chung | UX-02, UX-03 |
| UX-10 | Lỗi bị dòng tiến độ ghi đè | UX-00 |
| UX-11 | Biểu đồ: legend đè, nhãn cắt | UX-04 |
| UX-12 | Tương phản + focus + nút giải thích | UX-03 |
| UX-13 | Chế độ tối | UX-03 |
| UX-14 | Trợ lý AI dạng side sheet | UX-03 |
| UX-20 | Thanh lọc một hàng + chip | UX-03, UX-12 |
| UX-21 | Mô hình nút Cập nhật + độ mới dữ liệu | UX-20 |
| UX-22 | Gom quản lý kết nối về Cài đặt | UX-21, UX-33 (có thể làm trước phần khung) |
| UX-23 | KPI Tổng quan mới | UX-02, UX-03 |
| UX-24 | Trạng thái rỗng cấp nhóm | UX-03 |
| UX-25 | Tab Cước phí | UX-02, UX-20 |
| UX-26 | Rà ngôn từ toàn app | UX-01 |
| UX-30 | Dọn CSS cũ, style inline, `!important` | UX-03 → UX-26 |
| UX-31 | Responsive 900–1440 px | UX-20, UX-30 |
| UX-32 | Skeleton thay màn chờ khi lọc lại | UX-21 |
| UX-33 | Tổ chức lại tab Cài đặt | UX-03 |
| UX-34 | Rà danh mục báo cáo mặc định | UX-24 |
| UX-35 | QA cuối + README | tất cả |

---

## 5. Đợt 0 — Nền móng

### UX-00 · Baseline, nhánh làm việc và harness chụp ảnh

**Mục tiêu:** có điểm xuất phát an toàn và công cụ chụp ảnh lặp lại được để so trước/sau.

**Việc cần làm**
1. Hỏi chủ dự án trước khi commit các thay đổi đang dở (xem Quy tắc 1). Nếu được đồng ý: commit chúng nguyên trạng với message `wip: trạng thái trước cải tổ UI/UX`. Nếu không: làm trên `git worktree` riêng (có sẵn `scripts/run-worktree.py`).
2. Tạo nhánh `ux/overhaul`.
3. Tạo `tests/ui/` gồm:
   - `make-sample.mjs`: sinh `tests/ui/fixtures/sample.csv`, 8.000 dòng, 6 tài khoản (101–106), 12 ngày (01–12/10/2026), giờ 07–20, các cột `uuid, account_id, account_name, caller_id_number, destination_number, start_stamp, answer_stamp, end_stamp, duration, billsec, hangup_cause, direction, telco, call_type`. Hangup cause trộn NORMAL_CLEARING (55%), ORIGINATOR_CANCEL, NO_ANSWER, USER_BUSY, UNALLOCATED_NUMBER, CALL_REJECTED, NO_USER_RESPONSE. `direction` dùng giá trị `Outbound`/`Inbound`. Seed cố định để ảnh ổn định. Số điện thoại là số giả.
   - `mock-server.mjs`: server tĩnh cổng 8787 phục vụ thư mục gốc repo + API giả: `GET /api/profiles` → `{"profiles":[{"id":"p1","name":"Billing 01","domain":"https://demo.invalid","username":"demo"}]}`; `GET|POST /api/accounts` → mảng `[{id,name}]` 6 tài khoản; các `/api/*` khác → `{}`; `/` → `V2_0_Call_Dashboard_MPT.html`.
   - `snap.mjs` (Playwright, Chromium có sẵn): mở `/?csv=/tests/ui/fixtures/sample.csv`, chờ màn chờ đóng, lần lượt bấm từng mục sidebar, chụp viewport và full page cho `light` và `dark` (`colorScheme`) ở 1440×900, thêm 1024×768 cho tab Tổng quan. Lưu vào `tests/ui/out/<tên-ảnh>.png`. Đồng thời chạy axe-core (`wcag2a`, `wcag2aa`) trên tab Tổng quan, in số vi phạm theo mức độ.
   - Thêm `tests/ui/out/` vào `.gitignore`.
4. Chạy một lần, lưu ảnh baseline vào `tests/ui/baseline/` (commit ảnh baseline để so sánh).

**Nghiệm thu:** `node tests/ui/snap.mjs` chạy xong trong < 3 phút, tạo đủ 14 ảnh (7 tab × 2 theme) + 1 ảnh 1024, in kết quả axe. Hiện tại phải thấy 4 lỗi `color-contrast` mức serious.

---

### UX-01 · Bảng thuật ngữ `UI_LABELS`

**Mục tiêu:** một nguồn duy nhất cho nhãn hiển thị.

**Việc cần làm**
1. Trong `dashboard-core.js` thêm và export `UI_LABELS` (object đóng băng) gồm: tên trạng thái (`connected`, `noAnswer`, `cancelled`, `fail`), tên KPI, tên nhóm báo cáo, nhãn hành động dữ liệu, mẫu toast. Dùng bảng ở mục 3.
2. Thêm `statusLabel(connType)` ánh xạ giá trị `classifyCall()` (`Connected`, `No Answer`, `Cancelled`, `Fail`, `Unknown`) → nhãn Việt. **Không đổi giá trị trả về của `classifyCall()`** (logic, cube, test phụ thuộc vào chúng).
3. Test trong `tests/core.test.mjs`: mọi giá trị `classifyCall` đều có nhãn; không nhãn nào rỗng.

**Không làm:** chưa thay chữ trong giao diện (để UX-26).

---

### UX-02 · Bộ định dạng `UIFormat`

**Mục tiêu:** mọi con số hiển thị cùng một quy cách vi-VN.

**Hiện trạng:** HTML có ~135 lời gọi `toFixed`, ~92 `toLocaleString('vi-VN')`, các hàm rời `fmtVND`, `fmtInt`, `fmtCompact` (~dòng 5634–5680), `formatVnDate`, `formatVnDateTime`. Kết quả: "8000", "12423.87 phút", "200.6s" ở Tổng quan nhưng "12.424,07", "745.432 s" ở Cước phí.

**Việc cần làm**
1. Trong `dashboard-core.js` thêm `UIFormat` dùng `Intl.NumberFormat('vi-VN')` tạo sẵn (không tạo mới mỗi lần gọi):
   - `int(n)` → `8.000`
   - `dec(n, digits=1)` → `200,6`
   - `pct(ratio0to1 hoặc số %, digits=1)` → `46,5%` (quy định rõ tham số nhận phần trăm hay tỷ lệ; đặt tên `pctFromRatio` và `pct` để tránh nhầm)
   - `pp(delta)` → `+1,2 điểm` / `−0,8 điểm` (dấu trừ U+2212)
   - `seconds(s)` → `< 60`: `45 giây`; `< 3600`: `3 phút 20 giây`; còn lại `2 giờ 05 phút`
   - `minutes(m)` → `12.424 phút`; nếu ≥ 600 thêm ` (≈ 207 giờ)` ở biến thể `minutesLong`
   - `vnd(n)` → `1.250.000 đ`; `null/undefined` → `—`
   - `compact(n)` → `12,4 N`, `1,2 Tr` (nghìn/triệu) cho nhãn trục
   - `date(iso)` → `01/10/2026`; `dateShort` → `01/10`; `dateTime` → `01/10/2026 13:05`
   - Giá trị không hợp lệ (`NaN`, `null`) → `—` ở mọi hàm.
2. Thay toàn bộ chỗ hiển thị trong HTML: KPI, chip, toast, tiêu đề phạm vi, bảng, nhãn dữ liệu biểu đồ, hovertemplate. Giữ `toFixed` chỉ ở chỗ tính toán (không hiển thị). Giữ `fmtVND`/`fmtInt` như alias gọi sang `UIFormat` để giảm diff.
3. Plotly: đặt `separators: ',.'` trong layout chung (UX-04) để trục và hover dùng dấu phẩy thập phân, dấu chấm nghìn.
4. Test đơn vị cho từng hàm (gồm số âm, 0, NaN, số rất lớn).

**Nghiệm thu:** grep `toFixed(` chỉ còn ở ngữ cảnh tính toán (liệt kê trong mô tả commit). Ảnh Tổng quan hiện `8.000`, `12.424 phút`, `200,6 giây`. Số đếm không đổi so với baseline.

---

### UX-03 · Token thiết kế và tách `dashboard.css`

**Mục tiêu:** một bộ token sáng/tối theo mục 2, CSS nằm ngoài file HTML.

**Hiện trạng:** HTML có 2 khối CSS: khối cũ ~dòng 96–480 và khối `<style id="yaruLayer">` ~dòng 521–1097 (token `--u-orange`, `--accent`… trên `body.adw`, tối trên `body.adw.dark`), cộng một khối nhỏ ~dòng 10271. Có 37 `!important`, 558 `style=""`, 175 mã màu, 17 cỡ chữ.

**Việc cần làm**
1. Tạo `dashboard.css`. Chuyển nguyên văn các khối `<style>` sang (giữ thứ tự để không đổi cascade), thay bằng `<link rel="stylesheet" href="/dashboard.css">` ở cùng vị trí. Khai báo file ở `is_allowed_static_path()` và `build/build.ps1` (Quy tắc 7). Đường dẫn font `vendor/...` trong `@font-face` phải còn đúng.
2. Đầu file thêm khối token mục 2.1–2.2. Ánh xạ alias cũ: `--accent:var(--accent)`… cụ thể `--window-bg→--bg`, `--card-bg/--view-bg/--headerbar-bg→--surface`, `--sidebar-bg→--surface-2`, `--text`, `--dim→--text-2`, `--success→--st-connected`, `--warning→--st-noanswer`, `--error→--st-fail`, `--u-orange→--brand`.
3. Đổi mọi chỗ dùng `--accent`/`--u-orange` làm nền nút hoặc chữ sang `--accent` mới (`#C2410C`) hoặc `--accent-text`. Logo giữ `--brand`.
4. Thêm `color-scheme` (mục 2.2), `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }` cho `button, a, input, select, summary, [tabindex]`.
5. Định nghĩa các class thành phần ở mục 2.3 (chưa cần áp dụng hết — các task sau dùng).
6. Đổi cỡ chữ < 12 px lên 12 px; quy các cỡ lẻ về thang gần nhất.

**Không làm:** chưa xoá CSS chết (để UX-30).

**Nghiệm thu:** ảnh chụp mọi tab khác baseline chỉ ở màu nhấn và cỡ chữ nhỏ; không vỡ bố cục. axe: 0 lỗi `color-contrast` trên tab Tổng quan. Bản portable build được (`build/build.ps1`) và mở được giao diện có CSS.

---

### UX-04 · Theme Plotly dùng chung

**Mục tiêu:** mọi biểu đồ cùng nền, chữ, bảng màu, legend, định dạng số.

**Hiện trạng:** `adwPlotTheme()` (~dòng 3357) đã có nền/phông; gauge dùng xanh dương, heatmap dùng thang xanh riêng, bar màu `#4472a8`-ish, legend vị trí khác nhau, có biểu đồ tiêu đề trục đè legend.

**Việc cần làm**
1. Mở rộng `adwPlotTheme()` trả về layout gốc gồm: `separators: ',.'`, `font` theo token, `colorway` (bảng phân loại 8 màu, phân biệt được cả độ sáng: dùng thứ tự `#C2410C, #1D4ED8, #0F766E, #A16207, #7E22CE, #BE185D, #4D7C0F, #57534E` cho sáng; biến thể sáng hơn cho tối), `legend: {orientation:'h', x:0, y:1.02, yanchor:'bottom'}`, `margin` tự tính (`automargin:true` cho trục), `hoverlabel` theo token, `title.x:0` cỡ 16 px.
2. Thêm `plotColors.status` lấy từ token trạng thái (đọc `getComputedStyle` một lần mỗi khi đổi theme). Mọi biểu đồ có Connected/No Answer/Cancelled/Fail phải dùng bộ này và thứ tự cố định: Kết nối, Không nghe, Hủy, Lỗi.
3. Thang tuần tự duy nhất cho heatmap: từ `--surface-2` → `--accent` (sáng), biến thể tối tương ứng. Thang phân kỳ (nếu cần) dùng xanh dương–cam.
4. Helper `plotLayout(overrides)` merge sâu theme + override; thay các `Plotly.newPlot/react` hiện có để dùng helper (tìm theo `Plotly.` trong file).
5. Khi đổi sáng/tối: `Plotly.relayout` toàn bộ biểu đồ đang hiển thị với theme mới (kiểm tra cơ chế hiện có rồi dùng lại).

**Nghiệm thu:** không biểu đồ nào còn khai báo màu cứng ngoài theme (grep mã hex trong các hàm `plot*`). Ảnh: legend các biểu đồ nằm trên cùng bên trái, không đè trục.

---

## 6. Đợt 1 — Sửa lỗi nhanh

### UX-10 · Thông báo lỗi bị dòng tiến độ ghi đè

**Hiện trạng:** `renderSteps()` (~dòng 5525) ghi `Đang vẽ biểu đồ n/total…` vào màn chờ bất cứ khi nào overlay có class `show`, kể cả khi `setReportLoading(true, message, true)` đã chuyển sang trạng thái lỗi. Kết quả: nút Đóng/Thử lại hiện cạnh chữ "Đang vẽ biểu đồ 4/4…", lý do lỗi bị mất. Tái hiện: API `/api/accounts` trả dữ liệu không phải mảng.

**Việc cần làm**
1. Trong `renderSteps()`, chỉ cập nhật tiến độ khi `!reportLoadingFailed()`; kiểm tra lại ở mỗi vòng lặp (không chỉ lúc bắt đầu).
2. Màn chờ trạng thái lỗi: tiêu đề "Không tải được báo cáo", dòng lý do riêng (`#reportLoadingError`), nút "Chi tiết" mở phần stack/mã lỗi rút gọn, nút Thử lại là nút chính.
3. `mptAccounts` nhận dữ liệu sai dạng: chuẩn hoá về mảng rỗng + toast cảnh báo, không làm hỏng luồng tải báo cáo.

**Nghiệm thu:** mock trả `/api/accounts` = `{}` → báo cáo vẫn tải, có toast cảnh báo, không còn màn chờ kẹt. Mock trả 500 cho file CSV → màn chờ hiện đúng lý do, không bị ghi đè.

---

### UX-11 · Biểu đồ: legend bị đè, nhãn bị cắt

**Việc cần làm** (sau UX-04, nhiều lỗi tự hết; kiểm lại từng cái):
1. `plotTelcoConnStacked` (~dòng 4307): tiêu đề trục X "Telco" đè legend → legend lên trên (theme), đổi tiêu đề trục thành "Nhà mạng".
2. `plotMinutesByAccount` (~dòng 4600): nhãn cột dài nhất bị cắt ("45:") → `cliponaxis:false`, `textposition:'outside'`, mở rộng `xaxis.range` thêm 15% hoặc `automargin`. Nhãn dùng `UIFormat.minutes`.
3. Biểu đồ "Kết nối & ASR của 10 Account" (tab Dữ liệu & Tài khoản): tiêu đề trục "ASR(%)" đè tiêu đề biểu đồ, marker kim cương đè nhãn % → tách thành 2 cột song song (Tỷ lệ kết nối, ASR) hoặc dùng dot plot 2 marker trên cùng hàng, nhãn đặt ngoài vùng vẽ. Đổi "attempts" → "cuộc gọi".
4. "Tỷ lệ kết nối theo đầu số": nhãn 4,9% đỏ trên nền đỏ không đọc được → ẩn nhãn đoạn < 6%, giữ trong hover.
5. Gauge `plotAnswerGauge` (~dòng 3886): màu theo ngưỡng (đỏ < ngưỡng cảnh báo, vàng gần ngưỡng, xanh đạt), vạch mục tiêu từ `alertThreshold`.
6. `plotHangupHeatmap` (~dòng 2500): thêm lựa chọn "Số cuộc / % theo hàng", mặc định % theo hàng; dùng thang tuần tự chung.
7. "Khung giờ vàng": trục giờ chỉ hiện khoảng có dữ liệu (đang để trống 0–7 giờ).
8. "Tổng phút gọi theo ngày": nhãn số dọc trong cột khó đọc → bỏ nhãn trong cột, giữ hover; trục ngày dạng `01/10`.

**Nghiệm thu:** ảnh full page các tab Tổng quan, Chất lượng, Vận hành, Dữ liệu không còn chữ đè chữ hay nhãn bị cắt ở 1440 và 1024 px.

---

### UX-12 · Tương phản, focus và nút giải thích

**Hiện trạng:** axe báo 4 lỗi `color-contrast` serious (`#applyFilter` 3,65:1; `#updateReport` 3,30:1; mục sidebar đang chọn 3,65:1; dòng trạng thái 11 px). Các `<span>ⓘ</span>` nhận focus nhưng `outline:none`, nội dung chỉ nằm trong `title`.

**Việc cần làm**
1. Sau UX-03, chạy lại axe; sửa phần còn lại.
2. Thay mọi icon ⓘ bằng `<button type="button" class="info-btn" aria-label="Giải thích: <tên KPI>" aria-expanded="false" aria-controls="…">?</button>` mở `.popover` chứa nội dung `title` cũ (giữ nguyên văn, sửa chính tả). Popover: Esc đóng, bấm ngoài đóng, trả focus về nút.
3. Bỏ `title` trùng lặp trên các phần tử đã có nhãn hiển thị.
4. Thứ tự Tab hợp lý: header → thanh lọc → sidebar → nội dung. Thêm link "Bỏ qua đến nội dung" (ẩn tới khi focus).
5. Sidebar: `aria-current="page"` cho mục đang chọn (hiện đang `role="tab"` trong sidebar — chọn một mô hình: dùng `nav` + link/nút với `aria-current`, bỏ `role=tab` nếu không có `tablist` đúng chuẩn).
6. Mọi nút chỉ có icon (☰, ×, kéo thả ⠿) có `aria-label`.

**Nghiệm thu:** axe 0 vi phạm serious/critical trên 7 tab (cả sáng và tối). Tab qua 20 phần tử đầu tiên đều thấy viền focus.

---

### UX-13 · Chế độ tối

**Hiện trạng:** chip trạng thái giữ nền pastel sáng; icon lịch/đồng hồ của input ngày giờ gần như vô hình; một số khung dùng màu cứng.

**Việc cần làm**
1. Chip trạng thái và mọi màu trạng thái dùng token mục 2.1 (có biến thể tối).
2. `color-scheme: dark` trên `body.adw.dark` (UX-03) — kiểm icon input.
3. Grep màu cứng trong CSS/inline (`#fff`, `#ffffff`, `white`, `#f…`) ở các thành phần hiện trong tab Cước phí, Vòng đời CID, dialog, bảng; thay bằng token.
4. Kiểm cả tooltip Plotly, popover, toast, banner khôi phục, màn chờ, trợ lý AI.

**Nghiệm thu:** ảnh tối 7 tab không còn khối nền sáng; axe tối 0 lỗi tương phản.

---

### UX-14 · Trợ lý AI dạng side sheet

**Hiện trạng:** `#askDashboardPanel` nổi đè lên thanh lọc và KPI; Esc không đóng; bong bóng `#askDashboardToggle` che legend/colorbar cột phải; sau khi đổi kích thước cửa sổ bong bóng có lúc nhảy lên góc trên trái đè logo.

**Việc cần làm**
1. Panel thành side sheet bên phải rộng 420 px (min 360, max 40vw), cao từ dưới header tới đáy, **đẩy** vùng nội dung (`.adw-body` thêm padding-right khi mở) thay vì đè. Dưới 1100 px thì đè kèm lớp mờ.
2. Esc đóng panel và trả focus về nút mở; focus vào ô nhập khi mở.
3. Vị trí kéo của bong bóng: lưu theo tỷ lệ khung nhìn, clamp lại khi `resize`; không bao giờ đè header (top ≥ chiều cao header + 8 px).
4. Thêm `padding-bottom` cho vùng nội dung để bong bóng không che biểu đồ cuối.
5. Có thể thêm phím tắt mở (`Ctrl+/`) — chỉ khi không đang gõ trong ô nhập.

**Nghiệm thu:** mở panel ở 1440 px vẫn thấy và bấm được nút Cập nhật; Esc đóng; resize 1440 → 900 → 1440 bong bóng vẫn ở góc dưới phải.

---

## 7. Đợt 2 — Luồng chính

### UX-20 · Thanh lọc một hàng và chip bộ lọc đang áp dụng

**Hiện trạng:** `.adw-filterbar` có 13 điều khiển trên 3 hàng (~240 px, 27% màn 900 px), dính trên mọi tab kể cả Cài đặt. Dòng trạng thái 11 px. Không có tóm tắt bộ lọc đang áp dụng.

**Thiết kế mới** (chiều cao mục tiêu ≤ 112 px gồm cả hàng chip; khi không có chip phụ: 60 px):

```
[Kết nối ▾ Billing 01] [📅 01/10 – 12/10/2026 · cả ngày ▾] [Tài khoản: Tất cả (6) ▾] [+ Bộ lọc khác (2)]
Đang áp dụng: (Hướng: Gọi ra ×) (Nhà mạng: Viettel ×)  Xoá tất cả
```

**Việc cần làm**
1. Hàng 1:
   - Ô chọn kết nối (`#mainMptProfile`, giữ id).
   - Nút khoảng thời gian mở popover gồm: preset (Hôm nay, Hôm qua, 7 ngày qua, Tháng này, Tháng trước), hai ô ngày, hai ô giờ (giữ id `startDate`, `startTime`, `endDate`, `endTime`), nút Áp dụng. Nhãn nút hiển thị khoảng đã áp dụng bằng `UIFormat`.
   - Nút tài khoản: dùng lại dropdown hiện có (`#accountDropdown`), nhãn "Tài khoản: Tất cả (6)" hoặc "Tài khoản: 3 đã chọn".
   - Nút "Bộ lọc khác (n)" mở popover chứa: Hướng gọi, Nhà mạng, Nguyên nhân kết thúc, Loại gọi, Số gọi, Số nhận (giữ id `mainDirection`, `mainTelco`, `mainHangup`, `mainCallType`, `mainCaller`, `mainDestination`), nút Áp dụng / Đặt lại. `n` = số điều kiện khác mặc định.
2. Hàng 2 (chỉ hiện khi có điều kiện khác mặc định ngoài khoảng thời gian và kết nối): chip `.chip-filter` cho từng điều kiện, nút × bỏ điều kiện đó và áp dụng ngay; "Xoá tất cả".
3. Hành động Cập nhật chuyển lên header (UX-21). Trong thanh lọc không còn nút "Xem từ DB"/"Đồng bộ MPT".
4. Thay đổi trong popover chưa áp dụng thì nút Áp dụng có chấm báo; Enter trong ô nhập = Áp dụng (giữ hành vi hiện có).
5. Thông tin `#mainFilterScope`, `#databaseStatus`, `#rowCapNotice`: chuyển vào header (độ mới dữ liệu) hoặc vào banner cảnh báo khi thực sự cần (ví dụ khoảng lọc nằm ngoài dữ liệu đã nạp — giữ nút "Xem khoảng này"). Không còn dòng chữ 11 px thường trực.
6. Ẩn thanh lọc ở tab Cài đặt. Ở tab Cước phí xem UX-25.
7. Giữ nguyên cơ chế ghi nhớ bộ lọc gần nhất và `adwSyncChromeHeight()` (tính lại chiều cao sticky).

**Nghiệm thu:** ở 1440 px thanh lọc 1 hàng; ở 1024 px tối đa 2 hàng; mọi id cũ còn hoạt động (bộ lọc áp dụng ra cùng số liệu như baseline với cùng điều kiện). Popover đóng bằng Esc, focus trả về nút. Chip × bỏ điều kiện đúng.

---

### UX-21 · Mô hình hành động dữ liệu: một nút Cập nhật + độ mới dữ liệu

**Hiện trạng:** hai nút ngang hàng "Xem từ DB" (`#applyFilter`, chỉ đọc DB) và "Đồng bộ MPT" (`#updateReport`, tải ngày thiếu/chưa trọn). Người dùng phải hiểu cơ chế cache. Header có nút "Nguồn dữ liệu MPT".

**Việc cần làm**
1. Header phải: dòng độ mới dữ liệu + nút chính **Cập nhật** + nút menu ☰.
   - Dòng độ mới lấy từ `lastReportMeta` (`lastCall`, `syncedAt`, `missingDays`) và `/api/data-status`: "Dữ liệu đến 20:59 hôm nay · cập nhật 5 phút trước". Có ngày thiếu: "Thiếu 2 ngày · bấm Cập nhật" màu cảnh báo. Chưa có dữ liệu: "Chưa có dữ liệu".
   - **Cập nhật** = hành vi hiện tại của `#updateReport` (sync ngày thiếu). Giữ id `updateReport` trên nút mới.
   - Đổi bộ lọc (Áp dụng trong UX-20) = hành vi hiện tại của `#applyFilter` (chỉ đọc DB, không gọi MPT). Giữ hàm xử lý, không cần nút riêng; giữ phần tử `#applyFilter` ẩn hoặc chuyển id sang nút Áp dụng của popover để mã cũ còn chạy.
2. Menu ☰ thêm: "Chỉ xem dữ liệu đã lưu", "Tải lại toàn bộ từ MPT" (gọi API với `sync=force`, có hộp xác nhận nêu rõ sẽ tải lại toàn bộ khoảng ngày và mất thời gian), giữ các mục cũ (Cài đặt, Xuất PNG, Xuất PDF).
3. Trong lúc đang tải: nút Cập nhật thành "Đang cập nhật… 7/40" + nút Hủy nhỏ cạnh; khóa như `setReportActionsBusy()` hiện tại.
4. Toast hoàn tất theo mẫu: "Đã tải 8.000 cuộc gọi của 6 tài khoản". Thông tin cache HIT và dòng giới hạn chi tiết chuyển vào "Chi tiết" trong popover độ mới dữ liệu.

**Nghiệm thu:** từ lúc mở app tới khi có báo cáo chỉ cần chọn kết nối + bấm Cập nhật. Các luồng cũ (F5 chỉ đọc DB, bookmark `?csv=`, nhiều tài khoản có tiến độ, hủy, thử lại) vẫn chạy.

---

### UX-22 · Gom quản lý kết nối MPT về Cài đặt

**Hiện trạng:** chọn/quản lý kết nối nằm ở 3 nơi: thanh lọc (`#mainMptProfile`), dialog `#mptSourcePanel` (chọn kết nối, tài khoản cần tải, khoảng ngày, điều kiện nâng cao, thêm/sửa kết nối), tab Cài đặt (`#settingsMptProfile`).

**Việc cần làm**
1. Chuyển nội dung "Thêm hoặc chỉnh sửa kết nối" (`#mptConnectionManager`: domain, tên gợi nhớ, username, password, Tạo mới, Kiểm tra, Lưu, Xóa) vào Cài đặt › Kết nối MPT, dạng danh sách kết nối + form chi tiết. Giữ id các input để các handler `mptEl('…')` còn chạy.
2. "Tài khoản cần tải" và "Làm mới tài khoản": gom vào dropdown tài khoản ở thanh lọc (một danh sách; mục "Làm mới danh sách từ MPT" ở cuối dropdown). Tách bạch tài khoản cần tải và tài khoản đang xem hiện nay khiến người dùng nhầm — hợp nhất: tài khoản đã chọn vừa là phạm vi tải vừa là phạm vi xem.
   - **Cần xác nhận với chủ dự án trước khi làm bước này** vì đổi hành vi (hiện có thể tải nhiều tài khoản rồi lọc xem một phần). Nếu chủ dự án muốn giữ tách biệt: để "Tài khoản cần tải" trong popover của nút Cập nhật.
3. Xoá dialog `#mptSourcePanel` và nút `#openMptSource` sau khi mọi chức năng đã có chỗ mới. Mọi chỗ gọi `adwOpenDialog('mptSourcePanel')` chuyển sang mở Cài đặt › Kết nối (ví dụ khi chưa có kết nối nào).
4. Lần đầu mở app khi chưa có kết nối: trang chào ở vùng nội dung (empty state) với nút "Thêm kết nối MPT" dẫn tới Cài đặt.
5. Nút "Xóa kết nối": dùng `.btn-danger` và hộp xác nhận nêu tên kết nối.

**Nghiệm thu:** chỉ còn 1 nơi sửa kết nối, 1 ô chọn kết nối ở thanh lọc (+ danh sách trong Cài đặt). Test pytest về profile vẫn đạt. Luồng người mới: mở app → thêm kết nối → kiểm tra → lưu → quay lại báo cáo → Cập nhật, không cần mở dialog nào khác.

---

### UX-23 · KPI Tổng quan mới

**Hiện trạng:** 3 nhóm KPI (`.kpi-group`, ~dòng 1539–1565) cùng trọng lượng; nhóm Năng lực/vận hành để trống 1 ô; màu `tone-green`/`tone-red`/`tone-orange` gắn cứng theo chỉ số (0% vẫn đỏ); thanh phân bố trạng thái chỉ rộng ~220 px; ô nhập ngưỡng cảnh báo `#alertThreshold` nằm lẫn trong KPI.

**Thiết kế mới**
1. **Hàng KPI chính** (4 thẻ, `.kpi-primary`): Tổng cuộc · Tỷ lệ kết nối · ASR hợp lệ · Tổng phút gọi. Giá trị 28 px, nhãn 13 px, nút "?" giải thích. Dòng phụ: Tổng phút có "≈ 207 giờ".
2. **Thẻ phân bố trạng thái** kéo hết chiều rộng: thanh ngang 14 px theo 4 màu trạng thái, bên dưới lưới 4 nút (màu, nhãn, số, %). Mỗi nút là trigger drilldown hiện có (giữ handler đang gắn với chip Fail/No Answer/Huỷ/Connected và `kpi_total`).
3. **Hàng KPI phụ** (`.kpi-secondary`, 4 ô gọn 1 dòng nhãn — giá trị): Đồng thời cao nhất · Thời lượng tính cước TB · Chuỗi lỗi dài nhất · Trung vị số ngẫu nhiên (RN) · Số đích lặp · Số đích lỗi · Tỷ lệ kết nối (trừ cuộc lỗi). Xếp lưới tự động, không để ô trống.
4. **Màu theo ngưỡng:** bỏ `tone-*` cố định. Thêm `KPI_THRESHOLDS` (cấu hình trong Cài đặt › Phân tích & ngưỡng, lưu như các tuỳ chọn phân tích hiện có), mỗi ngưỡng gồm `warn`, `bad`, chiều (`higherIsBetter`). Vượt ngưỡng → `data-severity` + ký hiệu ⚠ + câu ngắn trong popover. Trong ngưỡng → màu trung tính.
   - Mặc định: Tỷ lệ kết nối warn < 40%, bad < 30%; Số đích lỗi warn > 2%, bad > 5%; Số đích lặp warn > 10%; Lỗi (Fail) warn > 8%, bad > 15%. **Ghi rõ đây là giá trị mặc định đề xuất, chủ dự án chỉnh lại.**
   - `#alertThreshold` chuyển sang Cài đặt.
5. **So sánh kỳ trước (tuỳ chọn, làm sau cùng trong task):** nếu DB có đủ dữ liệu kỳ liền trước cùng độ dài (kiểm bằng `/api/data-status`, đọc DB, không gọi MPT), hiển thị `.kpi-delta` ▲/▼ theo `UIFormat.pp`/`pct`. Thiếu dữ liệu thì ẩn hẳn, không hiện 0.
6. Áp dụng tương tự cho KPI tab Cước phí (UX-25) và `risk-kpi-grid`.

**Nghiệm thu:** số liệu bằng baseline. Ở 1440 px phần KPI cao ≤ 360 px (hiện ~460 px). Không còn số 0% màu đỏ. Drilldown từ cả 5 trigger vẫn mở đúng danh sách.

---

### UX-24 · Trạng thái rỗng cấp nhóm

**Hiện trạng:** tab Vòng đời CID có 5 khung cao 300–400 px cùng "Chưa tải lịch sử khoá số", mỗi khung có "Bảng số liệu (0 dòng)". Tab Dữ liệu & Tài khoản có 2 khung ~400 px "Chưa có mapping Gateway — vào tab Vòng đời CID để gán routing_id". `showNoData()` (~dòng 3480) chỉ ghi chữ vào giữa khung biểu đồ.

**Việc cần làm**
1. Component `renderEmptyState(container, {icon, title, description, actions:[{label, onClick, variant}]})` dùng class `.empty-state`.
2. Cấp nhóm: khi toàn bộ báo cáo trong một nhóm (`REPORT_LAYOUT`/section) phụ thuộc cùng một nguồn chưa có (lịch sử khoá số, mapping Gateway, đơn giá cước), ẩn các thẻ con và hiện **một** `.empty-state--group`:
   - Vòng đời CID: "Chưa có lịch sử khoá số" · "Tải dữ liệu đã lưu hoặc đồng bộ thêm ngày còn thiếu từ MPT." · [Tải từ cache] [Đồng bộ từ MPT].
   - Sức khỏe Gateway: "Cần gán Gateway cho tài khoản" · "2 báo cáo trong nhóm này sẽ hiện sau khi gán routing_id." · [Gán Gateway] (mở đúng nơi gán — hiện ở Vòng đời CID/Cài đặt › Gateway ↔ Account).
3. Cấp thẻ: `showNoData` chuyển sang khung thấp (min-height 160 px) với câu giải thích theo nguyên nhân: không có cuộc gọi trong phạm vi lọc (kèm nút "Mở rộng khoảng thời gian"), thiếu cột dữ liệu (nêu tên cột), lỗi vẽ (nêu lỗi + "Thử lại").
4. Ẩn "Bảng số liệu (0 dòng)".
5. Trạng thái "chưa có dữ liệu nào" toàn app (mới mở, DB rỗng): một empty state lớn ở vùng nội dung thay cho KPI toàn số 0 và biểu đồ trống: "Chưa có dữ liệu cuộc gọi" · [Cập nhật từ MPT] [Tải file CSV].

**Nghiệm thu:** tab Vòng đời CID khi chưa tải: chiều cao trang ≤ 1.200 px (hiện ~2.950 px). Mở app với DB rỗng không còn KPI "0", "0%".

---

### UX-25 · Tab Cước phí

**Hiện trạng:** thanh lọc chính bị làm mờ, tab có khoảng thời gian riêng (badge "Tab Cước phí dùng khoảng thời gian riêng" + nút áp bộ lọc trên); ô ngày/giờ bị cắt ("10/01,", "12:0"); "0 đ" màu xanh khi chưa nhập đơn giá; đoạn công thức và dự đoán cuối tháng là khối chữ nhỏ dày đặc có phần đỏ; chưa có đơn giá vẫn vẽ biểu đồ toàn cột 0 và khung "Chưa có cuộc gọi tính cước để chia theo telco" cao ~400 px.

**Việc cần làm**
1. Mặc định tab dùng khoảng thời gian của thanh lọc chính (không làm mờ thanh lọc). Thêm công tắc "Dùng khoảng thời gian riêng cho Cước phí"; bật mới hiện ô ngày riêng và badge cảnh báo. Lưu lựa chọn như hiện tại.
2. Bố cục "Cấu hình tính cước" 3 cột: nới cột Khoảng thời gian hoặc chuyển ngày/giờ vào cùng popover chọn khoảng (dùng lại component UX-20) để không còn ô bị cắt.
3. Chưa nhập đơn giá: thay khu Kết quả + biểu đồ bằng empty state "Nhập đơn giá/phút để tính thành tiền" với ô nhập đơn giá ngay trong đó; vẫn hiện các số không phụ thuộc đơn giá (phút tính cước, giây làm tròn, chênh do block). KPI Thành tiền hiện "—", màu trung tính.
4. Công thức và dự đoán: chuyển vào `<details>` "Cách tính" (đóng mặc định), trình bày dạng danh sách từng bước, chữ ≥ 13 px, chỉ dùng màu đỏ cho cảnh báo thực sự.
5. Số liệu dùng `UIFormat` (đồng bộ với Tổng quan).
6. Nút "Export CSV tổng hợp"/"Export chi tiết từng cuộc" → "Xuất CSV tổng hợp"/"Xuất chi tiết từng cuộc".

**Nghiệm thu:** chưa nhập đơn giá: không có biểu đồ toàn 0. Ô ngày giờ không bị cắt ở 1280 px. Thành tiền khi có đơn giá bằng đúng kết quả cũ (test billing hiện có vẫn đạt).

---

### UX-26 · Rà ngôn từ toàn app

**Việc cần làm**
1. Áp dụng `UI_LABELS` (UX-01) cho: chip, KPI, legend, tiêu đề biểu đồ, tiêu đề cột bảng, toast, tiêu đề dialog, menu, sidebar, popover giải thích.
2. Danh sách đã thấy cần sửa: NoAnswer, Connected, Huỷ (chuẩn "Hủy"), Max Call Fail, Median Random Number, Billsec trung bình, Destination lặp, attempts, Stacked %, Account summary, Auto loaded … records, Export, "Phân bổ" (→ "Phân bố"), tiêu đề "Tỷ lệ Fail / No Answer / Cancelled / Connected theo Telco (Stacked %)" → "Trạng thái cuộc gọi theo nhà mạng (%)".
3. Viết lại chữ nút theo động từ + đối tượng ("Gán Gateway", "Tải từ cache", "Thêm kết nối").
4. Thông báo lỗi: nói chuyện gì xảy ra + làm gì tiếp, không lộ chi tiết kỹ thuật ở dòng chính.

**Nghiệm thu:** grep các chuỗi tiếng Anh trong danh sách trên không còn ở phần hiển thị (trừ mã hangup cause và thuật ngữ ngành ASR, CID, billsec trong tooltip).

---

## 8. Đợt 3 — Hệ thống và hoàn thiện

### UX-30 · Dọn CSS cũ, style inline, `!important`

1. Xoá luật CSS không còn khớp phần tử nào (dùng Chromium coverage trong `snap.mjs` qua 7 tab + mở các dialog/popover để lấy danh sách).
2. Chuyển `style="…"` inline về class (mục tiêu: < 80 chỗ còn lại, chỉ cho giá trị động như `width:%` của thanh tiến độ).
3. Bỏ `!important` (mục tiêu ≤ 5, mỗi chỗ còn lại có comment lý do).
4. Mã màu cứng ngoài file token: mục tiêu 0 trong CSS, ≤ 10 trong JS (chỉ fallback khi không đọc được token).

**Nghiệm thu:** ảnh 7 tab × 2 theme giống ảnh sau UX-26 (khác biệt pixel chỉ do dọn dẹp, phải giải thích được).

### UX-31 · Responsive 900–1440 px

1. 1024–1279 px: sidebar 180 px, KPI chính 4 cột, biểu đồ đôi xếp 2 cột nếu thẻ ≥ 460 px, ngược lại 1 cột.
2. 900–1023 px: sidebar thu thành icon + tooltip (có `aria-label`), thanh lọc tối đa 2 hàng.
3. < 900 px: sidebar thành hàng tab cuộn ngang (đã có), thanh lọc gom thành 1 nút "Bộ lọc" mở sheet; không cuộn ngang trang.
4. Bảng rộng nằm trong khung `overflow-x:auto` có bóng mép.
5. `Plotly.Plots.resize` khi đổi kích thước (debounce 150 ms) và khi đóng/mở side sheet AI.

**Nghiệm thu:** `snap.mjs` thêm 1024, 900, 600 px: `document.documentElement.scrollWidth <= innerWidth` ở mọi tab.

### UX-32 · Skeleton thay màn chờ toàn màn khi lọc lại

1. Đọc DB/lọc lại (không gọi MPT): không hiện modal `#reportLoading`; thay bằng `.skeleton` trên KPI và thẻ biểu đồ đang vẽ, giữ thao tác được với phần còn lại.
2. Modal chỉ dùng khi Cập nhật từ MPT (có tiến độ theo tài khoản, Hủy).
3. Sau 400 ms mới hiện skeleton (tránh nháy với dữ liệu nhỏ).

### UX-33 · Tổ chức lại tab Cài đặt

Bố cục 2 cột: danh mục bên trái (dính), nội dung bên phải. Mục:
1. Kết nối MPT (UX-22)
2. Tên hiển thị tài khoản
3. Gateway ↔ Tài khoản
4. Phân tích & ngưỡng cảnh báo (KPI_THRESHOLDS, `alertThreshold`, tuỳ chọn phân tích & màu sắc hiện có)
5. Giao diện (Sáng / Tối / Theo hệ thống; mật độ hiển thị nếu có)
6. Trợ lý AI (cấu hình LLM — gộp dialog `#llmConfigDialog` vào đây)
7. Dữ liệu & bảo trì (trạng thái DB, Thu gọn DB, xoá cache, giữ 60 ngày)

Mỗi mục có tiêu đề, mô tả 1 câu, nút Lưu riêng và thông báo đã lưu tại chỗ.

### UX-34 · Rà danh mục báo cáo mặc định

1. Mỗi tab hiển thị mặc định tối đa 4–6 báo cáo trả lời câu hỏi chính của tab; phần còn lại vào "Hiển thị thêm N báo cáo" (cơ chế hiện có).
   - Tổng quan: KPI, phân bố trạng thái, xu hướng ASR & tỷ lệ kết nối theo ngày, phút gọi theo tài khoản.
   - Chất lượng: trạng thái theo nhà mạng, trạng thái theo đầu số, lý do lỗi, heatmap nguyên nhân × nhà mạng.
   - Vận hành: xu hướng ASR, phút theo ngày, khung giờ vàng, cuộc gọi đồng thời.
   - Dữ liệu & Tài khoản: cảnh báo vận hành, hiệu suất tài khoản, tổng hợp theo tài khoản, sức khỏe Gateway.
   - **Danh sách này là đề xuất, chủ dự án xác nhận trước khi làm.**
2. Biểu đồ "Chiều cuộc gọi" chỉ hiện khi dữ liệu có cả hai chiều; nếu 100% một chiều thì thay bằng một dòng chữ trong KPI phụ.
3. Mỗi thẻ có tiêu đề dạng câu hỏi/kết luận ngắn và dòng phụ nêu phạm vi (ngày, số cuộc).

### UX-35 · QA cuối và tài liệu

1. Chạy toàn bộ test + `snap.mjs` (7 tab × 2 theme × 3 độ rộng) + axe 7 tab × 2 theme.
2. So từng KPI với baseline UX-00 trên cùng dữ liệu giả lập: phải bằng nhau.
3. Thử bàn phím toàn luồng: mở app → chọn kết nối → khoảng thời gian → bộ lọc khác → Cập nhật → drilldown → đóng → đổi tab → mở trợ lý AI → đóng.
4. Build bản portable, mở trên máy sạch (hoặc thư mục mới), kiểm CSS/font/Plotly tải được offline.
5. Cập nhật `README.md` mục "Giao diện" và "Flow sử dụng" theo luồng mới; thêm `docs/ui-guidelines.md` tóm tắt token, thành phần, thuật ngữ cho người phát triển sau.

---

## 9. Chỉ số hoàn thành toàn dự án

| Chỉ số | Hiện tại | Mục tiêu |
|---|---|---|
| Vi phạm axe serious/critical (7 tab, sáng + tối) | 4 trên Tổng quan | 0 |
| Chiều cao thanh lọc ở 1440 px | ~240 px | ≤ 112 px |
| Cỡ chữ khác nhau | 17 | 6 |
| `style=""` inline | 558 | < 80 |
| `!important` | 37 | ≤ 5 |
| Mã màu hex khác nhau | 175 | token + ≤ 10 fallback |
| Chiều cao tab Vòng đời CID khi chưa có dữ liệu | ~2.950 px | ≤ 1.200 px |
| Định dạng số | 3 kiểu | 1 (`UIFormat`) |
| Nơi quản lý kết nối MPT | 3 | 1 |
| Số liệu KPI so với baseline | — | khớp 100% |

---

## 10. Mẫu prompt giao từng task cho Codex

```
Đọc docs/ui-ux-overhaul-plan.md, mục 0 (Quy tắc chung), mục 2 (Hệ thống thiết kế),
mục 3 (Thuật ngữ) và task UX-xx. Làm đúng phạm vi task UX-xx, không làm task khác.
Dùng CodeGraph trước khi đọc mã. Không gọi MPT thật.
Khi xong: chạy các lệnh kiểm thử ở mục 0.10, chạy node tests/ui/snap.mjs,
xem ảnh các tab bị ảnh hưởng (sáng + tối), commit với message "ux(UX-xx): <tóm tắt>"
và báo lại: thay đổi chính, file đã sửa, kết quả test, kết quả axe,
những gì chưa kiểm chứng được và câu hỏi cần chủ dự án quyết định.
```

Các điểm cần chủ dự án quyết định trước khi giao: UX-00 bước 1 (commit thay đổi đang dở), UX-22 bước 2 (hợp nhất tài khoản cần tải/đang xem), UX-23 bước 4 (ngưỡng mặc định), UX-34 bước 1 (báo cáo hiển thị mặc định).
