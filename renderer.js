/* ════════════════════════════════════════════════════════════
   SysLog AI — Renderer (UI Logic)
   ════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  settings: null,
  lastLogs: null,
  lastResults: null,
  history: [],
  currentFilter: 'all'
}

// ── Model Lists ────────────────────────────────────────────────────────────
const MODELS = {
  gemini: [
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (แนะนำ - เร็วและประหยัด)' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (วิเคราะห์ลึก)' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (รุ่นใหม่ล่าสุด)' },
  ],
  claude: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5 (เร็วสุด)' },
    { value: 'claude-opus-4-20250514', label: 'Claude Opus 4 (ดีสุด)' },
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
  ollama: []
}

const API_KEY_LINKS = {
  gemini: 'https://aistudio.google.com/apikey',
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  qwen: 'https://dashscope.aliyuncs.com/',
}

const TIPS = [
  'AI จะวิเคราะห์ correlation ระหว่าง events หลายจุดพร้อมกัน',
  'Event logs จาก 7 วันล่าสุดถูกนำมาวิเคราะห์เพื่อหา pattern',
  'AI สามารถตรวจจับความสัมพันธ์ระหว่าง Windows Update กับปัญหาที่เกิดขึ้น',
  'ข้อมูล Driver และ Network events ช่วยระบุสาเหตุที่ซ่อนอยู่',
  'Crash dump ให้ข้อมูลที่ละเอียดมากสำหรับการวิเคราะห์ BSOD',
]

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  loadHistory()
  state.settings = await window.electronAPI.getSettings()

  if (state.settings.firstRun) {
    hideSidebar()
    navigateTo('setup', false)
    setupWizardInit()
  } else {
    showSidebar()
    navigateTo('dashboard', false)
    updateAIStatus()
  }
})

function hideSidebar() { document.getElementById('sidebar').style.display = 'none' }
function showSidebar() { document.getElementById('sidebar').style.display = '' }

// ── Navigation ────────────────────────────────────────────────────────────
function navigateTo(page, updateNav = true) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  const target = document.getElementById('page-' + page)
  if (target) { target.classList.add('active') }

  if (updateNav) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
    const navItem = document.querySelector(`[data-page="${page}"]`)
    if (navItem) navItem.classList.add('active')
  }
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
      el.textContent = TIPS[i % TIPS.length]
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

  // Model dropdown
  populateModelDropdown('settings-model', s.aiProvider, s.aiModel)

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
