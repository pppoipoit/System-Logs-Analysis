const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

// ─── Settings ────────────────────────────────────────────────────────────────
let settingsPath = null
function getSettingsPath() {
  if (!settingsPath) {
    settingsPath = path.join(app.getPath('userData'), 'syslog-ai-settings.json')
  }
  return settingsPath
}

const defaultSettings = {
  firstRun: true,
  aiProvider: 'gemini',
  aiModel: 'gemini-2.5-flash-lite',
  apiKey: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  autoFallback: true
}

function getSettings() {
  try {
    const sp = getSettingsPath()
    if (fs.existsSync(sp)) {
      return { ...defaultSettings, ...JSON.parse(fs.readFileSync(sp, 'utf8')) }
    }
  } catch (e) { /* ignore */ }
  return { ...defaultSettings }
}

function saveSettings(settings) {
  const sp = getSettingsPath()
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2))
}

// ─── Window Icon ──────────────────────────────────────────────────────────────
// Use the real .ico asset (build/icon.ico). When packaged, the icon is copied to
// resources/ as an extraResource so it lives OUTSIDE the asar archive (nativeImage
// cannot reliably read .ico files from inside asar). In dev it sits at build/icon.ico.
function getAppIconPath() {
  try {
    const devPath = path.join(__dirname, 'build', 'icon.ico')
    if (app && !app.isPackaged) return devPath
    return path.join(process.resourcesPath, 'icon.ico')
  } catch {
    return path.join(__dirname, 'build', 'icon.ico')
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0A0E1A',
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  })

  // ── Demo screenshot mode (Phase 6 Step 2 verification) ──
  // With `--demo-sensor --screenshot`, load the verified raw_sensor_dump.json
  // into the dashboard sensor widget and capture a PNG, then quit.
  // IMPORTANT: register the handler BEFORE loadFile so we don't miss dom-ready.
  if (process.argv.includes('--demo-sensor') && process.argv.includes('--screenshot')) {
    const { desktopCapturer, app: _app } = require('electron')
    const dumpPath = path.join(__dirname, 'raw_sensor_dump.json')
    let dump = null
    try { dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8')) } catch {}
    const sensorData = dump ? {
      cpuTemp: dump.cpuPackageTemp,
      cpuTemps: Array.isArray(dump.cpuTemps) ? dump.cpuTemps : null,
      cpuLoad: dump.cpuLoad,
      gpuTemp: dump.gpuTemp,
      fanSpeed: dump.fanSpeeds ? Object.values(dump.fanSpeeds).find(v => typeof v === 'number') || null : null,
      fanSpeeds: dump.fanSpeeds,
      motherboardName: dump.motherboardName,
      motherboardBrand: dump.motherboardBrand,
      chipsetTemp: dump.chipsetTemp,
      isDesktop: true,
      hasBattery: false,
      _adminMode: !!dump.hasAdminAccess,
      _demoSensor: true
    } : null

    fs.writeFileSync(path.join(__dirname, 'screenshot_status.txt'), 'START demo-screenshot block reached')
    win.show()

    // Use did-finish-load instead of dom-ready because dom-ready may fire
    // before the preload script's DOMContentLoaded handler completes.
    win.webContents.once('did-finish-load', async () => {
      // Wait for the renderer's DOMContentLoaded handler to finish init.
      await new Promise(r => setTimeout(r, 2000))
      try {
        await win.webContents.executeJavaScript(`window.__renderDemo(${JSON.stringify(sensorData)})`)
        await new Promise(r => setTimeout(r, 1000))
        const img = await win.webContents.capturePage()
        const out = path.join(__dirname, 'dashboard_demo.png')
        fs.writeFileSync(out, img.toPNG())
        fs.writeFileSync(path.join(__dirname, 'screenshot_status.txt'), 'OK ' + out + ' bytes=' + img.getSize().width + 'x' + img.getSize().height)
      } catch (e) {
        fs.writeFileSync(path.join(__dirname, 'screenshot_status.txt'), 'ERR ' + (e && e.stack || e))
      } finally {
        setTimeout(() => app.quit(), 500)
      }
    })
  }

  win.loadFile('index.html')
  win.once('ready-to-show', () => win.show())

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools()
  }
}

function initApp() {
  getSettingsPath()
  registerIpcHandlers()
  createWindow()
}

function bootstrapApp() {
  const { app: electronApp, BrowserWindow: electronBrowserWindow } = require('electron')
  if (electronApp && typeof electronApp.whenReady === 'function') {
    electronApp.whenReady().then(initApp)
    electronApp.on('window-all-closed', () => { if (process.platform !== 'darwin') electronApp.quit() })
    electronApp.on('activate', () => { if (electronBrowserWindow.getAllWindows().length === 0) createWindow() })
  }
}

bootstrapApp()

function registerIpcHandlers() {
  const { ipcMain, shell, dialog } = require('electron')

  ipcMain.handle('get-settings', () => getSettings())

  ipcMain.handle('get-platform', () => process.platform)

  ipcMain.handle('save-settings', (_, settings) => {
    saveSettings(settings)
    return { success: true }
  })

  ipcMain.handle('open-external', (_, url) => shell.openExternal(url))

  // ─── IPC: Check Ollama ─────────────────────────────────────────────────────
  ipcMain.handle('check-ollama', async () => {
    try {
      const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) })
      const data = await res.json()
      return { running: true, models: (data.models || []).map(m => m.name) }
    } catch {
      return { running: false, models: [] }
    }
  })

  // ─── IPC: Open File Dialog (Log Importer) ────────────────────────────────────
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      title: 'เลือกไฟล์ Log ที่ต้องการนำเข้า',
      properties: ['openFile'],
      filters: [
        { name: 'Log Files', extensions: ['txt', 'log', 'csv', 'dmp', 'evtx', 'json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true }
    }
    const fp = result.filePaths[0]
    try {
      const stat = fs.statSync(fp)
      const MAX = 200 * 1024
      let content = fs.readFileSync(fp, 'utf8')
      let truncated = false
      if (content.length > MAX) {
        content = content.slice(0, MAX)
        truncated = true
      }
      return { canceled: false, path: fp, fileName: path.basename(fp), content, truncated, size: stat.size }
    } catch (e) {
      return { canceled: false, path: fp, error: e.message }
    }
  })

  // ─── IPC: Analyze External Log (Forensic / Diagnostic Specialist) ─────────────
  ipcMain.handle('analyze-external-log', async (_, { logText, fileName, settings }) => {
    const prompt = buildForensicPrompt(logText, fileName, settings)
    try {
      const { aiProvider, aiModel, apiKey, ollamaUrl, ollamaModel } = settings
      let result
      switch (aiProvider) {
        case 'gemini': result = await callGeminiWithFallback(prompt, apiKey, aiModel, settings.autoFallback !== false); break
        case 'claude': result = await callClaude(prompt, apiKey, aiModel); break
        case 'openai': result = await callOpenAI(prompt, apiKey, aiModel); break
        case 'deepseek': result = await callDeepSeek(prompt, apiKey, aiModel); break
        case 'qwen': result = await callQwen(prompt, apiKey, aiModel); break
        case 'ollama': result = await callOllama(prompt, ollamaUrl, ollamaModel); break
        default: throw new Error('Unknown provider: ' + aiProvider)
      }
      return { success: true, data: result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ─── IPC: Fetch Models (Smart API Settings) ─────────────────────────────────
  ipcMain.handle('fetch-models', async (_, { apiKey, provider }) => {
    try {
      let url, options
      const headers = { 'Content-Type': 'application/json' }
      switch (provider) {
        case 'gemini': url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`; options = { method: 'GET', headers, signal: AbortSignal.timeout(10000) }; break
        case 'claude': url = 'https://api.anthropic.com/v1/models'; options = { method: 'GET', headers: { ...headers, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000) }; break
        case 'groq': url = 'https://api.groq.com/openai/v1/models'; options = { method: 'GET', headers: { ...headers, Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) }; break
        case 'openai': url = 'https://api.openai.com/v1/models'; options = { method: 'GET', headers: { ...headers, Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) }; break
        case 'deepseek': url = 'https://api.deepseek.com/v1/models'; options = { method: 'GET', headers: { ...headers, Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) }; break
        case 'qwen': url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/models'; options = { method: 'GET', headers: { ...headers, Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) }; break
        default: return { success: false, error: 'Unknown provider: ' + provider, status: 0 }
      }
      const r = await fetch(url, options)
      const body = await r.text().catch(() => '')
      if (!r.ok) {
        let parsed
        try { parsed = JSON.parse(body) } catch { parsed = {} }
        const err = parsed.error || parsed
        return { success: false, error: (err && err.message) || err.code || body || 'Unknown error', status: r.status }
      }
      let data
      try { data = JSON.parse(body) } catch { data = {} }
      const models = provider === 'gemini'
        ? (data.models || []).map(m => m.name.replace(/^models\//, '')).filter(Boolean)
        : (data.data || []).map(m => m.id || m).filter(Boolean)
      return { success: true, models }
    } catch (e) {
      return { success: false, error: e.message, status: 0 }
    }
  })

  // ─── IPC: Test API Key ───────────────────────────────────────────────────────
  ipcMain.handle('test-api-key', async (_, { provider, apiKey, model }) => {
    try {
      switch (provider) {
        case 'gemini': {
          const selectedModel = normalizeGeminiModel(model || 'gemini-2.5-flash-lite')
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${encodeURIComponent(apiKey)}`
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: 'Say OK in one word.' }] }],
              generationConfig: { maxOutputTokens: 10, temperature: 0 }
            }),
            signal: AbortSignal.timeout(15000)
          })
          const body = await r.text().catch(() => '')
          debugLog('Gemini', endpoint, selectedModel, r.status, body)
          if (!r.ok) {
            const parsed = parseProviderErrorBody(body)
            return { ok: false, status: r.status, body, message: parsed.message || body || 'Unknown error' }
          }
          return { ok: true, status: r.status, model: selectedModel }
        }
        case 'claude': {
          const endpoint = 'https://api.anthropic.com/v1/messages'
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }),
            signal: AbortSignal.timeout(10000)
          })
          const body = await r.text().catch(() => '')
          debugLog('Claude', endpoint, model, r.status, body)
          if (!r.ok) {
            const parsed = parseProviderErrorBody(body)
            return { ok: false, status: r.status, body, message: parsed.message }
          }
          return { ok: true, status: r.status }
        }
        case 'openai':
        case 'deepseek':
        case 'qwen': {
          const endpoints = {
            openai: 'https://api.openai.com/v1/chat/completions',
            deepseek: 'https://api.deepseek.com/v1/chat/completions',
            qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
          }
          const endpoint = endpoints[provider]
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: model || 'gpt-4o-mini', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }),
            signal: AbortSignal.timeout(10000)
          })
          const body = await r.text().catch(() => '')
          debugLog(provider, endpoint, model, r.status, body)
          if (!r.ok) {
            const parsed = parseProviderErrorBody(body)
            return { ok: false, status: r.status, body, message: parsed.message }
          }
          return { ok: r.ok, status: r.status }
        }
        default:
          return { ok: false, status: 0 }
      }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  // ─── IPC: Export Logs ────────────────────────────────────────────────────────
  ipcMain.handle('export-logs', async (_, logsData) => {
    const result = await dialog.showSaveDialog({
      title: 'Export System Logs',
      defaultPath: `syslog-export-${Date.now()}.json`,
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return { success: false, canceled: true }
    try {
      fs.writeFileSync(result.filePath, JSON.stringify(logsData, null, 2), 'utf8')
      return { success: true, path: result.filePath }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ─── IPC: Collect Logs ───────────────────────────────────────────────────────
  ipcMain.handle('collect-logs', async (event) => {
    const platform = process.platform

    if (platform === 'darwin') {
      try {
        const { collectMacLogs } = require('./src/collector/macCollector.js')
        return await collectMacLogs()
      } catch (e) {
        console.error('[macCollector error]', e)
        return {
          error: 'macCollector failed: ' + e.message,
          systemInfo: {
            computerName: os.hostname(),
            os: 'macOS',
            cpu: 'Unknown',
            ramGB: 0,
            freeRamGB: 0,
            freeRamPct: 0,
            lastBoot: '',
            uptime: 0
          },
          systemEvents: [],
          appEvents: [],
          recentUpdates: [],
          networkEvents: [],
          driverEvents: [],
          diskInfo: [],
          crashDumps: { count: 0, recent: [] },
          topProcesses: [],
          sensorData: { cpuTemp: null, gpuTemp: null, fanSpeed: null, batteryHealth: null, loadPercentage: null, isDesktop: null, hasBattery: false }
        }
      }
    }

    if (platform === 'win32') {
      const scriptPath = app.isPackaged
        ? path.join(process.resourcesPath, 'src', 'collector', 'logCollector.ps1')
        : path.join(__dirname, 'src', 'collector', 'logCollector.ps1')

      let logs = await new Promise((resolve) => {
        const ps = spawn('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-NonInteractive',
          '-File', scriptPath
        ])

        let out = ''
        let err = ''

        ps.stdout.on('data', d => { out += d.toString() })
        ps.stderr.on('data', d => { err += d.toString() })

        ps.on('close', () => {
          try {
            const jsonStart = out.indexOf('{"crashDumps"')
            const jsonStr = jsonStart >= 0 ? out.slice(jsonStart) : out
            const parsed = JSON.parse(jsonStr)
            resolve(parsed)
          } catch (e) {
            console.error('[PowerShell parse error] stdout:', out.slice(0, 500), 'stderr:', err.slice(0, 500))
            resolve({
              error: 'Could not parse log output',
              systemInfo: {
                computerName: process.env.COMPUTERNAME || os.hostname() || 'Unknown',
                os: 'Windows',
                cpu: 'Unknown',
                ramGB: 0,
                freeRamGB: 0,
                freeRamPct: 0,
                lastBoot: '',
                uptime: 0
              },
              systemEvents: [],
              appEvents: [],
              recentUpdates: [],
              networkEvents: [],
              driverEvents: [],
              diskInfo: [],
              crashDumps: { count: 0, recent: [] },
              topProcesses: []
            })
          }
        })

        ps.on('error', () => {
          resolve({ error: 'PowerShell not available', systemInfo: {}, systemEvents: [] })
        })
      })

      if (process.argv.includes('--demo-sensor')) {
        try {
          const dumpPath = path.join(__dirname, 'raw_sensor_dump.json')
          if (fs.existsSync(dumpPath)) {
            const d = JSON.parse(fs.readFileSync(dumpPath, 'utf8')) || {}
            const numFans = (d.fanSpeeds && typeof d.fanSpeeds === 'object')
              ? Object.values(d.fanSpeeds).filter(v => typeof v === 'number') : []
            logs.sensorData = {
              cpuTemp: d.cpuPackageTemp != null ? d.cpuPackageTemp : null,
              cpuTemps: Array.isArray(d.cpuTemps) ? d.cpuTemps : null,
              cpuLoad: d.cpuLoad != null ? d.cpuLoad : null,
              gpuTemp: d.gpuTemp != null ? d.gpuTemp : null,
              fanSpeed: numFans.length > 0 ? numFans[0] : null,
              fanSpeeds: (d.fanSpeeds && typeof d.fanSpeeds === 'object') ? d.fanSpeeds : null,
              motherboardName: d.motherboardName != null ? d.motherboardName : null,
              motherboardBrand: d.motherboardBrand != null ? d.motherboardBrand : null,
              chipsetTemp: d.chipsetTemp != null ? d.chipsetTemp : null,
              isDesktop: true,
              hasBattery: false,
              _adminMode: !!d.hasAdminAccess,
              _demoSensor: true
            }
            logs._demoSensor = true
          }
        } catch (demoErr) {
          console.warn('[demo-sensor] load failed:', demoErr)
        }
      } else {
        try {
          const deepSensorScript = app.isPackaged
            ? path.join(process.resourcesPath, 'src', 'collector', 'deepSensor.ps1')
            : path.join(__dirname, 'src', 'collector', 'deepSensor.ps1')
          const dllPath = app.isPackaged
            ? path.join(process.resourcesPath, 'src', 'collector', 'LibreHardwareMonitorLib.dll')
            : path.join(__dirname, 'src', 'collector', 'LibreHardwareMonitorLib.dll')

          const outFile = path.join(os.tmpdir(), `syslog_deep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
          const deepArgs = [
            '-ExecutionPolicy', 'Bypass',
            '-NoProfile',
            '-NonInteractive',
            '-File', deepSensorScript,
            '-DllPath', dllPath,
            '-OutputFile', outFile
          ]

          const deepPs = spawn('powershell.exe', deepArgs)

          let _deepOut = ''
          let _deepErr = ''
          deepPs.stdout.on('data', d => { _deepOut += d.toString('utf8') })
          deepPs.stderr.on('data', d => { _deepErr += d.toString('utf8') })
          deepPs.stdout.on('end', () => { _deepOut = '' })
          deepPs.stderr.on('end', () => { _deepErr = '' })

          await new Promise((deepResolve) => {
            const timer = setTimeout(() => {
              try { deepPs.kill('SIGKILL') } catch {}
              try {
                spawn('powershell.exe', [
                  '-NoProfile', '-NonInteractive', '-Command',
                  "Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*deepSensor.ps1*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
                ]).unref()
              } catch {}
              deepResolve()
            }, 18000)
            deepPs.on('close', () => { clearTimeout(timer); deepResolve() })
            deepPs.on('error', () => { clearTimeout(timer); deepResolve() })
          })

          let deepResult = null
          if (fs.existsSync(outFile)) {
            try {
              const content = fs.readFileSync(outFile, 'utf8')
              const jsonStart = content.indexOf('{')
              const jsonStr = jsonStart >= 0 ? content.slice(jsonStart) : content
              deepResult = JSON.parse(jsonStr)
            } catch {}
            try { fs.unlinkSync(outFile) } catch {}
          }

          if (logs.sensorData) {
            const ds = deepResult || {}
            console.log('[DeepSensor] raw result:', JSON.stringify(ds).slice(0, 200))
            const isRealValue = (v) => v != null && v !== 'Not Supported'
            try {
              if (isRealValue(ds.gpuTemp)) logs.sensorData.gpuTemp = ds.gpuTemp
              if (isRealValue(ds.cpuPackageTemp)) logs.sensorData.cpuTemp = ds.cpuPackageTemp
              if (Array.isArray(ds.cpuTemps) && ds.cpuTemps.length > 0 && !ds.cpuTemps.includes('Not Supported')) logs.sensorData.cpuTemps = ds.cpuTemps
              if (isRealValue(ds.cpuLoad)) logs.sensorData.cpuLoad = ds.cpuLoad
              if (isRealValue(ds.motherboardName)) logs.sensorData.motherboardName = ds.motherboardName
              if (isRealValue(ds.motherboardBrand)) logs.sensorData.motherboardBrand = ds.motherboardBrand
              if (isRealValue(ds.chipsetTemp)) logs.sensorData.chipsetTemp = ds.chipsetTemp
              if (ds.fanSpeeds && typeof ds.fanSpeeds === 'object' && !ds.fanSpeeds.__status) {
                logs.sensorData.fanSpeeds = ds.fanSpeeds
                const fanValues = Object.values(ds.fanSpeeds).filter(v => typeof v === 'number')
                if (fanValues.length > 0) logs.sensorData.fanSpeed = fanValues[0]
              }
            } catch (mergeErr) {
              console.warn('[DeepSensor] merge failed (continuing with partial data):', mergeErr)
            }
            logs.sensorData._adminMode = !!(ds.hasAdminAccess)
            if (!ds.hasAdminAccess) {
              logs.sensorData._adminWarning = deepResult && deepResult.error
                ? deepResult.error
                : 'Limited Sensor Data: Run as Administrator required for full diagnostic.'
            }
            console.log('[DeepSensor] merged sensorData:', JSON.stringify(logs.sensorData).slice(0, 200))
          }
        } catch (e) {
          console.warn('[DeepSensor] Collection failed:', e)
          if (logs.sensorData) {
            logs.sensorData._adminMode = false
            logs.sensorData._adminWarning = 'Limited Sensor Data: Deep sensor collection failed.'
          }
        }
      }

      return logs
    }

    return { error: 'Unsupported platform: ' + platform, systemInfo: {}, systemEvents: [] }
  })

  // ─── IPC: Analyze Logs ───────────────────────────────────────────────────────
  ipcMain.handle('analyze-logs', async (_, { logs, settings }) => {
    const prompt = buildPrompt(logs, settings)
    try {
      const { aiProvider, aiModel, apiKey, ollamaUrl, ollamaModel } = settings
      let result
      switch (aiProvider) {
        case 'gemini': result = await callGeminiWithFallback(prompt, apiKey, aiModel, settings.autoFallback !== false); break
        case 'claude': result = await callClaude(prompt, apiKey, aiModel); break
        case 'openai': result = await callOpenAI(prompt, apiKey, aiModel); break
        case 'deepseek': result = await callDeepSeek(prompt, apiKey, aiModel); break
        case 'qwen': result = await callQwen(prompt, apiKey, aiModel); break
        case 'ollama': result = await callOllama(prompt, ollamaUrl, ollamaModel); break
        default: throw new Error('Unknown provider: ' + aiProvider)
      }
      return { success: true, data: result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })
}

// ─── Debug Logger ─────────────────────────────────────────────────────────────
function debugLog(provider, endpoint, model, status, responseBody) {
  const ts = new Date().toISOString()
  const bodyPreview = typeof responseBody === 'string'
    ? (responseBody.length > 2000 ? responseBody.slice(0, 2000) + '...' : responseBody)
    : JSON.stringify(responseBody).slice(0, 2000)
  console.log(`[${ts}] ${provider} | Endpoint: ${endpoint} | Model: ${model} | HTTP ${status} | Response: ${bodyPreview}`)
}


// ─── Sanitize External Log (remove PII / local paths) ─────────────────────────
function sanitizeLogContent(raw) {
  if (!raw) return ''
  let s = raw
  // Strip common Windows local absolute paths (C:\Users\Name\...) → <PATH>
  s = s.replace(/[A-Za-z]:\\(?:[^\\\s"']+\\)*/g, '<PATH>\\')
  // Strip \\server\share UNC paths
  s = s.replace(/\\\\[^\\\s"']+\\/g, '<UNCPATH>\\')
  // Strip email addresses
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<EMAIL>')
  // Strip IPv4 addresses (keep port numbers context but hide host)
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>')
  // Strip MAC addresses
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '<MAC>')
  // Strip SID-like strings (S-1-5-21-...)
  s = s.replace(/\bS-1-5-21-[\d-]+\b/g, '<SID>')
  // Strip credit-card-ish long digit sequences (16+ digits)
  s = s.replace(/\b\d{13,19}\b/g, '<CARD>')
  return s
}


// ─── Forensic Prompt Builder (External Log Analysis) ──────────────────────────
function buildForensicPrompt(logText, fileName, settings) {
  const isOllama = settings && settings.aiProvider === 'ollama'
  const tsundere = settings && settings.tsundereMode

  let persona = `You are an expert Hardware Forensic & Diagnostic Specialist. A technician has uploaded an external system log file from ANOTHER computer (not this one). Your job is to act as a detective ("โหมดนักสืบ") and diagnose what hardware/software problems the OTHER machine is experiencing. You MUST reply in THAI language (ภาษาไทย) for all text fields.`
  let jsonInstruction = "Respond ONLY with a valid JSON object (no markdown, no explanation outside JSON)."

  if (tsundere) {
    persona = `You are a highly skilled but extremely Tsundere Hardware Forensic Specialist.
You secretly enjoy solving other people's computer mysteries, but you act annoyed that they keep breaking their machines.
Use heavy Tsundere tone in 'summary', 'explanation', and 'recommendations'. Use Thai anime tsundere style.
Example: "ชิ! เครื่องคนอื่นพังอีกแล้วเหรอ? เห็นแก่จะให้ฉันช่วยแก้ให้รอบนี้ก็ได้ล่ะ ย่ะ!"`
    jsonInstruction = `ตอบเป็น JSON object เท่านั้น ภายใน JSON ให้ใช้ภาษาไทยซึนเดเระใน summary, explanation, recommendations. ใช้ภาษาไทย (THAI) เท่านั้น`
  }

  return `${persona}
${jsonInstruction}

IMPORTANT CONTEXT:
- This is an EXTERNAL LOG from a DIFFERENT computer (External Log Analysis mode).
- You are analyzing it as a forensic diagnostic specialist, NOT the owner's personal machine.
- Accuracy depends on log completeness — if the log is incomplete, say so.

UPLOADED FILE NAME: ${fileName || 'unknown'}
LOG CONTENT (already sanitized — PII removed):
---
${logText}
---

Respond with this exact JSON structure:
{
  "confidence": "<HIGH|MEDIUM|LOW> — how confident you are given log completeness",
  "summary": "<2-3 sentence overall diagnosis in THAI>",
  "issues": [
    {
      "id": "<unique-slug>",
      "title": "<issue title in THAI>",
      "severity": "<CRITICAL|HIGH|MEDIUM|LOW>",
      "category": "<DRIVER|HARDWARE|SOFTWARE|NETWORK|PERFORMANCE|SECURITY|STABILITY>",
      "explanation": "<THAI explanation for non-technical users, 2-3 sentences>",
      "rootCause": "<which hardware component is likely at fault, e.g. 'RAM', 'PSU', 'GPU', 'Storage', 'CPU', 'Motherboard' + technical reasoning in THAI>",
      "fixSteps": ["<step 1 in THAI>", "<step 2 in THAI>", "<step 3 in THAI>"],
      "fixDifficulty": "<EASY|MEDIUM|HARD>",
      "relatedEvents": ["<event ID / error code if relevant>"]
    }
  ],
  "recommendations": ["<general recommendation 1 in THAI>", "<recommendation 2 in THAI>"]
}

Important rules:
- ALL output text MUST be in THAI language.
- Order issues by severity (CRITICAL first).
- "rootCause" MUST suggest which physical hardware part is likely responsible (RAM/GPU/PSU/Storage/CPU/Motherboard/etc).
- "fixSteps" should be concrete repair actions (e.g. "Update Driver", "Replace RAM", "Check PSU", "Reinstall OS").
- If the log is too short/incomplete to diagnose, set confidence LOW and say so in summary.`
}






// ─── Prompt Builder ──────────────────────────────────────────────────────────
function buildPrompt(logs, settings) {
  const truncate = (arr, n) => arr ? arr.slice(0, n) : []
  const isOllama = settings && settings.aiProvider === 'ollama'

  // Persona is platform-aware so the AI analyses the correct OS context
  // (Windows vs macOS) instead of assuming Windows every time.
  const osName = process.platform === 'darwin' ? 'macOS' : 'Windows'

  let persona = `You are an expert ${osName} system diagnostic engineer. You MUST reply in THAI language (ภาษาไทย) for all text fields.`
  let jsonInstruction = "Respond ONLY with a valid JSON object (no markdown, no explanation outside JSON)."

  if (settings && settings.tsundereMode) {
    persona = `You are a highly skilled but extremely Tsundere ${osName} system diagnostic engineer. 
You are annoyed that the user keeps breaking their computer and asking for your help, but you still give them excellent advice because you secretly care. 
Use a heavy Tsundere tone in your 'summary', 'explanation', and 'recommendations' fields. Use Thai language in a classic anime tsundere style (like Gemini's tsundere persona). 
Example tone: "นี่นายไปทำอะไรมาอีกเนี่ย! เครื่องถึงได้พังเละเทะขนาดนี้... ชิ! เห็นแก่ที่นายมาขอร้องหรอกนะ ฉันจะบอกวิธีแก้ให้ก็ได้ ทำตามที่บอกเป๊ะๆ ล่ะ ย่ะ!" หรือ "ไม่ได้เป็นห่วงหรอกนะ แค่ทนดูคนใช้คอมไม่เป็นไม่ได้แค่นั้นแหละ!"`
    jsonInstruction = `ตอบเป็น JSON object เท่านั้น ภายใน JSON ให้ใช้ภาษาไทยซึนเดเระใน summary, explanation, และ recommendations. คุณต้องใช้ภาษาไทย (THAI language) เท่านั้นในการตอบ`
  }

  return `${persona} 
${jsonInstruction}

SYSTEM INFO:
${JSON.stringify(logs.systemInfo, null, 2)}

DISK INFO:
${JSON.stringify(logs.diskInfo, null, 2)}

CRASH DUMPS: ${JSON.stringify(logs.crashDumps)}

SYSTEM EVENTS (errors/critical, last 7 days):
${JSON.stringify(truncate(logs.systemEvents, 40), null, 2)}

APP EVENTS:
${JSON.stringify(truncate(logs.appEvents, 20), null, 2)}

RECENT ${osName.toUpperCase()} UPDATES:
${JSON.stringify(logs.recentUpdates, null, 2)}

NETWORK EVENTS:
${JSON.stringify(truncate(logs.networkEvents, 20), null, 2)}

DRIVER EVENTS:
${JSON.stringify(truncate(logs.driverEvents, 15), null, 2)}

TOP PROCESSES:
${JSON.stringify(truncate(logs.topProcesses, 10), null, 2)}

HARDWARE SENSOR DATA (cpuTemp/gpuTemp in °C, fanSpeed in RPM, batteryHealth as % or status, loadPercentage 0-100; null = sensor unavailable without admin):
${JSON.stringify(logs.sensorData, null, 2)}
${logs.sensorData && logs.sensorData._adminWarning ? `\nIMPORTANT: ${logs.sensorData._adminWarning}` : (logs.sensorData && logs.sensorData._adminMode ? '\nNOTE: Deep sensor data obtained via administrator (LibreHardwareMonitor) — values are hardware-accurate.' : '')}

Respond with this exact JSON structure:
{
  "healthScore": <0-100>,
  "summary": "<2-3 sentence overall health summary in THAI>",
  "issues": [
    {
      "id": "<unique-slug>",
      "title": "<short issue title in THAI>",
      "severity": "<CRITICAL|HIGH|MEDIUM|LOW>",
      "category": "<DRIVER|HARDWARE|SOFTWARE|NETWORK|PERFORMANCE|SECURITY|STABILITY>",
      "explanation": "<THAI explanation, suitable for non-technical users, 2-3 sentences. If tsundereMode is enabled, use tsundere tone here.>",
      "rootCause": "<technical root cause analysis in THAI>",
      "fixSteps": ["<step 1 in THAI>", "<step 2 in THAI>", "<step 3 in THAI>"],
      "fixDifficulty": "<EASY|MEDIUM|HARD>",
      "relatedEvents": ["<event ID or KB number if relevant>"]
    }
  ],
  "recommendations": ["<general recommendation 1 in THAI>", "<recommendation 2 in THAI>", "<recommendation 3 in THAI>"]
}

Important rules:
- ALL output text (title, summary, explanation, rootCause, fixSteps, recommendations) MUST be in THAI language (ภาษาไทย).
- If no real issues found, return empty issues array and healthScore 90-100
- Order issues by severity (CRITICAL first)
- fixSteps must be actionable and specific
- explanation must be in simple language, no jargon`
}

// ─── AI Providers ─────────────────────────────────────────────────────────────
function extractJSON(text) {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('No JSON found in response')
  return JSON.parse(m[0])
}

function normalizeGeminiModel(model) {
  return String(model || '').replace(/^models\//, '')
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))]
}

// Centralized Gemini model priority list — updated for latest Google AI Studio API
// Ordered by preference (cheapest/fastest first). Add new models here for future updates.
const GEMINI_MODELS_PREFERRED = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite-001',
  'gemini-1.5-flash'
]

function geminiFallbackModels(model) {
  return uniqueValues([
    normalizeGeminiModel(model),
    ...GEMINI_MODELS_PREFERRED
  ])
}

function parseProviderErrorBody(body) {
  try {
    const parsed = JSON.parse(body)
    const err = parsed.error || parsed
    return {
      code: err.code,
      status: err.status,
      message: err.message || body
    }
  } catch {
    return { message: body || 'Unknown provider error' }
  }
}

function providerErrorMessage(provider, status, body) {
  const parsed = parseProviderErrorBody(body)
  const details = parsed.message ? `: ${parsed.message}` : ''
  if (status === 429) {
    return `${provider} 429 RESOURCE_EXHAUSTED${details}. This can be requests-per-minute, tokens-per-minute, daily quota, spend limit, or a free-tier/project limit. Try again later, use a lighter model (e.g. gemini-2.5-flash-lite), or enable billing/check quota in Google AI Studio (https://aistudio.google.com/apikey).`
  }
  if (status === 400 && parsed.status === 'FAILED_PRECONDITION') {
    return `${provider} 400 FAILED_PRECONDITION${details}. The free tier is not available for this project/region, or this model requires billing. Enable billing in Google AI Studio (https://aistudio.google.com) or try a different model (e.g. gemini-2.5-flash-lite which has free tier access). You can also use a local Ollama provider as an alternative.`
  }
  if (status === 403) {
    return `${provider} 403 PERMISSION_DENIED${details}. Check that this API key is active and has the Gemini API enabled. If you just created the key, wait a few minutes for it to propagate. Visit https://aistudio.google.com/apikey to verify your key status.`
  }
  if (status === 404) {
    return `${provider} 404 NOT_FOUND${details}. The selected model may not be available for this key or API version. Try a different model (e.g. gemini-2.5-flash-lite is widely available on free tier).`
  }
  if (status === 500 || status === 503) {
    return `${provider} ${status} SERVICE_UNAVAILABLE${details}. Google AI servers may be experiencing high load. Please try again in a few moments.`
  }
  return `${provider} ${status}${details}`
}

async function callGeminiWithFallback(prompt, apiKey, model = 'gemini-2.5-flash-lite', autoFallback = true) {
  const models = autoFallback ? geminiFallbackModels(model) : [normalizeGeminiModel(model)]
  const errors = []

  for (const candidate of models) {
    try {
      return await callGemini(prompt, apiKey, candidate)
    } catch (e) {
      errors.push(`${candidate}: ${e.message}`)
      if (!autoFallback) break
      // On 429 (quota/rate limit), continue to try lighter models
      if (/Gemini 429/.test(e.message)) {
        if (candidate !== 'gemini-2.5-flash-lite' && models.includes('gemini-2.5-flash-lite')) continue
        break
      }
      // On server errors (5xx) or 404 (model unavailable), try next model
      if (!/Gemini (404|500|503|504)/.test(e.message)) break
    }
  }

  throw new Error(errors.join('\n'))
}

async function callGemini(prompt, apiKey, model = 'gemini-2.5-flash-lite') {
  const selectedModel = normalizeGeminiModel(model)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${encodeURIComponent(apiKey)}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    }),
    signal: AbortSignal.timeout(120000)
  })
  const body = await r.text().catch(() => '')
  debugLog('Gemini', url, selectedModel, r.status, body)

  if (!r.ok) {
    throw new Error(providerErrorMessage('Gemini', r.status, body))
  }
  const d = JSON.parse(body || '{}')
  return JSON.parse(d.candidates?.[0]?.content?.parts?.[0]?.text || '{}')
}

async function callClaude(prompt, apiKey, model = 'claude-sonnet-4-20250514') {
  const url = 'https://api.anthropic.com/v1/messages'
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000)
  })
  const body = await r.text().catch(() => '')
  debugLog('Claude', url, model, r.status, body)
  if (!r.ok) {
    const parsed = parseProviderErrorBody(body)
    throw new Error(`Claude ${r.status}: ${parsed.message || body}`)
  }
  const d = JSON.parse(body || '{}')
  return extractJSON(d.content?.[0]?.text || '{}')
}

async function callOpenAI(prompt, apiKey, model = 'gpt-4o') {
  const url = 'https://api.openai.com/v1/chat/completions'
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.1 }),
    signal: AbortSignal.timeout(120000)
  })
  const body = await r.text().catch(() => '')
  debugLog('OpenAI', url, model, r.status, body)
  if (!r.ok) {
    const parsed = parseProviderErrorBody(body)
    throw new Error(`OpenAI ${r.status}: ${parsed.message || body}`)
  }
  const d = JSON.parse(body || '{}')
  return JSON.parse(d.choices?.[0]?.message?.content || '{}')
}

async function callDeepSeek(prompt, apiKey, model = 'deepseek-chat') {
  const url = 'https://api.deepseek.com/v1/chat/completions'
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.1 }),
    signal: AbortSignal.timeout(120000)
  })
  const body = await r.text().catch(() => '')
  debugLog('DeepSeek', url, model, r.status, body)
  if (!r.ok) {
    const parsed = parseProviderErrorBody(body)
    throw new Error(`DeepSeek ${r.status}: ${parsed.message || body}`)
  }
  const d = JSON.parse(body || '{}')
  return JSON.parse(d.choices?.[0]?.message?.content || '{}')
}

async function callQwen(prompt, apiKey, model = 'qwen-max') {
  const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(120000)
  })
  const body = await r.text().catch(() => '')
  debugLog('Qwen', url, model, r.status, body)
  if (!r.ok) {
    const parsed = parseProviderErrorBody(body)
    throw new Error(`Qwen ${r.status}: ${parsed.message || body}`)
  }
  const d = JSON.parse(body || '{}')
  return JSON.parse(d.choices?.[0]?.message?.content || '{}')
}

async function callOllama(prompt, baseUrl = 'http://localhost:11434', model = 'llama3.2') {
  const url = `${baseUrl}/api/generate`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, format: 'json', stream: false, options: { temperature: 0.1 } }),
    signal: AbortSignal.timeout(180000)
  })
  const body = await r.text().catch(() => '')
  debugLog('Ollama', url, model, r.status, body)
  if (!r.ok) {
    const parsed = parseProviderErrorBody(body)
    throw new Error(`Ollama ${r.status}: ${parsed.message || body}`)
  }
  const d = JSON.parse(body || '{}')
  return JSON.parse(d.response || '{}')
}