# 🚀 SysLog AI v1.0.0

**AI-Powered Windows System Log Analyzer**  
วิเคราะห์ปัญหาระบบ Windows ด้วย AI — รองรับ Gemini, Claude, GPT, DeepSeek, Qwen, Ollama

---

## ✨ ฟีเจอร์หลัก

- 🔍 **เก็บ Logs อัตโนมัติ** — Windows Event Logs, Crash Dumps, Driver Info, Network Events, Disk Usage, Processes
- 🤖 **AI วิเคราะห์ปัญหา** — รองรับ AI 6 ค่าย (Gemini, Claude, GPT, DeepSeek, Qwen, Ollama)
- 🎯 **เจอปัญหาอัตโนมัติ** — วิเคราะห์ correlation ระหว่าง events หลายจุด
- 🏥 **Health Score** — ให้คะแนนสุขภาพระบบ 0-100 พร้อมคำอธิบาย
- 🛠️ **บอกวิธีแก้** — แต่ละปัญหามี fix steps ทีละขั้นตอน
- 📋 **Export Logs** — ส่งออกเป็นไฟล์ JSON
- 🕒 **ประวัติ** — เก็บผลวิเคราะห์ย้อนหลัง 20 ครั้ง
- 🌐 **ภาษาไทย** — ผลลัพธ์เป็นภาษาไทยทั้งหมด
- 😏 **Tsundere Mode** — โหมดซึนเดเระ (secret mode)

## 🔧 การเปลี่ยนแปลงในเวอร์ชันนี้

### API & Backend
- **อัปเดต Google Gemini Model IDs** — ใช้รุ่นล่าสุด `gemini-2.5-flash-lite`, `gemini-2.5-flash`, `gemini-2.0-flash-001`
- **เพิ่ม Debug Logging** — ทุก Provider มี Log: Provider, Endpoint, Model ID, HTTP Status, Response Body
- **ปรับปรุง Error Messages** — แต่ละ HTTP status มีคำแนะนำเฉพาะ (quota หมด, free tier, permission, model ไม่พร้อม)
- **Fallback อัตโนมัติ** — ถ้า model แรกใช้ไม่ได้ จะลองไล่จาก `gemini-2.5-flash-lite` → `gemini-1.5-flash`
- **API Key Test ตรงจุดขึ้น** — ทดสอบแบบ `generateContent` จริง แทนแค่เรียก list models

### Bug Fixes
- **JSON Parsing {GUID} Bug** — แก้ไขแล้ว! Event messages ที่มี GUID เช่น `{E60687F7-...}` ทำให้ parse JSON ล้มเหลว
- **PowerShell Log Collector** — เพิ่ม fallback `Get-WmiObject` เมื่อ `Get-CimInstance` ใช้ไม่ได้
- **Electron Builder Integration** — ย้าย `electron` ไป `devDependencies`

### UI / UX
- **อัปเดต Model List** — เพิ่ม `gemini-2.5-flash-lite`, `gemini-2.5-flash` พร้อมป้ายแนะนำ
- **Model List แบบ Centralized** — เพิ่ม model ใหม่ในอนาคตง่ายขึ้น

### DevOps
- **Electron Builder** — พร้อม build Windows Installer (.exe)
- **GitHub Ready** — `.gitignore` อัปเดต, `package-lock.json` ถูก commit เพื่อ reproducible builds

---

## 📥 ดาวน์โหลด

| แพลตฟอร์ม | ไฟล์ | ขนาด |
|-----------|------|------|
| Windows (Installer) | `SysLog AI-Setup-1.0.0.exe` | ~82 MB |
| Windows (Portable) | `SysLog AI-1.0.0-portable.exe` | ~82 MB |

> หมายเหตุ: ต้องมี API Key จาก Google AI Studio (ฟรี) หรือ provider อื่นๆ

---

## 🚀 วิธีเริ่มต้นใช้งาน

1. ดาวน์โหลด Installer และติดตั้ง
2. ไปที่ https://aistudio.google.com/apikey ขอ API Key ฟรี
3. เปิดแอป → Settings → ใส่ API Key → Test → Save
4. กด **Scan & Analyze** เริ่มวิเคราะห์ระบบ!

---

## 🛠️ Developer Build

```bash
git clone https://github.com/pppoipoit/System-Logs-Analysis.git
cd System-Logs-Analysis
npm install
npm run dev        # รันพร้อม DevTools
npm run dist       # Build Installer
npm run dist:portable  # Build Portable
```

---

## 🤝 รองรับ AI Providers

| Provider | API Key | Free Tier |
|----------|---------|-----------|
| 🇺🇸 Google Gemini | AIza... / AQ... | ✅ มี |  
| 🇺🇸 Anthropic Claude | sk-ant-... | ✅ มี (credits) |
| 🇺🇸 OpenAI GPT | sk-... | ❌ |
| 🇨🇳 DeepSeek | sk-... | ✅ มี |
| 🇨🇳 Alibaba Qwen | sk-... | ✅ มี |
| 🖥️ Ollama (Local) | ไม่ต้องใช้ key | ✅ 100% ฟรี |

---

## 📝 License

MIT License — ทำอะไรก็ได้ตามใจชอบ

---

สร้างด้วย ❤️ โดย [pppoipoit](https://github.com/pppoipoit)