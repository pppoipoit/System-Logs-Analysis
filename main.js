const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

// ─── Settings ────────────────────────────────────────────────────────────────
const settingsPath = path.join(app.getPath('userData'), 'syslog-ai-settings.json')

const defaultSettings = {
  firstRun: true,
  aiProvider: 'gemini',
  aiModel: 'gemini-1.5-flash',
  apiKey: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  autoFallback: true
}

function getSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }
    }
  } catch (e) { /* ignore */ }
  return { ...defaultSettings }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0A0E1A',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  })

  win.loadFile('index.html')
  win.once('ready-to-show', () => win.show())

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools()
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ─── IPC: Settings ────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => getSettings())

ipcMain.handle('save-settings', (_, settings) => {
  saveSettings(settings)
  return { success: true }
})

ipcMain.handle('open-external', (_, url) => shell.openExternal(url))

// ─── IPC: Check Ollama ───────────────────────────────────────────────────────
ipcMain.handle('check-ollama', async () => {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) })
    const data = await res.json()
    return { running: true, models: (data.models || []).map(m => m.name) }
  } catch {
    return { running: false, models: [] }
  }
})

// ─── IPC: Test API Key ───────────────────────────────────────────────────────
ipcMain.handle('test-api-key', async (_, { provider, apiKey, model }) => {
  try {
    switch (provider) {
      case 'gemini': {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
        const body = await r.text().catch(() => '')
        if (!r.ok) {
          const parsed = parseProviderErrorBody(body)
          return { ok: false, status: r.status, body, message: parsed.message }
        }

        const data = JSON.parse(body || '{}')
        const selectedModel = normalizeGeminiModel(model)
        const models = data.models || []
        const found = models.find(item =>
          normalizeGeminiModel(item.name) === selectedModel &&
          (item.supportedGenerationMethods || []).includes('generateContent')
        )

        if (found) return { ok: true, status: r.status, model: selectedModel }

        const available = models
          .filter(item => (item.supportedGenerationMethods || []).includes('generateContent'))
          .map(item => normalizeGeminiModel(item.name))
          .slice(0, 8)

        return {
          ok: false,
          status: 404,
          body: `Model "${selectedModel}" is not available for this API key. Available: ${available.join(', ')}`,
          message: `Model "${selectedModel}" is not available for this API key.`
        }
      }
      case 'claude': {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }),
          signal: AbortSignal.timeout(10000)
        })
        return { ok: r.ok, status: r.status }
      }
      case 'openai':
      case 'deepseek':
      case 'qwen': {
        const endpoints = {
          openai: 'https://api.openai.com/v1/chat/completions',
          deepseek: 'https://api.deepseek.com/v1/chat/completions',
          qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
        }
        const r = await fetch(endpoints[provider], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }),
          signal: AbortSignal.timeout(10000)
        })
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
  const { dialog } = require('electron')
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
  const scriptPath = path.join(__dirname, 'src', 'collector', 'logCollector.ps1')

  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-NonInteractive',
      '-File', scriptPath
    ])

    let out = ''
    let err = ''

    ps.stdout.on('data', d => { out += d.toString() })
    ps.stderr.on('data', d => { err += d.toString() })

    ps.on('close', () => {
      try {
        // Find the JSON object in output (skip any progress messages)
        const jsonStart = out.lastIndexOf('{')
        const jsonStr = jsonStart >= 0 ? out.slice(jsonStart) : out
        resolve(JSON.parse(jsonStr))
      } catch {
        resolve({
          error: 'Could not parse log output',
          systemInfo: {
            computerName: process.env.COMPUTERNAME || 'Unknown',
            os: 'Windows',
            cpu: 'Unknown',
            ramGB: 0,
            freeRamGB: 0,
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

// ─── Prompt Builder ──────────────────────────────────────────────────────────
function buildPrompt(logs, settings) {
  const truncate = (arr, n) => arr ? arr.slice(0, n) : []
  const isOllama = settings && settings.aiProvider === 'ollama'

  let persona = "You are an expert Windows system diagnostic engineer."
  let jsonInstruction = "Respond ONLY with a valid JSON object (no markdown, no explanation outside JSON)."

  if (settings && settings.tsundereMode) {
    persona = `You are a highly skilled but extremely Tsundere Windows system diagnostic engineer. 
You are annoyed that the user keeps breaking their computer and asking for your help, but you still give them excellent advice because you secretly care. 
Use a heavy Tsundere tone in your 'summary', 'explanation', and 'recommendations' fields. Use Thai language in a classic anime tsundere style (like Gemini's tsundere persona). 
Example tone: "นี่นายไปทำอะไรมาอีกเนี่ย! เครื่องถึงได้พังเละเทะขนาดนี้... ชิ! เห็นแก่ที่นายมาขอร้องหรอกนะ ฉันจะบอกวิธีแก้ให้ก็ได้ ทำตามที่บอกเป๊ะๆ ล่ะ ย่ะ!" หรือ "ไม่ได้เป็นห่วงหรอกนะ แค่ทนดูคนใช้คอมไม่เป็นไม่ได้แค่นั้นแหละ!"`
    jsonInstruction = `ตอบเป็น JSON object เท่านั้น ภายใน JSON ให้ใช้ภาษาไทยซึนเดเระใน summary, explanation, และ recommendations`
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

RECENT WINDOWS UPDATES:
${JSON.stringify(logs.recentUpdates, null, 2)}

NETWORK EVENTS:
${JSON.stringify(truncate(logs.networkEvents, 20), null, 2)}

DRIVER EVENTS:
${JSON.stringify(truncate(logs.driverEvents, 15), null, 2)}

TOP PROCESSES:
${JSON.stringify(truncate(logs.topProcesses, 10), null, 2)}

Respond with this exact JSON structure:
{
  "healthScore": <0-100>,
  "summary": "<2-3 sentence overall health summary in plain English>",
  "issues": [
    {
      "id": "<unique-slug>",
      "title": "<short issue title>",
      "severity": "<CRITICAL|HIGH|MEDIUM|LOW>",
      "category": "<DRIVER|HARDWARE|SOFTWARE|NETWORK|PERFORMANCE|SECURITY|STABILITY>",
      "explanation": "<plain English explanation, suitable for non-technical users, 2-3 sentences>",
      "rootCause": "<technical root cause analysis>",
      "fixSteps": ["<step 1>", "<step 2>", "<step 3>"],
      "fixDifficulty": "<EASY|MEDIUM|HARD>",
      "relatedEvents": ["<event ID or KB number if relevant>"]
    }
  ],
  "recommendations": ["<general recommendation 1>", "<recommendation 2>", "<recommendation 3>"]
}

Important rules:
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

function geminiFallbackModels(model) {
  return uniqueValues([
    normalizeGeminiModel(model),
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
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
    return `${provider} 429 RESOURCE_EXHAUSTED${details}. This can be requests-per-minute, tokens-per-minute, daily quota, spend limit, or a free-tier/project limit. Try again later, use a lighter model, or enable billing/check quota in Google AI Studio.`
  }
  if (status === 400 && parsed.status === 'FAILED_PRECONDITION') {
    return `${provider} 400 FAILED_PRECONDITION${details}. The free tier may not be available for this project/region; enable billing in AI Studio or use another provider/local Ollama.`
  }
  if (status === 403) {
    return `${provider} 403 PERMISSION_DENIED${details}. Check that this API key is active and allowed to use the Gemini API.`
  }
  if (status === 404) {
    return `${provider} 404 NOT_FOUND${details}. The selected model may not be available for this key or API version.`
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
      if (/Gemini 429/.test(e.message)) {
        if (candidate !== 'gemini-2.5-flash-lite' && models.includes('gemini-2.5-flash-lite')) continue
        break
      }
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
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(providerErrorMessage('Gemini', r.status, body))
  }
  const d = await r.json()
  return JSON.parse(d.candidates?.[0]?.content?.parts?.[0]?.text || '{}')
}

async function callClaude(prompt, apiKey, model = 'claude-sonnet-4-5') {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000)
  })
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`)
  const d = await r.json()
  return extractJSON(d.content?.[0]?.text || '{}')
}

async function callOpenAI(prompt, apiKey, model = 'gpt-4o') {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.1 }),
    signal: AbortSignal.timeout(120000)
  })
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`)
  const d = await r.json()
  return JSON.parse(d.choices?.[0]?.message?.content || '{}')
}

async function callDeepSeek(prompt, apiKey, model = 'deepseek-chat') {
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.1 }),
    signal: AbortSignal.timeout(120000)
  })
  if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${await r.text()}`)
  const d = await r.json()
  return JSON.parse(d.choices?.[0]?.message?.content || '{}')
}

async function callQwen(prompt, apiKey, model = 'qwen-max') {
  const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(120000)
  })
  if (!r.ok) throw new Error(`Qwen ${r.status}: ${await r.text()}`)
  const d = await r.json()
  return JSON.parse(d.choices?.[0]?.message?.content || '{}')
}

async function callOllama(prompt, baseUrl = 'http://localhost:11434', model = 'llama3.2') {
  const r = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, format: 'json', stream: false, options: { temperature: 0.1 } }),
    signal: AbortSignal.timeout(180000)
  })
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`)
  const d = await r.json()
  return JSON.parse(d.response || '{}')
}
