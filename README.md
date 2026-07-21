# SubLabs Local

แอปใส่ซับวิดีโอแบบ local สำหรับ Windows: Whisper Large V3 Turbo Q8, Silero VAD, DTW word timestamps, Thai word segmentation, waveform timeline, typography inspector, SRT และ MP4 burn-in

## ติดตั้งและเปิดใช้งาน

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts\setup-models.ps1
npm start
```

เปิด <http://127.0.0.1:4173> แอป bind เฉพาะเครื่องนี้และเก็บโปรเจกต์ใน `data/sublabs.db`

## การถอดเสียง

- ค่าเริ่มต้น: `large-v3-turbo-q8_0`, beam search 5 และ DTW `large.v3.turbo`
- ใช้ Silero VAD แยก speech regions แล้วกรองคำที่อยู่ในช่วงเงียบ โดยไม่อัด timeline ของ DTW
- ใช้ CUDA เมื่อเปิดได้จริง และ fallback CPU อัตโนมัติเมื่อ CUDA ล้มเหลว
- เลือกได้ระหว่าง Accurate GPU (Q8), Balanced Auto (Q5) และ Fast CPU (Q5); ระบบแสดงโหมดจริงและเวลาประมาณระหว่างทำงาน
- โมเดลโหลดค้างใน `whisper-server` และรองรับ glossary สำหรับชื่อคน แบรนด์ และภาษาถิ่น
- คำที่เสี่ยงจะแสดงป้าย “ควรตรวจ” แทนเปอร์เซ็นต์ confidence ที่ยังไม่ได้สอบเทียบ

## Editor และการส่งออก

- Waveform สร้างและ cache ฝั่งเซิร์ฟเวอร์ จึงไม่โหลดวิดีโอทั้งไฟล์เข้า `AudioContext`
- Timeline รองรับเลือกหลายคำ, nudge 10/50 ms, split/merge, snap และ zoom-to-fit
- มีคิวคำที่ควรตรวจพร้อมวนฟัง 0.75×/1×, อนุมัติคำ และเก็บสถานะข้ามการเปิดโปรเจกต์
- ลากเลือกช่วงเพื่อถอดเสียงใหม่และเปรียบเทียบก่อนใช้ โดยไม่เปลี่ยน ID/เวลาของคำภายนอกช่วง
- จัด caption อัตโนมัติตามช่วงเงียบ ความเร็วอ่าน และสองบรรทัด พร้อมนำเข้า SRT/VTT และเลื่อนเวลาทั้งโปรเจกต์
- Render MP4 เป็น background job มี progress, cancel และดาวน์โหลดเมื่อเสร็จ
- โหมดทำซับรองรับ Crop วิดีโอเป็นต้นฉบับ, Free Crop, 9:16, 1:1, 4:5 หรือ 16:9 พร้อมเลื่อนจุดโฟกัสหรือตัดขอบอิสระ โดย Preview เปลี่ยนทันทีและ MP4 ใช้กรอบเดียวกัน
- เปิดโปรเจกต์ล่าสุดได้จากหน้าแรก และนำเข้าฟอนต์ `.ttf/.otf` สำหรับ preview/render local ได้

## โหมดทำเสียงพากย์

- เลือก workspace `ทำซับ` หรือ `ทำเสียง` จากหน้าแรกก่อนเปิดวิดีโอ โดยข้อมูลสองโหมดไม่แก้ไขกัน
- โหมดทำเสียงไม่ต้องมีซับ: ลากเลือกช่วงบน waveform, พิมพ์บท, เลือกเสียง/อารมณ์ แล้วสร้างเสียงลง Dub Timeline
- คลังเสียงใช้ reference audio 5–10 วินาทีพร้อมข้อความที่พูดตรงกัน และเพิ่มหลายอารมณ์ให้ตัวละครเดียวกันได้
- อัด reference voice จากไมโครโฟนในแอป มีบทสุ่มตามอารมณ์ให้อ่าน ฟังตัวอย่าง และบันทึกรูปแบบการพูดเข้าคลังได้โดยไม่ต้องเตรียมไฟล์
- แต่ละบทสร้างเสียงให้เปรียบเทียบ 3 Take และเลือก Take ที่จะใช้ได้ พร้อมพจนานุกรมคำอ่านไทย/อังกฤษ การแปลงตัวเลขเป็นคำอ่าน และการตั้งความเร็ว/ช่วงพักก่อน–หลังรายคลิป
- Preview ใช้ Web Audio เล่นเสียงพากย์ตาม video timeline และลดเสียงต้นฉบับระหว่างมีบทพากย์
- Render วิดีโอพากย์เป็น MP4 โดยไม่ burn-in ซับ และไม่อนุญาตช่วงเสียงซ้อนหรือเสียงที่ยาวเกินช่วง

ติดตั้งระบบสร้างเสียง local แยกจาก Python หลัก:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-tts.ps1
```

โมเดลจะดาวน์โหลดเมื่อสร้างเสียงครั้งแรกและทำงาน offline หลังดาวน์โหลดครบ เครื่องจะลองใช้ CUDA ก่อนแล้ว fallback CPU อัตโนมัติ โค้ด ThonburianTTS เป็น MIT แต่โมเดลใช้สัญญาอนุญาต `CC BY-NC-SA 4.0` จึงกำหนดโหมดนี้สำหรับการใช้งานส่วนตัวที่ไม่ใช่เชิงพาณิชย์

## การทดสอบ

```powershell
npm test
npm run test:quality
```

`npm run test:quality` ต้องมี ground-truth JSON ที่ตรวจโดยคนใน `test/fixtures/ground-truth` ห้ามใช้ผล Whisper เป็น reference
