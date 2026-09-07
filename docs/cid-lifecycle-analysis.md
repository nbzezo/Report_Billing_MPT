# Vòng đời CID — ghi chép phân tích

Tài liệu này giữ lại **kết quả đo** và **lý do của các quyết định** khi xây tab
"Vòng đời CID", để lần sau đánh giá hoặc bổ sung thì không phải phân tích lại.

Toàn bộ số liệu đo trong khoảng **10/07/2026 – 07/09/2026** (60 ngày lịch sử
Block/Reactive) và **18/08 – 07/09/2026** (21 ngày CDR, 832.230 dòng, 2 account).
Nguồn: profile `PS3-TuanDA` @ `customer-billing.mpt.com.vn`.

---

## 1. Nguồn dữ liệu: trang `routing/reports`

Cột: `ID | Routing | CID | Time | Notes | Type`. Form POST về chính nó với
`routing_id`, `cid`, `type` (`0`/`block`/`reactive`), `from_day`, `to_day`.

Những điều **không** đọc ra được từ giao diện, phải biết trước:

| Điều | Hệ quả |
|---|---|
| `/routing/export` trả về **HTML**, không phải CSV | Phải scrape bảng, không dùng được kiểu `calldata/export` |
| Mỗi truy vấn **chặn cứng ở 2.000 dòng**, không phân trang | Phải kéo **theo từng ngày** rồi ghép. Đo thật: không ngày nào chạm trần |
| Cột `ID` là **số thứ tự hiển thị** (mỗi truy vấn bắt đầu từ 1) | Không dùng làm khoá dedup được |
| Reactive ghi **theo lô**, có dòng trùng cùng giây (~8–9%) | Khoá dedup = `(routing, cid, ts, kind, telco)`, bỏ qua mốc giờ trong Notes |
| `Notes` chứa **nhà mạng đích + actor** | `Block VT by Verifier CID at …` / `Reactive VT by tool at …` |
| CID có **4 định dạng** | `02479929887` (11), `0916407599` (10), `842471060319` (12), `919362764` (9) |

**Độ mịn của việc khoá là `(CID × Routing × nhà mạng đích)`, không phải cấp CID.**
Một số có thể đang bị VT chặn mà vẫn gọi MB bình thường. Mọi phép tính phải giữ
độ mịn đó.

Ba hệ ký hiệu nhà mạng phải quy về một: CDR bản cũ (`Viettel/Mobi/Vina`), bản mới
(`VIETTEL/MOBI/VINA/FIXED`), log block (`VT/MB/VN/OT`). `OT` là nhóm gộp của
nguồn nên Vietnamobile/Itel/cố định đều về OT.

### Bản đồ Routing ↔ Account

**Nối bằng tên chính xác, không cần suy luận** — đo thật: 23/23 routing có
account trùng tên tuyệt đối (vd account id `334` tên đúng là `SIP_SCEX_OTP_C2C`).
`deriveRoutingAccountMap` (suy qua CID dùng chung) giữ lại làm phép đối chiếu.

Ba trạng thái phải phân biệt, gộp lại là khen nhầm khách hàng:

- **có routing + có block** (23 account)
- **có routing, 0 block** (17) → "0 block" là **sự thật**
- **không có routing** (0 trong PS3) → "0 block" chỉ là **không thấy**

`Mcredit_AutoCallTHN` không nằm trong cả danh sách account lẫn routing của PS3
→ thuộc profile khác (PS4), không phải điểm mù.

---

## 2. Quy tắc 24h / 48h

Vận hành: quá **24h** chưa Reactive là **đỏ**, quá **48h** coi như nhà mạng đã
khoá thật.

Đo trên 3.873 khoảng bị khoá:

| | Số ca |
|---|---|
| Đã mở lại | 3.110 |
| Đỏ (>24h chưa mở) | 668 — **trong đó 666 đã vượt luôn 48h** |
| Chết (>48h chưa mở) | 666 |
| Đã đỏ nhưng vẫn quay lại | 427 (13,7% số ca đã mở lại) |
| Quay lại muộn hơn cả mốc 48h | 361 (11,6%) |

Phân bố **lưỡng cực**: hoặc hồi phục nhanh (p50 = 4,1h) hoặc không bao giờ. Chỉ
**2 ca** nằm trong dải 24–48h. Vì vậy dời mốc chết từ 24h sang 48h chỉ giảm sai
số **13,7% → 11,6%** — ít hơn nhiều so với kỳ vọng.

Phân vị thời gian hồi phục: p10 1,5h · p25 2,8h · **p50 4,1h** · p75 6,9h ·
p90 72,6h · p99 171,5h · max 552,7h.

Theo nhà mạng — **VT là vấn đề**, không phải "nhà mạng nói chung":

| | Lượt khoá | MTTR | Chết |
|---|---|---|---|
| **VT** | 2.510 | **21,7h** | **559** |
| MB | 965 | 7,2h | 84 |
| VN | 337 | 10,7h | 24 |
| OT | 61 | 5,6h | 1 |

---

## 3. Kết quả DƯƠNG tính (dùng được)

### 3.1. Block có mở lại thì vô hại; không mở lại thì chết thật

Đối chiếu 4.108 cuộc gọi thật của account `334` với timeline:

| Trạng thái CID lúc gọi | Số cuộc | Tỷ lệ kết nối |
|---|---|---|
| Ngoài cửa sổ bị khoá | 3.739 | 55,7% ← nền |
| Trong khoảng **đã mở lại** | 69 | **62,3%** |
| Trong khoảng **chưa mở lại** | 300 | **0,0%** |

- Quy tắc "không mở lại = chết" được **xác nhận**: 0/300 kết nối, không ngoại lệ.
- Block có mở lại **không chặn route** (62,3% > cả nền) — đúng là cờ nghi ngờ.
- Hệ thống **vẫn nã cuộc gọi vào số đã chết**: 300 cuộc/7 ngày trên một account
  (7,3% lưu lượng). Không có gì báo cho bộ quay số biết số đã chết.

Chữ ký hangup tách bạch hoàn toàn: ngoài là `NORMAL_CLEARING 56%`, trong là
`NO_USER_RESPONSE 64% + CALL_REJECTED 20%`.

Vì hai nhóm khác nhau **tối đa**, phép này đồng thời là **kiểm chứng timeline** —
timeline sai thì chúng đã trông giống nhau.

### 3.2. Tần suất quay số là chỉ báo duy nhất nổi lên

Tổ hợp tín hiệu trước khi khoá (cửa sổ 6h, 1.251 ca vs 7.444 đối chứng):

| Tổ hợp | Trước khoá | Đối chứng | Gấp nền |
|---|---|---|---|
| **Tần suất quay số (đơn)** | **32,4%** | 20,0% | **×1,62** |
| Nguyên nhân rớt + Thời lượng (kép) | 7,7% | 10,8% | ×0,71 |
| Thời lượng kết nối (đơn) | 4,6% | 10,2% | ×0,44 |
| Nguyên nhân rớt (đơn) | 3,6% | 9,1% | ×0,40 |

Ba điều ngược trực giác:

- Chỉ **duy nhất** tần suất nổi lên. Cause và thời lượng đều **dưới nền** — chúng
  là *triệu chứng của việc đã bị khoá*, không phải dấu hiệu đi trước.
- Tín hiệu **kép lại ít xảy ra trước khi khoá hơn bình thường** (×0,70).
- Ở cửa sổ **24h tín hiệu biến mất** (×0,95) → **6h là chân trời đúng**.

### 3.3. Đợt càn quét là có thật

66 đợt trong 60 ngày. Mạnh nhất: **17 CID bị khoá trong 5 phút** (14/08), trải
trên 4 routing và 3 nhà mạng — dạng sự cố hệ thống, không phải hành vi từng số.

Ngưỡng dùng **trung vị + k·MAD**, không dùng trung bình + k·độ lệch chuẩn: chính
các đợt càn quét sẽ thổi phồng độ lệch chuẩn và **tự che mất mình**. Trên dữ liệu
thật MAD = 0 (phân bố quá lệch) nên ngưỡng rơi về sàn tuyệt đối — `thresholdSource`
báo rõ điều đó.

---

## 4. Kết quả ÂM tính — ĐỪNG LÀM LẠI

> Phần này là lý do chính của tài liệu. Hai giả thuyết dưới đây **đã được kiểm
> định tử tế và đều thất bại**. Nếu muốn thử lại, hãy đọc kỹ *tại sao* trước.

### 4.1. Ngưỡng an toàn "bao nhiêu cuộc/ngày mỗi CID" — KHÔNG TỒN TẠI

Đọc ngây thơ cho một đường liều–đáp–ứng rất đẹp:

```
1–4: 1,7%   5–9: 16,7%   10–19: 22,6%   20–39: 24,7%
40–79: 31,2%   80–159: 48,2%   160+: 17,5%
```

**Đó là ảo giác do thành phần mẫu.** Các bậc tải thấp chứa đầy CID chưa bao giờ
bị khoá. Giới hạn vào CID đã từng bị khoá ít nhất một lần (so cùng loại):

```
1–4: 29,5%   5–9: 54,9%   10–19: 42,6%   20–39: 38,6%
40–79: 39,1%   80–159: 56,3%   160+: 22,2%
```

Không còn đơn điệu, dao động 22–56%. **Tải gần như không giải thích được gì.**

Bucket 160+ tụt xuống 22,2% là **thiên lệch người sống sót**: 257 CID sinh 1.104
CID-ngày, tức chúng duy trì tải cao ngày qua ngày — chúng đã sống sót rồi, không
phải bằng chứng "gọi nhiều thì an toàn".

Biểu đồ trong tab vẽ **cả hai đường cạnh nhau** và nói thẳng cột xanh là ảo giác.
Giấu đi thì sớm muộn cũng có người làm lại phép phân tích ngây thơ này.

Hai loại trừ bắt buộc, bỏ qua là sai kết quả:
- **ngày mà CID đang bị khoá sẵn** — số đang khoá không thể bị khoá thêm nhưng
  vẫn bị quay số (300 cuộc vào số chết), giữ lại sẽ bơm quan sát "gọi nhiều mà
  không bị khoá".
- **ngày không đủ horizon 24h** đến cuối cửa sổ — sẽ đếm thiếu ca bị khoá.

### 4.2. Mô hình chấm điểm rủi ro (B5) — KHÔNG ĐỦ TÍN HIỆU khi gộp account

Nghiên cứu chỉ báo sớm, 1.251 ca vs 7.444 đối chứng, **không chỉ số nào đạt
|d| ≥ 0,5**:

| Chỉ số | Trước block | Đối chứng | Cohen's d |
|---|---|---|---|
| calls | 116,8 | 78,7 | +0,33 |
| distinctDest | 116,3 | 78,6 | +0,33 |
| connectRate | 22,2 | 29,2 | −0,29 |
| shortCallRate | 35,5 | 31,5 | +0,11 |

Hướng đúng như kỳ vọng nhưng hai phân bố chồng nhau quá nhiều để cảnh báo cho
từng số. **Không dựng mô hình chấm điểm trên các biến này** — nó sẽ trông rất
thuyết phục mà sai.

Dùng **Cohen's d** chứ không dùng % chênh: chênh 50% trên một chỉ số nhiễu loạn
vẫn vô dụng, d mới nói được điều đó.

### 4.3. NHƯNG: tách theo account thì tín hiệu quay lại

Đây là ngoại lệ quan trọng của mục 4.2 — **gộp account làm loãng mất tín hiệu**:

| | Ca | Kết luận | Mạnh nhất |
|---|---|---|---|
| Gộp 2 account | 1.251 | ❌ không | `calls` d=0,33 |
| **514** (HNI_TALA2_SIP) | 461 | ✅ **có** | `distinctDest` **d=+1,08** |
| 548 (SIP_MTC_AUTOCALL) | 790 | ❌ không | `connectRate` d=−0,41 |

**Nếu quay lại bài toán cảnh báo sớm, phải làm theo TỪNG ACCOUNT.** Các account
có kiểu quay số khác nhau; gộp lại là triệt tiêu lẫn nhau.

---

## 5. Cần bao nhiêu dữ liệu

**Về thống kê, 5 ngày là thừa đủ** — cả hai account vượt mốc 30 ca từ ngày thứ 3:

| Ngày | SIP_MTC_AUTOCALL | HNI_TALA2_SIP |
|---|---|---|
| 3 | 431 ca | 61 ca |
| 5 | 559 ca | 216 ca |
| 21 | 790 ca | 461 ca |

**Nhưng có hai cái bẫy:**

### Bẫy 1 — ngày lịch ≠ ngày có dữ liệu

```
23/08 CN         62 dòng                ← Chủ nhật gần như bằng 0
29/08 – 02/09    55/26/22/14/17 dòng    ← 5 ngày gián đoạn liên tiếp
03/09 T5     48.780 dòng                ← trở lại bình thường
```

**21 ngày lịch chỉ còn 14 ngày có lưu lượng.** Chọn "5 ngày gần nhất" mà rơi
trúng dải đó thì gần như không còn gì. `countActiveDays` đếm và giao diện liệt kê
các ngày chết.

### Bẫy 2 — cap 50.000 dòng ở luồng chính

Với account lớn, cap mới là thứ chặn thật chứ không phải số ngày:

| Ngày | SIP_MTC_AUTOCALL | Vượt cap? |
|---|---|---|
| 3 | 153.488 dòng | có (×3) |
| 5 | 202.285 dòng | có (×4) |
| 21 | 755.706 dòng | có (×15) |

**Khuyến nghị:** 5 ngày **có lưu lượng**; với account lớn hạ xuống **2–3 ngày**
để nằm trong cap — vẫn thừa mẫu (431 ca ở 3 ngày).

---

## 6. Hiệu năng và quyết định về Web Worker

Đo một lượt vẽ tab đầy đủ:

| | Trước tối ưu | Sau tối ưu |
|---|---|---|
| 50.000 dòng (cap hiện tại) | 646 ms | **389 ms** (−40%) |
| 832.230 dòng (đầy đủ) | 12.142 ms | **7.080 ms** (−42%) |

Ba tối ưu đã làm:
1. **Bỏ mảng `hits`** của `computeRoutingLeaks` — 74.339 phần tử / **19,2 MB** mà
   giao diện không hiển thị phần tử nào. Còn `sampleLimit` để soi vài dòng ví dụ.
2. **`computeDeadNumberLoss` không quét lại CDR** — `computeRoutingLeaks` đã phân
   loại xong và tích luỹ sẵn nhóm nền. Tiết kiệm ~1,6 s.
3. **Dùng chung cửa sổ precursor** giữa `computeBlockPrecursors` và
   `computeBlockSignalPatterns` (`buildPrecursorWindows` + `opts.windows`).

### Quyết định (07/09/2026): TẠM THỜI CHƯA chuyển vào Worker

Lý do: sau tối ưu, ở cap 50.000 dòng chỉ còn 389 ms tính toán — chấp nhận được
cho một thao tác chủ động (mở tab / đổi bộ lọc), không phải thao tác liên tục.

**Khi nào nên quay lại:** nếu cần xem **account lớn ở khoảng dài**. Ở dữ liệu đầy
đủ vẫn là 7 giây — treo cứng luồng UI, không có đường nào khác ngoài worker.

**Cách làm khi quay lại:** thêm message type vào `dashboard-csv-worker.js` theo
đúng khuôn `billing` đang dùng (worker đã giữ sẵn toàn bộ dữ liệu enrich nên
không phát sinh bộ nhớ), và đổi 5 hàm render sang `async`. Chỉ cần đưa thêm log
sự kiện block vào worker: ~1,3 MB, không đáng kể.

---

## 7. Những chỗ dễ sai đã chặn bằng test

| Chỗ | Nếu sai thì sao |
|---|---|
| Khoảng chưa mở lại **không được đóng** ở cuối cửa sổ | Đường khả dụng vọt về 100% đúng điểm cuối, mâu thuẫn với "đang bị khoá" |
| Reactive ghi lặp theo lô **không phải orphan** | Chỉ số orphan bị thổi từ 238 lên 835 |
| Gom routing/account dùng **Map lồng**, không ghép khoá chuỗi | Dữ liệu thật có routing tên `HNI_Duoc Thai Minh_VBN` (có dấu cách) → cắt sai |
| Timeline và CDR phải parse giờ **cùng một hệ** | Lệch múi giờ làm mọi cuộc gọi rơi nhầm nhóm, **không báo lỗi gì** |
| Mốc cửa sổ lấy từ `meta.days`, **không suy từ dữ liệu** | Mẫu số duty cycle co giãn theo dữ liệu, hai lần chạy ra kết quả khác nhau |
| "Mẫu quá nhỏ" phải tách khỏi "đã đo, không thấy gì" | Sinh câu "không chỉ số nào đạt ngưỡng" ngay cạnh bảng đầy chỉ số vượt ngưỡng |
| Đường khả dụng rút gọn bằng hàm **giữ đáy** | `downsampleSeriesMax` sẽ che mất chính các đợt tụt |
| Mẫu số tỷ lệ khả dụng mặc định là **cận dưới** | Log chỉ chứa CID đã từng bị khoá; không nói ra thì con số trông bi quan hơn thực tế |

---

## 8. Ba việc đáng làm nhất (theo thứ tự hành động được)

1. **Cho bộ quay số đọc trạng thái khoá.** 300 cuộc/tuần nã vào số đã chết trên
   một account, 0/300 kết nối. Chặn được ngay.
2. **Xử lý riêng Viettel.** MTTR 21,7h vs MB 7,2h; 559/668 ca chết là VT.
3. **Đừng chốt cứng mốc 24h.** 13,7% ca vẫn quay lại sau đó; mốc 48h giảm còn
   11,6% nhưng không xoá hết.

Ngược lại, hai thứ **không** làm được: dự báo số nào sắp bị khoá (trừ khi tách
theo từng account — xem 4.3), và đặt hạn mức quay số an toàn (xem 4.1).
