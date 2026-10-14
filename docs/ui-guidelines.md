# Quy ước giao diện MPT Call Dashboard

Tài liệu này là điểm tham chiếu ngắn cho mọi thay đổi UI sau đợt cải tổ UX-00 → UX-35. Logic nghiệp vụ vẫn nằm trong `dashboard-core.js`; giao diện không được tự tạo một công thức KPI thứ hai.

## Token

- Dùng token trong `dashboard.css`, không thêm mã màu trực tiếp nếu đã có token tương ứng.
- Nền dùng `--bg`, `--surface`, `--surface-2`; chữ dùng `--text`, `--text-2`; đường phân cách dùng `--border`/`--divider`.
- `--accent` dành cho hành động và trạng thái chọn; `--brand` dành cho nhận diện.
- Trạng thái nghiệp vụ dùng `--st-connected`, `--st-noanswer`, `--st-cancelled`, `--st-fail`. Không dùng màu phân loại để thay cho ý nghĩa tốt/xấu.
- Cỡ chữ tối thiểu 12 px. Các phần tử tương tác phải có `:focus-visible` và vùng bấm tối thiểu phù hợp màn hình cảm ứng.

## Thành phần và bố cục

- Một màn hình chỉ có một hành động chính nổi bật. Trên Dashboard đó là **Cập nhật**.
- Bộ lọc thường dùng nằm trên thanh lọc; bộ lọc ít dùng nằm trong **Bộ lọc khác**. Bộ lọc đã áp dụng phải hiện thành chip và có thể xóa.
- Mỗi tab mở mặc định 4–6 báo cáo quyết định. Phần còn lại dùng `report-more-toggle` với nhãn **Hiển thị thêm N báo cáo**.
- Card báo cáo dùng tiêu đề là câu hỏi/kết luận ngắn và dòng phụ `ngày · số cuộc gọi`. Card rỗng phải nêu nguyên nhân và hành động tiếp theo.
- Dùng skeleton khi đọc lại dữ liệu đã lưu hoặc lọc; modal tiến độ chỉ dành cho quá trình tải/cập nhật có thể hủy.
- Ở 600 px, bộ lọc mở thành sheet và sidebar thành thanh điều hướng ngang. Không được tạo tràn ngang tài liệu.

## Thuật ngữ

- Dùng nhãn từ `UI_LABELS`; không viết biến thể riêng của trạng thái cuộc gọi.
- **Kết nối MPT**: cấu hình domain và thông tin đăng nhập.
- **Tài khoản cần tải**: phạm vi đồng bộ từ MPT.
- **Tài khoản đang xem**: phạm vi lọc trên dữ liệu đã tải. Hai phạm vi luôn độc lập.
- **Cập nhật**: tải dữ liệu từ MPT. Đổi bộ lọc chỉ đọc dữ liệu đã lưu.
- Số, phần trăm, thời lượng, tiền và ngày phải đi qua `UIFormat`.

## Accessibility và kiểm thử

- Popover/dialog/sheet mở bằng bàn phím, đóng bằng `Esc`, giữ focus bên trong khi phù hợp và trả focus về trigger.
- Không truyền nghĩa chỉ bằng màu. Icon trang trí dùng `aria-hidden="true"`; nút icon phải có tên truy cập.
- Trước khi merge, chạy:

```powershell
python -m unittest discover -s tests -v
node --test tests/core.test.mjs
node tests/ui/snap.mjs
```

`snap.mjs` đối chiếu KPI với `tests/ui/baseline/kpi.json`, chụp 7 màn hình ở light/dark và 1440/1024/600 px, đồng thời chạy axe WCAG 2.1 A/AA trên cả 7 màn hình.
