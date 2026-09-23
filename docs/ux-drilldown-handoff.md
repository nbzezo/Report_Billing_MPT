# Bàn giao UX: mở chi tiết từ KPI, Account và Gateway

Người triển khai: GPT-5.6 Luna. Phạm vi đợt này là đề xuất UX ưu tiên số 1.

## Mục tiêu

Người dùng bấm một số liệu hoặc đối tượng để xem ngay các cuộc gọi tạo nên số liệu đó, trong đúng phạm vi báo cáo đang áp dụng. Đóng chi tiết phải quay về dashboard với bộ lọc và tab được giữ nguyên.

## Luồng cần hỗ trợ

1. Bấm KPI trạng thái Fail, No Answer, Hủy hoặc Connected để xem cuộc gọi của trạng thái đó. Tổng cuộc có thể mở toàn bộ cuộc gọi trong phạm vi hiện tại.
2. Bấm Account trong bảng tổng hợp để xem cuộc gọi của Account đó.
3. Bấm Gateway để xem cuộc gọi tương ứng; tại hàng Account × Gateway, giữ cả hai điều kiện.
4. Chi tiết hiển thị phạm vi ngày/giờ, Account, Gateway, trạng thái, tổng kết quả và trang hiện tại. Người dùng có thể chuyển trang rồi đóng hoặc nhấn Escape để quay lại.

## Quy tắc dữ liệu

- Dùng bộ lọc đã áp dụng, không lấy các giá trị người dùng đang sửa nhưng chưa áp dụng.
- Dùng ID Account và khóa Gateway thực tế; tên hiển thị chỉ phục vụ giao diện.
- Tái sử dụng phân loại cuộc gọi hiện tại để số đếm khớp KPI.
- Hỗ trợ cả dữ liệu do worker giữ và đường xử lý trên main thread.
- Không gọi MPT khi mở chi tiết.
- Phân trang; không đưa toàn bộ dữ liệu lớn vào DOM.
- Không để phản hồi truy vấn cũ ghi đè truy vấn mới hoặc hiển thị như thuộc dataset mới.
- Các trường dữ liệu đưa vào HTML phải được escape.

## Giao diện và khả năng truy cập

- Dùng panel/dialog phù hợp phong cách hiện có; trigger phải có dấu hiệu tương tác rõ.
- Bảng gồm thời gian, Account, Gateway nếu có, số nguồn/đích, trạng thái, lý do kết thúc và thời lượng với đơn vị rõ ràng.
- Có trạng thái đang tải, không có kết quả và lỗi.
- Hỗ trợ bàn phím trên trigger, Escape, quản lý focus và trả focus về trigger khi đóng.
- Không biến KPI không có tập cuộc gọi tương ứng rõ ràng thành nút gây hiểu nhầm.

## Kiểm chứng trước bàn giao

- Lọc kết hợp trạng thái, Account, Gateway và phạm vi ngày/giờ cho kết quả đúng.
- Hai Account trùng tên vẫn tách biệt; Gateway trùng tên theo Account giữ đúng phạm vi.
- Gateway thiếu, không có kết quả, ranh giới trang và trang cuối hoạt động đúng.
- Kết quả worker và main thread thống nhất.
- Đổi dataset hoặc truy vấn nhanh không để kết quả cũ ghi đè.
- Bấm mở, chuyển trang, Escape và quay lại được kiểm tra trên dữ liệu mẫu.
- Chạy các kiểm thử phù hợp của repository, cập nhật README và báo rõ giới hạn kiểm chứng.

## Ràng buộc

- Bảo toàn các thay đổi có sẵn trong workspace; không sửa thuật toán nghiệp vụ hoặc tích hợp MPT ngoài phạm vi cần thiết.
- Dùng CodeGraph trước khi tìm/đọc mã vì repository đã có `.codegraph/`.
- Không sử dụng tài khoản MPT thật để kiểm thử và không đưa thông tin kết nối vào báo cáo.
- Những đề xuất UX khác (thu gọn KPI, lưu góc nhìn, chuẩn hóa toàn bộ nhãn…) nằm ngoài đợt này.

## Baseline kiểm thử trước triển khai

- `node --test tests/core.test.mjs`: 66/66 đạt.
- `python -m pytest tests/test_dashboard.py -q`: 104 đạt, 11 lỗi trong nhóm lưu cấu hình/mã hóa do `PermissionError: WinError 5` khi dọn file `secret.key` ở thư mục tạm trên môi trường hiện tại. Đây là kết quả trước thay đổi UX.

## Kết quả triển khai và rà soát

- GPT-5.6 Luna đã triển khai dialog chi tiết, trigger KPI/Account/Gateway, query phân trang trên worker và logic lọc dùng chung. Agent chính rà soát, giữ giao thức phân trang cũ, bổ sung hủy chi tiết tại thời điểm cập nhật KPI và tinh chỉnh nhãn/màu trạng thái.
- `node --test tests/core.test.mjs`: 68/68 đạt.
- `python -m pytest tests/test_dashboard.py -q -k 'not ProfileStoreTests and not PortableSecretTests and not LlmConfigStoreTests'`: 102 đạt, 13 bài thuộc nhóm cấu hình/mã hóa được loại khỏi lượt kiểm tra này vì lỗi môi trường nêu trên.
- Kiểm tra cú pháp core/worker và `git diff --check` đạt.
- Kiểm thử trình duyệt với 123 cuộc gọi giả: tổng 123, Fail 61, Account `ux-b` có 62 cuộc dù trùng tên với `ux-a`; phân trang 25 dòng; Escape trả focus về trigger; chuỗi HTML trong tên hiển thị dạng văn bản; No Answer không có kết quả được hiển thị rõ.
- Logic Gateway kết hợp Account được kiểm thử tự động. Chưa kiểm chứng giao diện bằng mapping Gateway thực tế hoặc gọi hệ thống MPT thật.

## Cách sử dụng

1. Mở lại hoặc tải mới trang dashboard sau khi cập nhật mã nguồn; nạp dữ liệu như thường lệ.
2. Bấm **Tổng cuộc** hoặc nhãn trạng thái để mở chi tiết.
3. Trong tab **Dữ liệu & Tài khoản**, mở bảng **Account summary** hoặc bảng **Gateway**, rồi bấm tên Account/Gateway.
4. Kiểm tra phạm vi ở đầu hộp chi tiết, dùng **Trước/Sau** để chuyển trang.
5. Bấm **Đóng** hoặc nhấn **Escape** để về dashboard; tab và bộ lọc vẫn được giữ lại.

Thay đổi nằm trong mã nguồn workspace; chưa commit, push hoặc đóng gói lại bản portable.
