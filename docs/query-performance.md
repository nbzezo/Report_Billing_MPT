# Tối ưu khởi động và truy vấn — 09/11/2026

## Những thay đổi đã triển khai

- Cleanup so sánh trực tiếp timestamp và dùng `idx_calls_time(start_stamp)`. Cả bước tìm kết nối bị ảnh hưởng lẫn bước xóa đều tìm theo index; `DISTINCT profile_id` được chỉ định index thời gian để tránh SQLite chọn quét index theo profile.
- Chỉ chạy incremental vacuum khi thực sự xóa cuộc gọi; mỗi lần giới hạn 1.024 trang. Giữ chính sách lưu 60 ngày. Cleanup tăng revision của từng kết nối bị ảnh hưởng để cache analytics trên RAM/đĩa không giữ báo cáo cũ.
- Thêm covering index `idx_calls_profile_metrics(profile_id,start_stamp,hangup_cause,duration,billsec)` phục vụ đếm/lọc trạng thái mà không đọc bản ghi CDR lớn.
- `call_daily_stats` lưu số dòng, tổng billsec, timestamp đầu/cuối và thời điểm ingest theo profile/ngày/account/nhà mạng/hướng gọi. Tính từ các dòng thực lưu, tránh cộng trùng UUID và các lần đồng bộ chồng phạm vi. Khi đồng bộ lại một account, dựng lại tổng hợp của các ngày bị tác động trong cùng transaction.
- `daily_stats_state` gắn tổng hợp với revision. Tổng hợp thiếu hoặc cũ sẽ dùng đường đọc dữ liệu gốc. Cuộc gọi được sửa sang ngày khác làm mất hiệu lực tổng hợp cũ; không dùng số liệu sai để tăng tốc.
- API `/api/data-status?light=1` dùng tổng hợp hoặc truy vấn index nhẹ. DB cũ chưa có tổng hợp không phải quét `MAX(ingested_at)` khi mở trang. API đầy đủ vẫn giữ `updatedAt` chính xác. Cache thống kê trong RAM được xóa khi dữ liệu đổi; lịch sử sync và dung lượng đọc mới.
- Chọn kết nối không chờ trạng thái DB; phản hồi của kết nối cũ không ghi đè kết nối vừa chọn.
- Biểu đồ tổng phút theo ngày/hướng gọi dùng tổng hợp khi đủ điều kiện. Bộ lọc số điện thoại, nguyên nhân, loại gọi hoặc khung giờ không trọn ngày vẫn dùng dữ liệu gốc. RN, callback, percentile, CCU và cước vẫn dùng thuật toán hiện có.
- Drilldown không lọc gateway truy vấn SQL với `LIMIT/OFFSET`, không cần nạp toàn dataset vào JavaScript. SQL phân loại trạng thái được tạo từ classifier/cause sets trong `dashboard-core.js`; chuẩn hóa cause một lần mỗi dòng. Lọc gateway giữ đường xử lý cũ.
- Launcher chỉ chờ một giây nếu tìm thấy tiến trình trình duyệt cũ. Đường chạy PowerShell đã quote đường dẫn script có dấu cách.

## Số đo trên dữ liệu hiện tại

DB nguồn giữ nguyên **3.395.634 cuộc gọi**, tổng hợp thành **3.557 dòng**. DB portable giữ nguyên **1.491.029 cuộc gọi**, tổng hợp thành **814 dòng**. Bước bảo trì không xóa lịch sử hay đổi cấu hình đăng nhập.

| Phép đo | Trước | Sau |
|---|---:|---:|
| Kiểm tra cleanup khi không có dòng quá hạn | SELECT mô phỏng quét bảng: 27,4 giây | khoảng 0,004–0,011 giây |
| Trạng thái kết nối 1.786.544 dòng | 24,2 giây | khoảng 0,15–1,7 giây lần đầu; 0,006–0,013 giây khi cache |
| Tổng hợp theo ngày | Đọc/tổng hợp dữ liệu gốc | khoảng 5–15 ms từ bảng tổng hợp |

Lần đo cuối: tạo server có dữ liệu mất 0,123 giây; drilldown đầu tiên trả 25/1.786.544 dòng trong 1,216 giây; lọc Connected trả 25/637.120 dòng trong 3,541 giây. Không cần dựng dataset JavaScript đầy đủ cho hai truy vấn này.

Các số này đo từng bước cục bộ, không phải tổng thời gian mở cửa sổ Edge. Disk cache và các tiến trình khác ảnh hưởng kết quả. Ngày có nhiều dòng quá hạn vẫn cần thời gian xóa và cập nhật index.

Hai index mới và tổng hợp tăng DB nguồn từ khoảng 2,69 GB lên 2,94 GB, đổi lại tránh đọc bản ghi lớn ở các đường truy vấn đã tối ưu. Đồng bộ có thêm chi phí cập nhật index và dựng lại tổng hợp của các ngày vừa thay đổi.

## DuckDB/Parquet

Đã chạy sáu truy vấn đối chiếu chính xác: tổng số cuộc/billsec, theo ngày, theo account, theo nhà mạng, theo giờ và trạng thái dữ liệu. Các kết quả đều khớp, dùng sai số nhỏ cho tổng số thực.

Benchmark chỉ xuất bảy cột phục vụ phép đo, không xuất số điện thoại; file Parquet của phép đo không đại diện dung lượng toàn bộ CDR. Chi phí xuất snapshot và chuyển đổi được ghi riêng. Đây là benchmark truy vấn, không bao gồm enrich, RN, callback hay dựng toàn cube.

Lần đo cuối trên 1.786.544 cuộc gọi của kết nối lớn nhất (giây):

| Truy vấn trên dữ liệu gốc | SQLite | DuckDB | Parquet qua DuckDB |
|---|---:|---:|---:|
| Tổng số cuộc/billsec | 0,761 | 0,086 | 0,031 |
| Theo ngày | 1,952 | 0,170 | 0,205 |
| Theo account | 36,655 | 0,095 | 0,032 |
| Theo nhà mạng | 2,732 | 0,121 | 0,059 |
| Theo giờ | 1,651 | 0,152 | 0,164 |
| Trạng thái dữ liệu | 2,025 | 0,178 | 0,147 |

SQLite trong bảng này truy vấn bảng CDR gốc; đường tổng hợp theo ngày đã triển khai mất 0,015 giây ở cùng lần đo. Xuất snapshot mất 52,565 giây, chuẩn bị DuckDB 7,697 giây, ghi Parquet 1,583 giây. Chạy lại có thể khác đáng kể do disk cache; không coi một lượt benchmark là bảo đảm độ trễ cho mọi bộ lọc.

**Giữ DuckDB là công cụ benchmark tùy chọn, chưa thêm vào runtime.** Với các chỉ số cộng được đã triển khai, tổng hợp SQLite nhanh hơn đọc lại dữ liệu bằng DuckDB; thêm engine lúc này tạo thêm đường đồng bộ dữ liệu. DuckDB vẫn là ứng viên cho báo cáo theo giờ hoặc truy vấn phân tích mới chưa có tổng hợp, sau khi đo cả chi phí cập nhật. Không thêm vector/RAG vào phép tính số liệu cuộc gọi.

Kết quả benchmark cuối nằm trong `.cache/query-benchmark.json`; số đo khởi động/truy vấn nằm trong `.cache/startup-query-after.json`.

## Chạy lại

Chuẩn bị một DB cũ, giữ nguyên dữ liệu cuộc gọi:

```powershell
python scripts/optimize_store.py
python scripts/optimize_store.py --root "dist/MPT Call Dashboard"
```

DB lớn cần thời gian tạo index và dựng tổng hợp một lần; nên thực hiện bước bảo trì trước khi phân phối bản nâng cấp. DB mới tự duy trì tổng hợp từ lần ingest đầu tiên. Tác vụ bị ngắt có thể chạy lại.

Benchmark DuckDB/Parquet, thư viện chỉ cài vào cache cục bộ:

```powershell
python -m pip install --target .cache/duckdb-benchmark duckdb==2.0.0
python scripts/benchmark_queries.py
```

Benchmark mở DB nguồn read-only trong một snapshot; các file CSV/DuckDB/Parquet tạm được dọn khi kết thúc. Các truy vấn truy xuất chính xác vẫn có thể tốn thời gian nếu trả về hoặc phải xét rất nhiều dòng.

## Kiểm chứng

- Bộ Python (250 kiểm thử) và Node core (94 kiểm thử); các kiểm thử mới đối chiếu SQL drilldown với thuật toán gốc, gồm cả giờ qua nửa đêm, phân trang, bảy trạng thái và thứ tự ưu tiên nguyên nhân.
- Kiểm tra tổng hợp sau UUID trùng, thay thế một account, dữ liệu rỗng, sửa ngày cuộc gọi, cleanup và revision cũ.
- `node tests/ui/startup-status.mjs` kiểm tra API nhẹ, chọn kết nối không bị chặn và chống phản hồi đến muộn.
- `tests/ui/snap.mjs` hiện dừng ở baseline KPI cũ; phép đối chiếu riêng xác nhận KPI trước/sau tối ưu giống nhau. Khi dùng các KPI đã xác minh để chạy tiếp, script còn gặp giả định cũ rằng phân bố trạng thái chỉ có bốn nút drilldown. Không sửa các baseline hoặc hành vi phân loại có sẵn trong đợt tối ưu này.
