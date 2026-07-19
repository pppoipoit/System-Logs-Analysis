/* ════════════════════════════════════════════════════════════
   SysLog AI — Renderer (UI Logic)
   ════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  settings: null,
  lastLogs: null,
  lastResults: null,
  history: [],
  currentFilter: 'all',
  platform: 'win32',
  tips: getTips('win32')
}

// ── Model Lists ────────────────────────────────────────────────────────────
const MODELS = {
  gemini: [
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (แนะนำ - เร็วและประหยัด)' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (สมดุล)' },
    { value: 'gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-2.0-flash-lite-001', label: 'Gemini 2.0 Flash Lite' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (รุ่นเก่า)' },
  ],
  claude: [
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (เร็ว)' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o (แนะนำ)' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini (ถูกกว่า)' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  deepseek: [
    { value: 'deepseek-chat', label: 'DeepSeek V3' },
    { value: 'deepseek-reasoner', label: 'DeepSeek R1 (Reasoning)' },
  ],
  qwen: [
    { value: 'qwen-max', label: 'Qwen Max (แนะนำ)' },
    { value: 'qwen-plus', label: 'Qwen Plus' },
    { value: 'qwen-turbo', label: 'Qwen Turbo (เร็ว)' },
  ],
  groq: [
    { value: 'llama3-8b-8192', label: 'Llama 3 8B' },
    { value: 'llama3-70b-8192', label: 'Llama 3 70B' },
    { value: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
    { value: 'gemma2-9b-it', label: 'Gemma 2 9B' },
  ],
  ollama: []
}

const API_KEY_LINKS = {
  gemini: 'https://aistudio.google.com/apikey',
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  qwen: 'https://dashscope.aliyuncs.com/',
}

// Tips are platform-aware: macOS uses "macOS System Update" / "Kernel Panic"
// instead of the Windows-specific "Windows Update" / "BSOD".
function getTips(platform) {
  const isMac = platform === 'darwin'
  const updateTerm = isMac ? 'macOS System Update' : 'Windows Update'
  const crashTerm = isMac ? 'Kernel Panic' : 'BSOD'
  return [
    'AI จะวิเคราะห์ correlation ระหว่าง events หลายจุดพร้อมกัน',
    'Event logs จาก 7 วันล่าสุดถูกนำมาวิเคราะห์เพื่อหา pattern',
    `AI สามารถตรวจจับความสัมพันธ์ระหว่าง ${updateTerm} กับปัญหาที่เกิดขึ้น`,
    'ข้อมูล Driver และ Network events ช่วยระบุสาเหตุที่ซ่อนอยู่',
    `Crash dump ให้ข้อมูลที่ละเอียดมากสำหรับการวิเคราะห์ ${crashTerm}`,
  ]
}

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  loadHistory()
  state.settings = await window.electronAPI.getSettings()
  state.platform = await window.electronAPI.getPlatform()
  state.tips = getTips(state.platform)

  if (state.settings.firstRun) {
    hideSidebar()
    navigateTo('setup', false)
    setupWizardInit()
  } else {
    showSidebar()
    navigateTo('dashboard', false)
    updateAIStatus()
    startSensorPolling()
  }
})

function hideSidebar() { document.getElementById('sidebar').style.display = 'none' }
function showSidebar() { document.getElementById('sidebar').style.display = '' }

// ── Navigation ────────────────────────────────────────────────────────────
function navigateTo(page, updateNav = true) {
  // Stop live sensor polling whenever we leave the dashboard.
  if (page !== 'dashboard') stopSensorPolling()

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  const target = document.getElementById('page-' + page)
  if (target) { target.classList.add('active') }

  if (updateNav) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
    const navItem = document.querySelector(`[data-page="${page}"]`)
    if (navItem) navItem.classList.add('active')
  }
}

// ── Live Sensor Polling (CPU Load / temps refresh on an interval) ───────────
// Starts a periodic re-collection of sensor data so values like CPU Load
// update live instead of freezing (e.g. stuck at 100%). Only runs on the
// Dashboard page; automatically stopped on navigation. Avoids any hallucinated
// values by always re-reading real data from the main process.
let _sensorPollTimer = null
let _sensorPollRecords = 0

async function startSensorPolling() {
  if (_sensorPollTimer) return // already running
  // Initial pull happens via updateDashboardCards; here we just keep refreshing.
  _sensorPollTimer = setInterval(async () => {
    if (document.getElementById('page-dashboard')?.classList.contains('active') !== true) {
      stopSensorPolling()
      return
    }
    try {
      // Only poll when we already have sensor data from a prior collect.
      if (!state.lastLogs || !state.lastLogs.sensorData) return
      const logs = await window.electronAPI.collectLogs()
      if (logs && logs.sensorData) {
        state.lastLogs.sensorData = logs.sensorData
        updateSensorWidget(logs.sensorData)
        // Keep status cards in sync too (lightweight).
        updateDashboardCardsStatsOnly(logs)
      }
    } catch (e) {
      // Never crash the UI on a transient collect error.
      console.warn('[sensor-poll] collect failed:', e.message)
    }
  }, 5000)
}

function stopSensorPolling() {
  if (_sensorPollTimer) {
    clearInterval(_sensorPollTimer)
    _sensorPollTimer = null
  }
}

function updateDashboardCardsStatsOnly(logs) {
  // Re-render only the scalar status cards (no overlay/scan side effects).
  const si = logs.systemInfo || {}
  setText('sc-cpu-val', si.cpu ? si.cpu.split(' ').slice(-2).join(' ') : '--')
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page
    navigateTo(page)
    if (page === 'settings') populateSettingsUI()
    if (page === 'history') renderHistory()
    if (page === 'results' && state.lastResults) renderResults(state.lastResults)
  })
})

// ── AI Status Pill ────────────────────────────────────────────────────────
function updateAIStatus() {
  const s = state.settings
  if (!s) return
  const dot = document.getElementById('status-dot')
  const label = document.getElementById('status-label')

  if (s.aiProvider === 'ollama') {
    label.textContent = 'Ollama (Local)'
    dot.className = 'status-dot'
    window.electronAPI.checkOllama().then(r => {
      dot.className = 'status-dot ' + (r.running ? 'connected' : 'error')
    })
  } else if (s.apiKey) {
    label.textContent = modelDisplayName(s.aiProvider, s.aiModel)
    dot.className = 'status-dot connected'
  } else {
    label.textContent = 'Not configured'
    dot.className = 'status-dot error'
  }
}

function modelDisplayName(provider, model) {
  const list = MODELS[provider] || []
  const found = list.find(m => m.value === model)
  return found ? found.label.split(' (')[0] : model
}

// ── Scan Flow ─────────────────────────────────────────────────────────────
async function startScan() {
  if (!state.settings.apiKey && state.settings.aiProvider !== 'ollama') {
    if (!confirm('ยังไม่ได้ตั้งค่า API Key\nไปที่หน้า Settings เพื่อตั้งค่าก่อนไหม?')) return
    navigateTo('settings')
    populateSettingsUI()
    return
  }

  // Show scanning page
  navigateTo('scanning', false)
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))

  // Animate scan steps
  const steps = document.querySelectorAll('.scan-step')
  steps.forEach(s => s.className = 'scan-step')

  const animateSteps = async () => {
    for (let i = 0; i < steps.length; i++) {
      if (i > 0) steps[i - 1].className = 'scan-step done'
      steps[i].className = 'scan-step active'
      await delay(600)
    }
  }
  animateSteps()

  let logs
  try {
    logs = await window.electronAPI.collectLogs()
    steps.forEach(s => s.className = 'scan-step done')
    state.lastLogs = logs
    updateDashboardCards(logs)
    startSensorPolling()
  } catch (e) {
    alert('เกิดข้อผิดพลาดในการเก็บ logs: ' + e.message)
    navigateTo('dashboard')
    return
  }

  await delay(500)

  // Show analyzing page
  navigateTo('analyzing', false)
  rotateTips()

  const provider = state.settings.aiProvider
  document.getElementById('analyzing-provider-text').textContent =
    `กำลังวิเคราะห์ด้วย ${providerName(provider)}...`

  let results
  try {
    const resp = await window.electronAPI.analyzeLogs(logs, state.settings)
    if (!resp.success) throw new Error(resp.error)
    results = resp.data
  } catch (e) {
    alert('AI วิเคราะห์ไม่สำเร็จ: ' + e.message)
    navigateTo('dashboard')
    return
  }

  state.lastResults = results
  saveToHistory(results, logs)
  updateDashboardFromResults(results)

  navigateTo('results')
  document.getElementById('nav-results').classList.add('active')
  document.querySelectorAll('.nav-item').forEach(n => {
    if (n.dataset.page !== 'results') n.classList.remove('active')
  })
  renderResults(results)
}

function rotateTips() {
  let i = 0
  const el = document.getElementById('analyzing-tip')
  const rotate = () => {
    if (!document.getElementById('page-analyzing').classList.contains('active')) return
    el.style.opacity = '0'
    setTimeout(() => {
    el.textContent = state.tips[i % state.tips.length]
      el.style.opacity = '1'
      i++
    }, 300)
    setTimeout(rotate, 4000)
  }
  rotate()
}

// ── Dashboard Cards ───────────────────────────────────────────────────────
function updateDashboardCards(logs) {
  const si = logs.systemInfo || {}
  const disk = (logs.diskInfo || [])[0] || {}
  const crashes = logs.crashDumps || {}

  // CPU
  setText('sc-cpu-val', si.cpu ? si.cpu.split(' ').slice(-2).join(' ') : '--')
  setBadge('sc-cpu-badge', 'OK', 'good')

  // RAM
  const ramPct = si.freeRamPct ? Math.round(100 - si.freeRamPct) : si.ramGB > 0 ? Math.round((1 - si.freeRamGB / si.ramGB) * 100) : 0
  setText('sc-ram-val', si.ramGB ? `${si.ramGB}GB Total · ${si.freeRamGB}GB Free` : '--')
  setBadge('sc-ram-badge', ramPct + '%', ramPct > 85 ? 'bad' : ramPct > 65 ? 'warn' : 'good')

  // Disk
  const diskPct = disk.usedPercent || 0
  setText('sc-disk-val', disk.drive ? `${disk.drive}: ${disk.freeGB}GB free` : '--')
  setBadge('sc-disk-badge', diskPct + '%', diskPct > 90 ? 'bad' : diskPct > 75 ? 'warn' : 'good')

  // Crashes
  const cnt = crashes.count || 0
  setText('sc-crashes-val', cnt > 0 ? `${cnt} dump files` : 'ไม่พบ crash')
  setBadge('sc-crashes-badge', cnt > 0 ? cnt + ' found' : 'Clear', cnt > 2 ? 'bad' : cnt > 0 ? 'warn' : 'good')

  document.getElementById('dash-sub').textContent =
    `${si.computerName || 'PC'} · ${si.os || 'Windows'} · Uptime: ${si.uptime || 0}h`

  // Hardware Sensor widget (universal, both platforms)
  updateSensorWidget(logs.sensorData)
}

// ── Hardware Sensor Widget ──────────────────────────────────────────────────
// Renders sensorData faithfully. Any null/undefined is shown as a graceful
// "N/A" (or an explicit "Not Supported" when the sensor reports it) so the
// UI never shows raw text, "PC Mode", or crashes on missing data.
//
// Anti-hallucination rules (Phase 6 Step 2):
//  • Motherboard card shows the board NAME (brand + name), never a temperature.
//  • Fan card shows real RPM from the fanSpeeds object (formatted, e.g. 1,923 RPM),
//    never a placeholder string like "PC Mode".
//  • CPU Temp = package temp (cpuPackageTemp). CPU Cores cell maps per-index
//    sensor temps WITHOUT inventing extra physical cores (G4560 = 2C/4T, even
//    though LibreHardwareMonitor emits 6 entries incl. package/max).
//  • GPU / Chipset "Not Supported" strings are displayed verbatim, not dropped.
function updateSensorWidget(sensor) {
  const s = sensor || {}
  const isDesktop = s.isDesktop === true
  const noteEl = document.getElementById('sensor-admin-note')

  // Helper: set a value cell, applying good/warn/bad colour thresholds.
  const setVal = (id, text, cls) => {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = text == null ? 'N/A' : String(text)
    el.className = 'sn-value ' + (cls || 'neutral')
  }
  const tempClass = (v, warnAt, badAt) => (v > badAt ? 'bad' : v > warnAt ? 'warn' : 'good')

  // ── CPU Temp (package temp) ──
  if (typeof s.cpuTemp === 'number') {
    setVal('sn-cpuTemp', `${s.cpuTemp}°C`, tempClass(s.cpuTemp, 75, 90))
  } else {
    setVal('sn-cpuTemp', s.cpuTemp == null ? 'N/A' : String(s.cpuTemp))
  }

  // ── GPU Temp (may be "Not Supported") ──
  if (s.gpuTemp === 'Not Supported') {
    setVal('sn-gpuTemp', 'Not Supported')
  } else if (typeof s.gpuTemp === 'number') {
    setVal('sn-gpuTemp', `${s.gpuTemp}°C`, tempClass(s.gpuTemp, 80, 95))
  } else {
    setVal('sn-gpuTemp', 'N/A')
  }

  // ── Fan Speed (real RPM from fanSpeeds object) ──
  const fanCell = document.getElementById('cell-fan')
  const fanEl = document.getElementById('sn-fanSpeed')
  if (fanEl) {
    if (s.fanSpeeds && typeof s.fanSpeeds === 'object') {
      const entries = Object.entries(s.fanSpeeds).filter(([, v]) => typeof v === 'number')
      if (entries.length > 0) {
        const parts = entries.map(([, rpm], i) =>
          `Fan ${i + 1}: ${Number(rpm).toLocaleString('en-US')} RPM`)
        fanEl.textContent = parts.join(' / ')
        fanEl.className = 'sn-value good'
      } else if (Object.values(s.fanSpeeds).some(v => v === 'Not Supported')) {
        fanEl.textContent = 'Not Supported'
        fanEl.className = 'sn-value neutral'
      } else {
        fanEl.textContent = 'N/A'
        fanEl.className = 'sn-value neutral'
      }
    } else if (typeof s.fanSpeed === 'number') {
      fanEl.textContent = `${Number(s.fanSpeed).toLocaleString('en-US')} RPM`
      fanEl.className = 'sn-value good'
    } else {
      fanEl.textContent = 'N/A'
      fanEl.className = 'sn-value neutral'
    }
  }

  // ── CPU Load (live %, updated on interval) ──
  const loadEl = document.getElementById('sn-load')
  if (loadEl) {
    if (typeof s.cpuLoad === 'number') {
      loadEl.textContent = `${s.cpuLoad}%`
      loadEl.className = 'sn-value ' + (s.cpuLoad > 90 ? 'bad' : s.cpuLoad > 70 ? 'warn' : 'good')
    } else if (s.cpuLoad === 'Not Supported') {
      loadEl.textContent = 'Not Supported'
      loadEl.className = 'sn-value neutral'
    } else {
      loadEl.textContent = 'N/A'
      loadEl.className = 'sn-value neutral'
    }
  }

  // ── CPU Cores (per-index sensor temps, no false core count) ──
  const coresEl = document.getElementById('sn-cpuCores')
  if (coresEl) {
    const cores = s.cpuTemps
    if (Array.isArray(cores) && cores.length > 0 && cores.every(v => typeof v === 'number')) {
      const max = Math.max(...cores)
      const min = Math.min(...cores)
      const avg = cores.reduce((a, b) => a + b, 0) / cores.length
      // Show each reported sensor temp by index so users see the real data
      // without us claiming a specific physical core layout.
      const list = cores.map((t, i) => `#${i}: ${t}°C`).join(' · ')
      coresEl.textContent = `Avg ${avg.toFixed(1)}°C (${list})`
      coresEl.title = `CPU sensor temperatures (index-based): ${list}`
      coresEl.className = 'sn-value ' + tempClass(max, 80, 95)
    } else if (Array.isArray(cores) && cores[0] === 'Not Supported') {
      coresEl.textContent = 'Not Supported'
      coresEl.className = 'sn-value neutral'
    } else {
      coresEl.textContent = 'N/A'
      coresEl.className = 'sn-value neutral'
    }
  }

  // ── Motherboard card: show BOARD NAME (brand + name), not a temperature ──
  const mbEl = document.getElementById('sn-motherboard')
  if (mbEl) {
    const brand = s.motherboardBrand
    const name = s.motherboardName
    if (name === 'Not Supported' || brand === 'Not Supported') {
      mbEl.textContent = 'Not Supported'
      mbEl.className = 'sn-value neutral'
    } else if (name) {
      const label = brand && name.toLowerCase().startsWith(brand.toLowerCase())
        ? name
        : `${brand ? brand + ' ' : ''}${name}`.trim()
      mbEl.textContent = label
      mbEl.title = `${brand || ''} ${name}`.trim()
      mbEl.className = 'sn-value good'
    } else {
      mbEl.textContent = 'N/A'
      mbEl.className = 'sn-value neutral'
    }
  }

  // ── Chipset (may be "Not Supported") ──
  const chipEl = document.getElementById('sn-chipset')
  if (chipEl) {
    if (s.chipsetTemp === 'Not Supported') {
      chipEl.textContent = 'Not Supported'
      chipEl.className = 'sn-value neutral'
    } else if (typeof s.chipsetTemp === 'number') {
      chipEl.textContent = `${s.chipsetTemp}°C`
      chipEl.className = 'sn-value ' + tempClass(s.chipsetTemp, 70, 85)
    } else {
      chipEl.textContent = 'N/A'
      chipEl.className = 'sn-value neutral'
    }
  }

  // ── Admin / UAC note ──
  if (noteEl) {
    if (s._adminWarning) {
      noteEl.textContent = '⚠️ ' + s._adminWarning
      noteEl.className = 'sensor-admin-note warn'
      noteEl.style.display = 'block'
    } else if (s._adminMode) {
      noteEl.textContent = '🔓 Deep sensor data active (Administrator / LibreHardwareMonitor) — values are hardware-accurate.'
      noteEl.className = 'sensor-admin-note good'
      noteEl.style.display = 'block'
    } else {
      noteEl.style.display = 'none'
    }
  }

  // Always show the grid (no fake empty-state that hides real cells).
  const emptyEl = document.getElementById('sensor-empty')
  const gridEl = document.getElementById('sensor-grid')
  if (emptyEl && gridEl) {
    gridEl.style.display = 'grid'
    emptyEl.style.display = 'none'
  }

  // Platform badge (universal indicator)
  const platEl = document.getElementById('sensor-platform')
  if (platEl) platEl.textContent = state.platform === 'darwin' ? 'macOS' : 'Windows'
}

function updateDashboardFromResults(results) {
  // Health score ring
  const score = results.healthScore || 0
  const num = document.getElementById('health-number')
  const ring = document.getElementById('health-ring-fill')
  const circumference = 314
  const offset = circumference - (score / 100) * circumference

  num.textContent = score
  ring.style.strokeDashoffset = offset
  ring.style.stroke = score >= 80 ? '#10B981' : score >= 60 ? '#F59E0B' : '#EF4444'

  document.getElementById('health-summary').textContent = results.summary || ''

  // Recent issues (top 3)
  const container = document.getElementById('recent-issues-list')
  const issues = results.issues || []
  if (issues.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">✅</div>
      <div class="empty-title">ไม่พบปัญหา</div>
      <div class="empty-desc">ระบบของคุณดูเหมือนจะอยู่ในสภาพดี</div>
    </div>`
    return
  }

  document.getElementById('view-all-btn').style.display = 'block'
  container.innerHTML = issues.slice(0, 4).map(issue => `
    <div class="issue-mini" onclick="navigateTo('results')">
      <div class="im-sev dot-${issue.severity}"></div>
      <div style="flex:1">
        <div class="im-title">${esc(issue.title)}</div>
        <div class="im-cat">${esc(issue.category || '')}</div>
      </div>
      <div class="im-badge sev-${issue.severity}">${esc(issue.severity)}</div>
    </div>
  `).join('')
}

// ── Render Results ────────────────────────────────────────────────────────
function renderResults(results) {
  if (!results) return
  state.lastResults = results

  const ts = new Date().toLocaleString('th-TH')
  document.getElementById('results-timestamp').textContent = `วิเคราะห์เมื่อ: ${ts}`

  // Summary bar
  const bar = document.getElementById('results-summary-bar')
  bar.style.display = 'flex'
  document.getElementById('rsb-num').textContent = results.healthScore || '--'
  document.getElementById('rsb-summary-text').textContent = results.summary || ''

  // Filter bar
  document.getElementById('severity-filter').style.display = 'flex'

  // Issues
  renderIssueList(results.issues || [])

  // Recommendations
  const recs = results.recommendations || []
  if (recs.length > 0) {
    document.getElementById('recommendations-section').style.display = 'block'
    document.getElementById('recs-list').innerHTML = recs.map(r =>
      `<div class="rec-item">${esc(r)}</div>`
    ).join('')
  }
}

function renderIssueList(issues) {
  const container = document.getElementById('results-list')
  const filtered = state.currentFilter === 'all'
    ? issues
    : issues.filter(i => i.severity === state.currentFilter)

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">✅</div>
      <div class="empty-title">${state.currentFilter === 'all' ? 'ไม่พบปัญหา' : 'ไม่มีปัญหาระดับนี้'}</div>
      <div class="empty-desc">ระบบของคุณดูแลอยู่ในสภาพดี</div>
    </div>`
    return
  }

  container.innerHTML = filtered.map((issue, idx) => `
    <div class="issue-card" data-severity="${issue.severity}" style="animation-delay:${idx * 0.06}s">
      <div class="issue-card-stripe stripe-${issue.severity}"></div>
      <div class="issue-card-body">
        <div class="issue-card-top">
          <div class="issue-card-title">${esc(issue.title)}</div>
          <div class="issue-badges">
            <span class="im-badge sev-${issue.severity}">${esc(issue.severity)}</span>
            <span class="cat-badge">${esc(issue.category || 'GENERAL')}</span>
            ${issue.fixDifficulty ? `<span class="difficulty-badge diff-${issue.fixDifficulty}">${issue.fixDifficulty}</span>` : ''}
          </div>
        </div>

        <div class="issue-explanation">${esc(issue.explanation)}</div>

        <div class="issue-details">
          <button class="details-toggle" onclick="toggleDetails(this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
            ดูสาเหตุทางเทคนิคและวิธีแก้ไข
          </button>
          <div class="details-content">
            ${issue.rootCause ? `<div class="root-cause-text">🔍 ${esc(issue.rootCause)}</div>` : ''}
            ${issue.fixSteps && issue.fixSteps.length > 0 ? `
              <div class="fix-steps-title">🔧 วิธีแก้ไข</div>
              <div class="fix-steps">
                ${issue.fixSteps.map((step, i) => `
                  <div class="fix-step">
                    <div class="fix-step-num">${i + 1}</div>
                    <div>${esc(step)}</div>
                  </div>
                `).join('')}
              </div>
            ` : ''}
            ${issue.relatedEvents && issue.relatedEvents.length > 0 ? `
              <div style="margin-top:10px;font-size:12px;color:var(--t3)">
                Related: ${issue.relatedEvents.join(', ')}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    </div>
  `).join('')
}

function toggleDetails(btn) {
  const content = btn.nextElementSibling
  content.classList.toggle('open')
  const svg = btn.querySelector('svg')
  svg.style.transform = content.classList.contains('open') ? 'rotate(90deg)' : ''
}

function filterResults(filter) {
  state.currentFilter = filter
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter)
  })
  if (state.lastResults) renderIssueList(state.lastResults.issues || [])
}

// ── Copy Report ───────────────────────────────────────────────────────────
async function exportLogs() {
  if (!state.lastLogs) {
    // Try to collect fresh logs if available
    try {
      state.lastLogs = await window.electronAPI.collectLogs()
    } catch (e) {
      alert('ยังไม่มีข้อมูล logs กรุณา Scan ก่อน')
      return
    }
  }
  const result = await window.electronAPI.exportLogs(state.lastLogs)
  if (result.success) {
    showToast('✅ Export logs สำเร็จ: ' + result.path)
  } else if (!result.canceled) {
    alert('Export ล้มเหลว: ' + (result.error || 'Unknown error'))
  }
}

function copyReport() {
  if (!state.lastResults) return
  const r = state.lastResults
  let text = `SysLog AI Analysis Report\n${'='.repeat(40)}\n`
  text += `Health Score: ${r.healthScore}/100\n`
  text += `Summary: ${r.summary}\n\n`
  text += `Issues Found: ${(r.issues || []).length}\n\n`
    ; (r.issues || []).forEach((issue, i) => {
      text += `${i + 1}. [${issue.severity}] ${issue.title}\n`
      text += `   ${issue.explanation}\n`
      if (issue.fixSteps) {
        issue.fixSteps.forEach((s, j) => { text += `   ${j + 1}. ${s}\n` })
      }
      text += '\n'
    })
  navigator.clipboard.writeText(text).then(() => showToast('คัดลอก Report แล้ว ✅'))
}

// ── History ───────────────────────────────────────────────────────────────
function loadHistory() {
  try {
    const saved = localStorage.getItem('syslog-history')
    state.history = saved ? JSON.parse(saved) : []
  } catch { state.history = [] }
}

function saveToHistory(results, logs) {
  const entry = {
    id: Date.now(),
    date: new Date().toLocaleString('th-TH'),
    healthScore: results.healthScore,
    issueCount: (results.issues || []).length,
    summary: results.summary,
    results,
    computerName: logs?.systemInfo?.computerName || 'PC'
  }
  state.history.unshift(entry)
  if (state.history.length > 20) state.history = state.history.slice(0, 20)
  localStorage.setItem('syslog-history', JSON.stringify(state.history))
}

function renderHistory() {
  const container = document.getElementById('history-list')
  if (state.history.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🕒</div>
      <div class="empty-title">ยังไม่มีประวัติ</div>
      <div class="empty-desc">เมื่อคุณ scan ครั้งแรก ประวัติจะแสดงที่นี่</div>
    </div>`
    return
  }

  container.innerHTML = state.history.map(entry => `
    <div class="history-card" onclick="loadHistoryEntry(${entry.id})">
      <div class="hc-score">${entry.healthScore || '?'}</div>
      <div class="hc-info">
        <div class="hc-date">${entry.date} · ${entry.computerName}</div>
        <div class="hc-issues">พบ ${entry.issueCount} ปัญหา · ${entry.summary ? entry.summary.slice(0, 80) + '...' : ''}</div>
      </div>
      <button class="hc-delete" onclick="event.stopPropagation(); deleteHistory(${entry.id})">🗑</button>
    </div>
  `).join('')
}

function loadHistoryEntry(id) {
  const entry = state.history.find(h => h.id === id)
  if (!entry) return
  state.lastResults = entry.results
  navigateTo('results')
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === 'results')
  })
  renderResults(entry.results)
}

function deleteHistory(id) {
  state.history = state.history.filter(h => h.id !== id)
  localStorage.setItem('syslog-history', JSON.stringify(state.history))
  renderHistory()
}

function clearHistory() {
  if (!confirm('ลบประวัติทั้งหมดหรือไม่?')) return
  state.history = []
  localStorage.removeItem('syslog-history')
  renderHistory()
}

// ── System Info Modal ─────────────────────────────────────────────────────
function showSystemInfo() {
  if (!state.lastLogs) {
    alert('ยังไม่มีข้อมูล กรุณา Scan ก่อน')
    return
  }
  const si = state.lastLogs.systemInfo || {}
  const rows = [
    ['Computer Name', si.computerName],
    ['Operating System', si.os],
    ['OS Build', si.osBuild],
    ['CPU', si.cpu],
    ['Total RAM', si.ramGB + ' GB'],
    ['Free RAM', si.freeRamGB + ' GB'],
    ['Last Boot', si.lastBoot],
    ['Uptime', si.uptime + ' hours'],
  ]
  document.getElementById('sysinfo-body').innerHTML = rows.map(([k, v]) => `
    <div class="sysinfo-row">
      <span class="sysinfo-key">${k}</span>
      <span class="sysinfo-val">${v || 'Unknown'}</span>
    </div>
  `).join('')
  document.getElementById('sysinfo-modal').style.display = 'flex'
}

function closeSysInfo() {
  document.getElementById('sysinfo-modal').style.display = 'none'
}

// ─── Smart API Key Detection ──────────────────────────────────────────────
// Provider detection rules based on API key prefix
const API_KEY_PATTERNS = [
  { pattern: /^AIza/, provider: 'gemini', name: 'Google Gemini', icon: '🇺🇸' },
  { pattern: /^sk-ant-/, provider: 'claude', name: 'Anthropic Claude', icon: '🇺🇸' },
  { pattern: /^gsk_/, provider: 'groq', name: 'Groq', icon: '🇺🇸' },
  { pattern: /^sk-or-/, provider: 'openai', name: 'OpenAI', icon: '🇺🇸' },  // sk-or- for openrouter, but for now map to openai
  { pattern: /^sk-/, provider: 'openai', name: 'OpenAI/DeepSeek', icon: '🌐' },  // generic sk- → need test
]

const PROVIDER_DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash-lite',
  claude: 'claude-3-5-sonnet-20241022',
  groq: 'llama3-8b-8192',
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
  qwen: 'qwen-turbo',
}

const PROVIDER_NAMES = {
  gemini: { name: 'Google Gemini', icon: '🇺🇸' },
  claude: { name: 'Anthropic Claude', icon: '🇺🇸' },
  groq: { name: 'Groq', icon: '🇺🇸' },
  openai: { name: 'OpenAI', icon: '🇺🇸' },
  deepseek: { name: 'DeepSeek', icon: '🇨🇳' },
  qwen: { name: 'Alibaba Qwen', icon: '🇨🇳' },
}

function detectProviderFromKey(apiKey) {
  if (!apiKey || apiKey.trim().length < 8) return null
  const trimmed = apiKey.trim()
  for (const rule of API_KEY_PATTERNS) {
    if (rule.pattern.test(trimmed)) return rule
  }
  // sk- could be OpenAI or DeepSeek — return generic
  if (/^sk-/.test(trimmed)) return { pattern: /^sk-/, provider: null, name: 'OpenAI / DeepSeek', icon: '🌐' }
  return null
}

let apiKeyDetectionTimeout = null

async function onApiKeyInput() {
  const input = document.getElementById('settings-apikey')
  const status = document.getElementById('settings-apikey-status')
  const icon = document.getElementById('settings-apikey-icon')
  const text = document.getElementById('settings-apikey-text')
  const modelGroup = document.getElementById('settings-model-group')
  const modelLoading = document.getElementById('settings-model-loading')

  // Clear previous timeout
  if (apiKeyDetectionTimeout) clearTimeout(apiKeyDetectionTimeout)

  const val = input.value.trim()
  if (val.length < 8) {
    status.style.display = 'none'
    modelGroup.style.display = 'none'
    return
  }

  // Show detecting state
  status.style.display = 'flex'
  status.className = 'apikey-status detecting'
  icon.textContent = '⏳'
  text.textContent = 'กำลังตรวจจับประเภท API Key...'

  // Debounce 500ms
  apiKeyDetectionTimeout = setTimeout(async () => {
    const detected = detectProviderFromKey(val)
    if (!detected) {
      status.className = 'apikey-status invalid'
      icon.textContent = '❌'
      text.textContent = 'ไม่สามารถระบุค่ายได้ (Prefix ไม่ตรง) — กรุณาเลือก Provider ด้วยตนเอง'
      modelGroup.style.display = 'none'
      return
    }

    // If provider is ambiguous (sk- generic), let user pick manually
    if (!detected.provider) {
      status.className = 'apikey-status invalid'
      icon.textContent = '❓'
      text.textContent = `ตรวจพบ ${detected.name} — กรุณาเลือก Provider ด้วยตนเอง`
      modelGroup.style.display = 'none'
      return
    }

    // Show detected provider
    const providerInfo = PROVIDER_NAMES[detected.provider] || { name: detected.provider, icon: '' }
    status.className = 'apikey-status valid'
    icon.textContent = '✅'
    text.textContent = `ตรวจพบ: ${providerInfo.icon} ${providerInfo.name}`

    // Auto-select provider radio
    const radio = document.querySelector(`input[name="provider"][value="${detected.provider}"]`)
    if (radio) {
      radio.checked = true
      document.querySelectorAll('.provider-row').forEach(r => r.classList.remove('selected'))
      radio.closest('.provider-row').classList.add('selected')
      toggleSettingsProviderUI(detected.provider)
      // Store detected provider for model fetching
      state._detectedProvider = detected.provider
    }

    // Now fetch models from this provider
    await fetchModelsForProvider(detected.provider, val)
  }, 500)
}

async function fetchModelsForProvider(provider, apiKey) {
  const modelGroup = document.getElementById('settings-model-group')
  const modelSelect = document.getElementById('settings-model')
  const modelLoading = document.getElementById('settings-model-loading')

  modelGroup.style.display = 'block'
  modelLoading.style.display = 'inline'

  try {
    const result = await window.electronAPI.fetchModels({ apiKey, provider })

    modelLoading.style.display = 'none'

    if (!result.success) {
      // Smart error handling
      const statusCode = result.status
      if (statusCode === 403) {
        showApiKeyNotification('❌ API Key นี้ไม่มีสิทธิ์ (403 Forbidden) — อาจเป็น Free Tier ที่ใช้โมเดลนี้ไม่ได้ กรุณาเปลี่ยนโมเดลหรือตรวจสอบเครดิต')
      } else if (statusCode === 429) {
        showApiKeyNotification('❌ Quota หมด (429 Too Many Requests) — กรุณารอหรืออัปเกรดเป็น Paid Tier')
      } else if (statusCode === 401) {
        showApiKeyNotification('❌ API Key ไม่ถูกต้อง (401 Unauthorized) — กรุณาตรวจสอบ API Key')
      } else {
        showApiKeyNotification(`⚠️ ไม่สามารถโหลดรายชื่อโมเดลได้ (${result.error || 'Unknown error'}) — กรุณาเลือก Model ด้วยตนเอง`)
      }
      // Fallback: show static model list
      populateModelDropdown('settings-model', provider, PROVIDER_DEFAULT_MODELS[provider] || '')
      return
    }

    // Success — populate model dropdown with live models
    const models = result.models || []
    if (models.length === 0) {
      showApiKeyNotification('⚠️ พบ API Key แต่ไม่พบ Model — กรุณาเลือกด้วยตนเอง')
      populateModelDropdown('settings-model', provider, PROVIDER_DEFAULT_MODELS[provider] || '')
      return
    }

    // Filter to only chat/generation models (exclude embeddings, moderation, etc.)
    const chatModels = models.filter(m => {
      const lower = m.toLowerCase()
      // Exclude embedding, moderation, whisper, tts, dalle, etc.
      if (lower.includes('embedding') || lower.includes('embed') ||
          lower.includes('moderation') || lower.includes('whisper') ||
          lower.includes('tts') || lower.includes('dalle') ||
          lower.includes('tts-1') || lower.includes('instruct') ||
          // For Gemini, only keep models that start with "gemini-"
          (provider === 'gemini' && !lower.startsWith('gemini-'))) return false
      return true
    }) || models

    // Build dropdown
    const defaultModel = PROVIDER_DEFAULT_MODELS[provider] || (chatModels.length > 0 ? chatModels[0] : '')

    // Try to find the default model in the list
    const hasDefault = chatModels.some(m => m === defaultModel)
    modelSelect.innerHTML = chatModels.map(m =>
      `<option value="${m}" ${m === defaultModel ? 'selected' : ''}>${m}</option>`
    ).join('')

    if (!hasDefault && chatModels.length > 0) {
      // Select first available
      modelSelect.value = chatModels[0]
    }

    showApiKeyNotification(`✅ โหลดรายชื่อ Model แล้ว (พบ ${chatModels.length} model)`, 'success')
  } catch (e) {
    modelLoading.style.display = 'none'
    showApiKeyNotification(`⚠️ เกิดข้อผิดพลาดในการโหลด Model: ${e.message}`)
    populateModelDropdown('settings-model', provider, PROVIDER_DEFAULT_MODELS[provider] || '')
  }
}

let apiKeyNotificationTimeout = null

function showApiKeyNotification(msg, type = 'info') {
  const el = document.getElementById('settings-test-result')
  if (!el) return
  el.style.display = 'block'
  el.className = 'test-result ' + (type === 'success' ? 'ok' : type === 'info' ? 'testing' : 'err')
  el.textContent = msg

  // Auto-hide after 8 seconds for success messages
  if (apiKeyNotificationTimeout) clearTimeout(apiKeyNotificationTimeout)
  if (type === 'success') {
    apiKeyNotificationTimeout = setTimeout(() => {
      el.style.display = 'none'
    }, 8000)
  }
}

// ── Settings UI ───────────────────────────────────────────────────────────
function populateSettingsUI() {
  const s = state.settings
  if (!s) return

  // Select radio
  const radio = document.querySelector(`input[name="provider"][value="${s.aiProvider}"]`)
  if (radio) {
    radio.checked = true
    radio.closest('.provider-row').classList.add('selected')
  }

  // Model dropdown — try static list first, then live fetch if API key exists
  if (s.apiKey && s.aiProvider !== 'ollama') {
    // Show model group and fetch live models
    const modelGroup = document.getElementById('settings-model-group')
    modelGroup.style.display = 'block'
    fetchModelsForProvider(s.aiProvider, s.apiKey)

    // Trigger key detection UI
    const status = document.getElementById('settings-apikey-status')
    status.style.display = 'flex'
    status.className = 'apikey-status valid'
    document.getElementById('settings-apikey-icon').textContent = '✅'
    document.getElementById('settings-apikey-text').textContent = 'API Key พร้อมใช้งาน'
  } else {
    // Static dropdown fallback
    populateModelDropdown('settings-model', s.aiProvider, s.aiModel)
  }

  // API key
  document.getElementById('settings-apikey').value = s.apiKey || ''
  document.getElementById('settings-autofallback').checked = s.autoFallback !== false
  const tsToggle = document.getElementById('settings-tsundere')
  if (tsToggle) tsToggle.checked = s.tsundereMode || false

  // Show/hide sections
  toggleSettingsProviderUI(s.aiProvider)

  // Ollama
  document.getElementById('settings-ollama-url').value = s.ollamaUrl || 'http://localhost:11434'
  if (s.aiProvider === 'ollama') refreshOllamaModels()
}

function selectProvider(provider) {
  document.querySelectorAll('.provider-row').forEach(r => r.classList.remove('selected'))
  const radio = document.querySelector(`input[value="${provider}"]`)
  if (radio) {
    radio.checked = true
    radio.closest('.provider-row').classList.add('selected')
  }
  populateModelDropdown('settings-model', provider, null)
  toggleSettingsProviderUI(provider)
  if (provider === 'ollama') refreshOllamaModels()
}

function toggleSettingsProviderUI(provider) {
  document.getElementById('settings-online-config').style.display = provider !== 'ollama' ? 'block' : 'none'
  document.getElementById('settings-ollama-config').style.display = provider === 'ollama' ? 'block' : 'none'
}

function onModelChange() {
  // placeholder for future logic
}

async function settingsTestKey() {
  const provider = document.querySelector('input[name="provider"]:checked')?.value
  const apiKey = document.getElementById('settings-apikey').value.trim()
  const model = document.getElementById('settings-model').value

  if (!provider) { showTestResult('settings', false, 'กรุณาเลือก AI Provider'); return }
  if (!apiKey) { showTestResult('settings', false, 'กรุณาใส่ API Key'); return }

  showTestResult('settings', null, '⏳ กำลังทดสอบการเชื่อมต่อ...')
  const result = await window.electronAPI.testApiKey({ provider, apiKey, model })
  if (result.ok) {
    showTestResult('settings', true, '✅ เชื่อมต่อสำเร็จ! API Key ใช้งานได้')
  } else {
    let msg = `❌ การเชื่อมต่อล้มเหลว`
    if (result.status) {
      if (result.status === 401) msg += ` · API Key ไม่ถูกต้อง (401)`
      else if (result.status === 403) msg += ` · API Key ไม่มีสิทธิ์ (403)`
      else if (result.status === 404) msg += ` · Model นี้ใช้กับ key นี้ไม่ได้ (404) — ลองเลือก model อื่น`
      else if (result.status === 429) msg += ` · ติด quota/rate limit (429) — อาจเป็นรายนาที รายวัน หรือ project tier`
      else msg += ` · HTTP ${result.status}`
    }
    if (result.message) msg += ` · ${result.message}`
    else if (result.error) msg += ` · ${result.error}`
    showTestResult('settings', false, msg)
  }
}

async function saveSettingsUI() {
  const provider = document.querySelector('input[name="provider"]:checked')?.value || 'gemini'
  const model = document.getElementById('settings-model')?.value || ''
  const apiKey = document.getElementById('settings-apikey')?.value.trim() || ''
  const autoFallback = document.getElementById('settings-autofallback')?.checked !== false
  const tsundereMode = document.getElementById('settings-tsundere')?.checked || false
  const ollamaUrl = document.getElementById('settings-ollama-url')?.value.trim() || 'http://localhost:11434'
  const ollamaModel = document.getElementById('settings-ollama-model')?.value || 'llama3.2'

  state.settings = { ...state.settings, aiProvider: provider, aiModel: model, apiKey, autoFallback, tsundereMode, ollamaUrl, ollamaModel, firstRun: false }
  await window.electronAPI.saveSettings(state.settings)
  updateAIStatus()
  showToast('บันทึกการตั้งค่าเรียบร้อย ✅')
}

async function refreshOllamaModels() {
  const box = document.getElementById('settings-ollama-status')
  box.className = 'ollama-check-box'
  box.innerHTML = '<div class="ocb-icon">⏳</div><div class="ocb-text">กำลังตรวจสอบ Ollama...</div>'

  const r = await window.electronAPI.checkOllama()
  if (r.running) {
    box.className = 'ollama-check-box ok'
    box.innerHTML = `<div class="ocb-icon">✅</div><div class="ocb-text">Ollama กำลังทำงาน · พบ ${r.models.length} model</div>`
    populateOllamaModels('settings-ollama-model', r.models, state.settings.ollamaModel)
  } else {
    box.className = 'ollama-check-box err'
    box.innerHTML = '<div class="ocb-icon">⚠️</div><div class="ocb-text">ไม่พบ Ollama · กรุณาติดตั้งที่ ollama.ai ก่อน</div>'
  }
}

// ── Setup Wizard ──────────────────────────────────────────────────────────
function setupWizardInit() {
  updateWizardModels()
}

let wizardMode = 'online'

function wizardSelect(mode) {
  wizardMode = mode
  document.getElementById('wiz-online').classList.toggle('selected', mode === 'online')
  document.getElementById('wiz-local').classList.toggle('selected', mode === 'local')
  document.getElementById('wiz-online-form').style.display = mode === 'online' ? 'block' : 'none'
  document.getElementById('wiz-local-form').style.display = mode === 'local' ? 'block' : 'none'

  if (mode === 'local') {
    checkOllamaForWizard()
  }
}

async function checkOllamaForWizard() {
  const box = document.getElementById('ollama-check-box')
  const r = await window.electronAPI.checkOllama()
  if (r.running) {
    box.className = 'ollama-check-box ok'
    box.innerHTML = `<div class="ocb-icon">✅</div><div class="ocb-text">พบ Ollama · ${r.models.length} model</div>`
    document.getElementById('wiz-ollama-models').style.display = 'block'
    populateOllamaModels('wiz-ollama-model', r.models)
  } else {
    box.className = 'ollama-check-box err'
    box.innerHTML = `<div class="ocb-icon">⚠️</div>
      <div class="ocb-text">ไม่พบ Ollama ในเครื่อง
        <br><span class="link-text" onclick="window.electronAPI.openExternal('https://ollama.ai')">📥 ดาวน์โหลด Ollama ที่นี่</span>
      </div>`
    document.getElementById('wiz-ollama-models').style.display = 'none'
  }
}

function updateWizardModels() {
  const provider = document.getElementById('wiz-provider').value
  const isChina = provider === 'deepseek' || provider === 'qwen'
  document.getElementById('china-warning').style.display = isChina ? 'block' : 'none'
  populateModelDropdown('wiz-model', provider, null)
}

async function wizardTestKey() {
  const provider = document.getElementById('wiz-provider').value
  const apiKey = document.getElementById('wiz-apikey').value.trim()
  const model = document.getElementById('wiz-model').value
  if (!apiKey) { showTestResult('wiz', false, 'กรุณาใส่ API key'); return }
  showTestResult('wiz', null, 'กำลังทดสอบ...')
  const result = await window.electronAPI.testApiKey({ provider, apiKey, model })
  showTestResult('wiz', result.ok, result.ok ? '✅ เชื่อมต่อสำเร็จ!' : `❌ ผิดพลาด: ${result.message || result.error || 'HTTP ' + result.status}`)
}

async function wizardComplete() {
  let settings = { ...state.settings, firstRun: false }

  if (wizardMode === 'online') {
    settings.aiProvider = document.getElementById('wiz-provider').value
    settings.aiModel = document.getElementById('wiz-model').value
    settings.apiKey = document.getElementById('wiz-apikey').value.trim()
  } else {
    settings.aiProvider = 'ollama'
    settings.ollamaModel = document.getElementById('wiz-ollama-model')?.value || 'llama3.2'
  }

  state.settings = settings
  await window.electronAPI.saveSettings(settings)
  showSidebar()
  updateAIStatus()
  navigateTo('dashboard')
}

function wizardSkip() {
  state.settings = { ...state.settings, firstRun: false }
  window.electronAPI.saveSettings(state.settings)
  showSidebar()
  navigateTo('dashboard')
}

function openGetKeyLink() {
  const isWizard = document.getElementById('page-setup')?.classList.contains('active')
  const provider = isWizard
    ? (document.getElementById('wiz-provider')?.value || 'gemini')
    : (document.querySelector('input[name="provider"]:checked')?.value || 'gemini')

  const url = API_KEY_LINKS[provider] || 'https://aistudio.google.com/apikey'

  window.electronAPI.openExternal(url).catch(err => {
    alert(`ไม่สามารถเปิดเบราว์เซอร์ได้ กรุณาก๊อปปี้ลิงก์นี้ไปเปิดเองครับ:\n\n${url}`)
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────
function populateModelDropdown(id, provider, selectedValue) {
  const sel = document.getElementById(id)
  if (!sel) return
  const models = MODELS[provider] || []
  sel.innerHTML = models.map(m =>
    `<option value="${m.value}" ${m.value === selectedValue ? 'selected' : ''}>${m.label}</option>`
  ).join('')
}

function populateOllamaModels(id, models, selected) {
  const sel = document.getElementById(id)
  if (!sel) return
  if (models.length === 0) {
    sel.innerHTML = '<option value="">ไม่พบ model — ใช้ ollama pull llama3.2</option>'
    return
  }
  sel.innerHTML = models.map(m =>
    `<option value="${m}" ${m === selected ? 'selected' : ''}>${m}</option>`
  ).join('')
}

function showTestResult(prefix, ok, msg) {
  const el = document.getElementById(prefix + '-test-result')
  if (!el) return
  el.style.display = 'block'
  el.className = 'test-result ' + (ok === null ? 'testing' : ok ? 'ok' : 'err')
  el.textContent = msg
}

function setText(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

function setBadge(id, text, cls) {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = text
  el.className = 'sc-badge ' + cls
}

function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/\n/g, '<br>')
}

function providerName(p) {
  const names = { gemini: 'Google Gemini', claude: 'Claude', openai: 'GPT-4o', deepseek: 'DeepSeek', qwen: 'Qwen', ollama: 'Ollama' }
  return names[p] || p
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

function showToast(msg) {
  const t = document.getElementById('settings-toast')
  if (t) {
    t.textContent = msg
    t.style.display = 'block'
    setTimeout(() => { t.style.display = 'none' }, 3000)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG IMPORTER & HARDWARE FORENSIC (Phase 5)
// Modular from the real-time Scan/Analyze flow. Uses a distinct forensic prompt
// (buildForensicPrompt in main.js) so the AI acts as a Diagnostic Specialist
// for OTHER machines, keeping the logic fully separated.
// ─────────────────────────────────────────────────────────────────────────────

// Sanitize raw log content (mirror of main.js sanitizeLogContent, runs client-side
// as a second safety pass before transmit). Strips PII: paths, IPs, emails, MACs.
function sanitizeLogContent(raw) {
  if (!raw) return ''
  let s = raw
  s = s.replace(/[A-Za-z]:\\(?:[^\\\s"']+\\)*/g, '<PATH>\\')
  s = s.replace(/\\\\[^\\\s"']+\\/g, '<UNCPATH>\\')
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<EMAIL>')
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>')
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '<MAC>')
  s = s.replace(/\bS-1-5-21-[\d-]+\b/g, '<SID>')
  s = s.replace(/\b\d{13,19}\b/g, '<CARD>')
  return s
}

let importedLog = null  // { fileName, content, sanitized, truncated, size }

function triggerImportFile() {
  // Use the native file dialog via main process for full control + sanitization.
  window.electronAPI.openFileDialog()
    .then(result => {
      if (result.canceled) return
      if (result.error) { alert('ไม่สามารถอ่านไฟล์ได้: ' + result.error); return }
      if (!result.content) { alert('ไฟล์ว่างเปล่า'); return }
      onImportContentLoaded(result)
    })
    .catch(e => {
      // Fallback: use the HTML <input type=file> if IPC dialog unavailable
      document.getElementById('import-file-input').click()
    })
}

function onImportFileSelected(event) {
  const file = event.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const content = reader.result || ''
    const truncated = content.length > 200 * 1024
    onImportContentLoaded({
      canceled: false,
      fileName: file.name,
      content: truncated ? content.slice(0, 200 * 1024) : content,
      truncated,
      size: file.size
    })
  }
  reader.readAsText(file)
}

function onImportContentLoaded(result) {
  const raw = result.content || ''
  const sanitized = sanitizeLogContent(raw)
  importedLog = {
    fileName: result.fileName || 'unknown.log',
    content: sanitized,
    truncated: !!result.truncated,
    size: result.size || raw.length
  }

  // Show file info
  document.getElementById('import-file-info').style.display = 'flex'
  document.getElementById('import-file-name').textContent = importedLog.fileName
  const sizeKB = (importedLog.size / 1024).toFixed(1)
  document.getElementById('import-file-meta').textContent =
    `${sizeKB} KB${importedLog.truncated ? ' · ถูกตัดให้เหลือ 200 KB' : ''} · ${sanitized.length} ตัวอักษร (หลังซ่อนข้อมูลส่วนตัว)`
  document.getElementById('import-sanitize-note').style.display = 'block'
  document.getElementById('import-analyze-btn').disabled = false

  // Reset results
  document.getElementById('import-results').style.display = 'none'
}

function clearImportFile() {
  importedLog = null
  document.getElementById('import-file-info').style.display = 'none'
  document.getElementById('import-sanitize-note').style.display = 'none'
  document.getElementById('import-analyze-btn').disabled = true
  document.getElementById('import-results').style.display = 'none'
  const input = document.getElementById('import-file-input')
  if (input) input.value = ''
}

async function analyzeImportedLog() {
  if (!importedLog) {
    alert('กรุณาเลือกไฟล์ Log ก่อน')
    return
  }
  if (!state.settings.apiKey && state.settings.aiProvider !== 'ollama') {
    if (!confirm('ยังไม่ได้ตั้งค่า API Key\nไปที่หน้า Settings เพื่อตั้งค่าก่อนไหม?')) return
    navigateTo('settings')
    populateSettingsUI()
    return
  }

  // Show analyzing animation (reuse the shared analyzing page)
  navigateTo('analyzing', false)
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  document.getElementById('analyzing-provider-text').textContent =
    `กำลังวิเคราะห์ Log ภายนอกด้วย ${providerName(state.settings.aiProvider)}...`
  rotateTips()

  let resp
  try {
    resp = await window.electronAPI.analyzeExternalLog(
      importedLog.content,
      importedLog.fileName,
      state.settings
    )
  } catch (e) {
    // If the IPC is missing (older build), fall back to a local note.
    alert('เกิดข้อผิดพลาด: ' + e.message)
    navigateTo('import')
    return
  }

  if (!resp.success) {
    alert('AI วิเคราะห์ไม่สำเร็จ: ' + (resp.error || 'Unknown error'))
    navigateTo('import')
    return
  }

  // Render forensic results (modular — separate container from dashboard results)
  renderForensicResults(resp.data)
  navigateTo('import')
}

function renderForensicResults(data) {
  if (!data) return
  const container = document.getElementById('import-results')
  container.style.display = 'block'

  // Confidence badge
  const conf = document.getElementById('import-confidence')
  const c = (data.confidence || 'MEDIUM').toUpperCase()
  const confClass = c === 'HIGH' ? 'good' : c === 'LOW' ? 'bad' : 'warn'
  conf.className = 'confidence-badge ' + confClass
  conf.textContent = `ความมั่นใจ: ${c}`

  // Summary
  document.getElementById('import-summary').textContent = data.summary || ''

  // Issues (reuse the same card layout as real-time results)
  const issuesContainer = document.getElementById('import-issues-list')
  const issues = data.issues || []
  if (issues.length === 0) {
    issuesContainer.innerHTML = `<div class="empty-state">
      <div class="empty-icon">✅</div>
      <div class="empty-title">ไม่พบปัญหาใน Log นี้</div>
      <div class="empty-desc">Log อาจไม่มี error ที่ชัดเจน หรือไม่สมบูรณ์</div>
    </div>`
  } else {
    state.currentFilter = 'all'
    issuesContainer.innerHTML = issues.map((issue, idx) => `
      <div class="issue-card" data-severity="${issue.severity}" style="animation-delay:${idx * 0.06}s">
        <div class="issue-card-stripe stripe-${issue.severity}"></div>
        <div class="issue-card-body">
          <div class="issue-card-top">
            <div class="issue-card-title">${esc(issue.title)}</div>
            <div class="issue-badges">
              <span class="im-badge sev-${issue.severity}">${esc(issue.severity)}</span>
              <span class="cat-badge">${esc(issue.category || 'GENERAL')}</span>
              ${issue.fixDifficulty ? `<span class="difficulty-badge diff-${issue.fixDifficulty}">${issue.fixDifficulty}</span>` : ''}
            </div>
          </div>
          <div class="issue-explanation">${esc(issue.explanation)}</div>
          <div class="issue-details">
            <button class="details-toggle" onclick="toggleDetails(this)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
              ดูสาเหตุฮาร์ดแวร์ & วิธีซ่อม
            </button>
            <div class="details-content">
              ${issue.rootCause ? `<div class="root-cause-text">🔧 สาเหตุ probable hardware: ${esc(issue.rootCause)}</div>` : ''}
              ${issue.fixSteps && issue.fixSteps.length > 0 ? `
                <div class="fix-steps-title">🔧 ขั้นตอนการซ่อม</div>
                <div class="fix-steps">
                  ${issue.fixSteps.map((step, i) => `
                    <div class="fix-step">
                      <div class="fix-step-num">${i + 1}</div>
                      <div>${esc(step)}</div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
              ${issue.relatedEvents && issue.relatedEvents.length > 0 ? `
                <div style="margin-top:10px;font-size:12px;color:var(--t3)">
                  Related: ${issue.relatedEvents.join(', ')}
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    `).join('')
  }

  // Recommendations
  const recs = data.recommendations || []
  const recSection = document.getElementById('import-recommendations-section')
  if (recs.length > 0) {
    recSection.style.display = 'block'
    document.getElementById('import-recs-list').innerHTML = recs.map(r =>
      `<div class="rec-item">${esc(r)}</div>`
    ).join('')
  } else {
    recSection.style.display = 'none'
  }
}

// ── Demo Sensor Renderer (Phase 6 Step 2 verification) ──────────────────────
// Exposed for the main process to invoke in `--demo-sensor --screenshot` mode,
// so the dashboard sensor widget can be rendered against verified raw data
// WITHOUT going through the full Scan → AI-Analyze flow (which needs an API key).
window.__renderDemo = function (sensorData) {
  showSidebar()
  navigateTo('dashboard', false)
  updateAIStatus()
  const sub = document.getElementById('dash-sub')
  if (sub) sub.textContent = 'Demo Sensor View · Intel Pentium G4560 (2C / 4T)'
  // Reset the status cards to a neutral demo state.
  setText('sc-cpu-val', '--')
  setBadge('sc-cpu-badge', 'Demo', 'good')
  setText('sc-ram-val', '--')
  setBadge('sc-ram-badge', '--', 'good')
  setText('sc-disk-val', '--')
  setBadge('sc-disk-badge', '--', 'good')
  setText('sc-crashes-val', 'ไม่พบ crash')
  setBadge('sc-crashes-badge', 'Clear', 'good')
  updateSensorWidget(sensorData || null)
}
