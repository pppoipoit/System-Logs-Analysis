'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// macCollector.js — macOS system log / telemetry collector for SysLog AI
//
// Produces the EXACT same JSON schema as src/collector/logCollector.ps1 so the
// existing renderer.js UI requires zero changes. Designed to be:
//   • required() directly from main.js (darwin) — no separate process needed
//   • runnable via `node macCollector.js` for debugging (prints JSON to stdout)
//
// Every section is wrapped in try/catch and degrades to an empty array/object
// (matching the PowerShell collector behaviour) so the app never crashes if a
// command is unavailable or the user lacks Full Disk Access.
// ─────────────────────────────────────────────────────────────────────────────

const { execSync } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')

// Run a shell command, return trimmed stdout or '' on any failure.
function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function num(v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

async function collectMacLogs() {
  const debug = []
  const output = {}

  // ── 1. System Info ────────────────────────────────────────────────────────
  try {
    const osName = sh('sw_vers -productName') || 'macOS'
    const osVer = sh('sw_vers -productVersion') || ''
    const osBuild = sh('sw_vers -buildVersion') || ''
    const cpu = sh('sysctl -n machdep.cpu.brand_string') || 'Unknown'

    const totalBytes = num(parseInt(sh('sysctl -n hw.memsize') || '0', 10), 0)
    const ramGB = totalBytes ? Math.round((totalBytes / 1073741824) * 10) / 10 : 0

    // Free memory from vm_stat (free + speculative + inactive pages are reclaimable)
    let freeBytes = 0
    const vm = sh('vm_stat')
    const psMatch = vm.match(/page size of ([\d]+) bytes/i)
    const pageSize = psMatch ? parseInt(psMatch[1], 10) : 4096
    const grab = (label) => {
      const m = vm.match(new RegExp(label + ':\\s+([\\d]+)'))
      return m ? parseInt(m[1], 10) : 0
    }
    freeBytes = (grab('Pages free') + grab('Pages speculative') + grab('Pages inactive')) * pageSize
    const freeRamGB = Math.round((freeBytes / 1073741824) * 10) / 10
    const freeRamPct = totalBytes ? Math.round((freeBytes / totalBytes) * 1000) / 10 : 0

    const upSec = os.uptime()
    const uptime = Math.round((upSec / 3600) * 10) / 10
    const lastBoot = new Date(Date.now() - upSec * 1000).toISOString()

    output.systemInfo = {
      computerName: os.hostname(),
      os: (osName + (osVer ? ' ' + osVer : '')).trim(),
      osBuild,
      cpu: cpu.trim(),
      ramGB,
      freeRamGB,
      freeRamPct,
      lastBoot,
      uptime
    }
  } catch (e) {
    debug.push('SystemInfo failed: ' + e.message)
    output.systemInfo = {
      computerName: os.hostname(), os: 'macOS', osBuild: '', cpu: 'Unknown',
      ramGB: 0, freeRamGB: 0, freeRamPct: 0, lastBoot: '', uptime: 0
    }
  }

  // ── 2. Disk Info (local fixed volumes only) ────────────────────────────────
  try {
    const raw = sh('df -k -l') // -l = local filesystems only (excludes network)
    const lines = raw.split('\n').slice(1).filter(Boolean)
    const disks = []
    for (const line of lines) {
      const cols = line.split(/\s+/)
      const blocks = parseInt(cols[1], 10)
      const used = parseInt(cols[2], 10)
      const avail = parseInt(cols[3], 10)
      const mount = cols[cols.length - 1]
      if (!blocks || isNaN(blocks)) continue
      if (mount === 'synthetic') continue // skip the APFS synthetic root
      const totalGB = Math.round((blocks * 1024 / 1073741824) * 10) / 10
      const freeGB = Math.round((avail * 1024 / 1073741824) * 10) / 10
      const usedPercent = blocks ? Math.round((used / blocks) * 1000) / 10 : 0
      disks.push({ drive: mount, freeGB, totalGB, usedPercent })
    }
    output.diskInfo = disks
  } catch (e) {
    debug.push('DiskInfo failed: ' + e.message)
    output.diskInfo = []
  }

  // ── 3. Crash Dumps (macOS panic / diagnostic reports) ─────────────────────
  try {
    const dir = '/Library/Logs/DiagnosticReports'
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => /\.(ips|panic|crash)$/i.test(f)) } catch { /* no access */ }
    const dumps = files
      .map((f) => {
        const fp = path.join(dir, f)
        let mtime = 0
        try { mtime = fs.statSync(fp).mtimeMs } catch {}
        return { name: f, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    output.crashDumps = {
      count: dumps.length,
      recent: dumps.slice(0, 3).map((d) => ({ Name: d.name, Date: new Date(d.mtime).toISOString() }))
    }
  } catch (e) {
    debug.push('CrashDumps failed: ' + e.message)
    output.crashDumps = { count: 0, recent: [] }
  }

  // ── Unified Log helper (macOS Equivalent of Windows Event Log) ─────────────
  function logShow(predicate, max) {
    const cmd = `log show --style json --last 7d --predicate '${predicate}'`
    const out = sh(cmd)
    if (!out) return []
    let arr
    try {
      arr = JSON.parse(out)
    } catch {
      try {
        arr = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      } catch {
        return []
      }
    }
    if (!Array.isArray(arr)) arr = [arr]
    return arr.slice(0, max).map((e) => ({
      TimeCreated: e.timestamp || '',
      Id: 0,
      ProviderName: e.subsystem || e.process || '',
      LevelDisplayName: e.messageType === 17 ? 'Fault' : e.messageType === 16 ? 'Error' : 'Info',
      Message: e.eventMessage || ''
    }))
  }

  // ── 4. System & App Events ─────────────────────────────────────────────────
  try {
    output.systemEvents = logShow('messageType >= 16', 40)
  } catch (e) { debug.push('SystemEvents failed: ' + e.message); output.systemEvents = [] }

  try {
    output.appEvents = logShow('messageType >= 16 AND processImagePath CONTAINS "/Applications"', 20)
  } catch (e) { debug.push('AppEvents failed: ' + e.message); output.appEvents = [] }

  // ── 5. Recent System Updates ──────────────────────────────────────────────
  try {
    const raw = sh('system_profiler SPInstallHistoryDataType')
    const blocks = raw.split(/\n\s*\n/)
    const updates = []
    for (const b of blocks) {
      const name = (b.match(/Display Name:\s*(.+)/) || [])[1]
      const ver = (b.match(/Display Version:\s*(.+)/) || [])[1]
      const date = (b.match(/Install Date:\s*(.+)/) || [])[1]
      if (name) {
        updates.push({
          HotFixID: ver ? ver.trim() : name.trim(),
          Description: name.trim(),
          InstalledOn: date ? new Date(date.trim()).toISOString() : ''
        })
      }
    }
    output.recentUpdates = updates.slice(0, 5)
  } catch (e) { debug.push('Updates failed: ' + e.message); output.recentUpdates = [] }

  // ── 6. Network Events (WiFi) ──────────────────────────────────────────────
  try {
    output.networkEvents = logShow('subsystem == "com.apple.wifi" AND messageType >= 16', 20)
  } catch (e) { debug.push('NetworkEvents failed: ' + e.message); output.networkEvents = [] }

  // ── 7. Driver Events (IOKit / kernel) ─────────────────────────────────────
  try {
    output.driverEvents = logShow('subsystem CONTAINS "IOKit" AND messageType >= 16', 15)
  } catch (e) { debug.push('DriverEvents failed: ' + e.message); output.driverEvents = [] }

  // ── 8. Top Processes (by RAM) ─────────────────────────────────────────────
  try {
    const raw = sh('ps -axo rss,comm -r')
    const lines = raw.split('\n').slice(1).filter(Boolean)
    output.topProcesses = lines.slice(0, 10).map((l) => {
      const cols = l.trim().split(/\s+/)
      const rssKB = parseInt(cols[0], 10) || 0
      const comm = cols.slice(1).join(' ') || ''
      const name = comm.split('/').pop() || comm
      return { Name: name, RAM_MB: Math.round((rssKB / 1024) * 10) / 10 }
    })
  } catch (e) { debug.push('Processes failed: ' + e.message); output.topProcesses = [] }

  if (debug.length) output._debug = debug.join(' | ')
  return output
}

module.exports = { collectMacLogs }

// Allow running directly: `node macCollector.js`
if (require.main === module) {
  collectMacLogs()
    .then((d) => { console.log(JSON.stringify(d)) })
    .catch((e) => { console.error(e); process.exit(1) })
}