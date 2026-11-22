const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notch', {
  setInteractive: (interactive) => ipcRenderer.send('set-interactive', Boolean(interactive)),
  media: (command) => ipcRenderer.send('media-command', String(command)),
  onMedia: (callback) => ipcRenderer.on('media', (_e, state) => callback(state)),
  onBlur: (callback) => ipcRenderer.on('window-blur', () => callback()),
  askGemini: () => ipcRenderer.send('ask-gemini'),
  timerDone: (label) => ipcRenderer.send('timer-done', String(label).slice(0, 32)),
  logError: (context, message) => ipcRenderer.send('log-error', String(context).slice(0, 40), String(message).slice(0, 500)),
});
