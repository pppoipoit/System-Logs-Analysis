const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  checkOllama: () => ipcRenderer.invoke('check-ollama'),
  testApiKey: (p) => ipcRenderer.invoke('test-api-key', p),
  collectLogs: () => ipcRenderer.invoke('collect-logs'),
  analyzeLogs: (logs, settings) => ipcRenderer.invoke('analyze-logs', { logs, settings }),
  exportLogs: (logs) => ipcRenderer.invoke('export-logs', logs),
})
