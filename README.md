# SysLog AI — AI-Powered System Log Analyzer

แอปพลิเคชัน Electron ที่วิเคราะห์ปัญหาระบบ **Windows และ macOS** ด้วย AI (Gemini, Claude, GPT, DeepSeek, Qwen, Ollama) โดยแจ้งผลในภาษาไทย

## คุณสมบัติ
- เก็บข้อมูลระบบอัตโนมัติแยกตาม Platform (Windows PowerShell / macOS Node collector)
- วิเคราะห์ Log ผ่าน AI หลายผู้ให้บริการ พร้อม Fallback อัตโนมัติ
- UI ภาษาไทย + โหมด Tsundere (可选)
- Export รายงานเป็น JSON

## ข้อกำหนดเบื้องต้น
- Node.js 18+ และ npm
- สำหรับ macOS: Xcode Command Line Tools (`xcode-select --install`)
- API Key ของผู้ให้บริการ AI (ตั้งค่าในหน้า Settings ภายในแอป)

## ติดตั้งและรัน (โหมดพัฒนา)
```bash
npm install
npm start            # หรือ npm run dev เพื่อเปิด DevTools
```

## Build แอปพลิเคชัน

### Windows
```bash
npm run dist:win            # สร้างไฟล์ติดตั้ง NSIS (.exe)
npm run dist:portable       # สร้างเวอร์ชันแบบพกพา (Portable)
```

### macOS
จำเป็นต้องตั้งค่า Environment Variables สำหรับ Notarization ก่อน build:
```bash
export APPLE_ID="you@yourdomain.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # App-specific password จาก appleid.apple.com
export APPLE_TEAM_ID="ABCDE12345"                          # Apple Developer Team ID

npm run dist:mac           # สร้างไฟล์ .dmg และ Notarize อัตโนมัติ
```
> หมายเหตุ: macOS ต้องเปิดการเข้าถึง **Full Disk Access** ให้ Terminal/แอป จึงจะอ่าน Unified Log และ DiagnosticReports ได้เต็มที่ (ตัว collector ออกแบบให้ degrade gracefully หาไม่มีสิทธิ์)

Environment Variables ทั้ง 3 ตัวข้างต้น **ต้องไม่** ฝังลงในโค้ด (electron-builder จะดึงจาก env อัตโนมัติเมื่อ build macOS)

## โครงสร้างโปรเจกต์
```
main.js                      # Electron main process (IPC + platform routing)
renderer.js                  # UI logic
preload.js                   # ContextBridge / IPC
index.html, styles.css       # UI shell
src/collector/
  logCollector.ps1           # Windows collector (แพ็กเฉพาะ Windows build)
  macCollector.js            # macOS collector (แพ็กใน asar)
build/entitlements.mac.plist # macOS hardened-runtime entitlements
package.json                 # build config (win / mac / dmg)
```

## ผู้ให้บริการ AI
ตั้งค่า API Key ได้ในหน้า Settings ของแอป: Gemini, Claude, OpenAI, DeepSeek, Qwen หรือใช้งาน Ollama แบบ Local (`http://localhost:11434`)