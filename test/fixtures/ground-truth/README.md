# Ground-truth fixtures

วางไฟล์ JSON ที่ตรวจข้อความและเวลาแล้วในโฟลเดอร์นี้ แล้วรัน `npm run test:quality` แต่ละไฟล์ใช้รูปแบบ:

```json
{
  "language": "th",
  "reference": { "text": "ข้อความจริง", "words": [{ "text": "ข้อความ", "start": 0.2, "end": 0.6 }] },
  "baseline": { "text": "ผลระบบเดิม", "words": [] },
  "candidate": { "text": "ผลระบบใหม่", "words": [{ "text": "ข้อความ", "start": 0.22, "end": 0.61 }] },
  "speechRegions": [{ "start": 0.1, "end": 0.8 }]
}
```

ห้ามใช้ผล Whisper เป็น reference; ต้องฟังและตรวจโดยคนเพื่อให้ WER และ boundary error มีความหมาย
