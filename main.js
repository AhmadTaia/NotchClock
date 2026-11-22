// NotchClock main process: transparent always-on-top host window, media helper, tray, startup.
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, shell,
  session, desktopCapturer, Notification,
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOST_WIDTH = 480;
const HOST_HEIGHT = 640;
const MEDIA_COMMANDS = new Set(['toggle', 'next', 'prev']);
const HELPER_RESTART_MS = 3000;
const TOGGLE_SHORTCUT = 'Control+Alt+N';

let win = null;
let tray = null;
let helper = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const dataPath = (name) => path.join(app.getPath('userData'), name);

function logError(context, err) {
  const line = `${new Date().toISOString()} [${context}] ${err && err.message ? err.message : err}\n`;
  fs.appendFile(dataPath('error.log'), line, () => {});
}

// ---- window -------------------------------------------------------------------------------

function hostBounds() {
  const { bounds } = screen.getPrimaryDisplay();
  return {
    x: Math.round(bounds.x + (bounds.width - HOST_WIDTH) / 2),
    y: bounds.y,
    width: HOST_WIDTH,
    height: HOST_HEIGHT,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...hostBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // Clicks pass through everything except the island; the renderer flips this on hover.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.showInactive());
  win.on('blur', () => win.webContents.send('window-blur'));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  screen.on('display-metrics-changed', () => win.setBounds(hostBounds()));
}

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

// ---- media helper -------------------------------------------------------------------------

function startHelper() {
  // In an installed build the app lives inside app.asar; PowerShell needs the unpacked copy.
  const script = path.join(__dirname, 'helper', 'media.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true,
  });

  let buffer = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let state;
      try {
        state = JSON.parse(line);
      } catch (err) {
        logError('helper-json', err);
        continue;
      }
      withAppIcon(state).then((full) => {
        if (win && !win.isDestroyed()) win.webContents.send('media', full);
      });
    }
  });
  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (text) => logError('helper', text.trim()));
  helper.on('exit', (code) => {
    helper = null;
    if (!quitting) {
      logError('helper-exit', `code ${code}, restarting`);
      setTimeout(startHelper, HELPER_RESTART_MS);
    }
  });
}

// ---- real app icons for the playing app ---------------------------------------------------

const iconCache = new Map();

/** Adds `appIcon` (PNG data URL of the playing app's own .exe icon) when the helper found the exe. */
async function withAppIcon(state) {
  const exe = state && typeof state.exePath === 'string' ? state.exePath : '';
  if (!exe || !path.isAbsolute(exe) || !/\.exe$/i.test(exe)) return state;
  if (!iconCache.has(exe)) {
    try {
      const icon = await app.getFileIcon(exe, { size: 'large' });
      iconCache.set(exe, icon.isEmpty() ? '' : icon.toDataURL());
    } catch (err) {
      logError('app-icon', err);
      iconCache.set(exe, '');
    }
  }
  return { ...state, appIcon: iconCache.get(exe) };
}

// ---- system audio for the visualizer -----------------------------------------------------

/**
 * Grants the island's own page Windows loopback audio (what's coming out of the speakers)
 * so the bars follow the real sound. The renderer drops the video track immediately and
 * nothing is recorded or stored.
 */
function allowLoopbackAudio() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const fromIsland = win && request.frame && request.frame.url && request.frame.url.startsWith('file://');
    if (!fromIsland) {
      callback({});
      return;
    }
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch((err) => {
        logError('loopback', err);
        callback({});
      });
  });
}

// ---- startup + tray -----------------------------------------------------------------------

function loginItemOptions(openAtLogin) {
  // In dev (electron.exe + app folder) Windows must relaunch electron with this folder as arg.
  return app.isPackaged
    ? { openAtLogin }
    : { openAtLogin, path: process.execPath, args: [app.getAppPath()] };
}

function isStartupEnabled() {
  return app.getLoginItemSettings(loginItemOptions(true)).openAtLogin;
}

function setStartup(enabled) {
  app.setLoginItemSettings(loginItemOptions(enabled));
}

function enableStartupOnFirstRun() {
  const marker = dataPath('first-run.done');
  if (fs.existsSync(marker)) return;
  setStartup(true);
  fs.writeFileSync(marker, new Date().toISOString());
}

function drawTrayIcon() {
  // 16x16 BGRA bitmap: a black pill with a green dot.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cy = 7.5;
      const inPill = Math.abs(y - cy) <= 5 &&
        ((x >= 5 && x <= 10) || Math.hypot(x - 5, y - cy) <= 5 || Math.hypot(x - 10, y - cy) <= 5);
      const inDot = Math.hypot(x - 11, y - cy) <= 2;
      if (inDot) buf.set([0x58, 0xd1, 0x30, 0xff], i);
      else if (inPill) buf.set([0x10, 0x10, 0x10, 0xff], i);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(drawTrayIcon());
  tray.setToolTip('NotchClock');
  const menu = Menu.buildFromTemplate([
    { label: `Show / hide island  (${TOGGLE_SHORTCUT.replace('Control', 'Ctrl')})`, click: toggleWindow },
    { label: 'Start with Windows', type: 'checkbox', checked: isStartupEnabled(), click: (item) => setStartup(item.checked) },
    { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', toggleWindow);
}

// ---- IPC ----------------------------------------------------------------------------------

ipcMain.on('set-interactive', (_e, interactive) => {
  if (!win) return;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
});

const SEEK_COMMAND = /^seek \d{1,6}(\.\d{1,3})?$/;

ipcMain.on('media-command', (_e, command) => {
  if (!helper || typeof command !== 'string') return;
  if (!MEDIA_COMMANDS.has(command) && !SEEK_COMMAND.test(command)) return;
  helper.stdin.write(command + '\n');
});

ipcMain.on('timer-done', (_e, label) => {
  if (!Notification.isSupported()) return;
  new Notification({ title: 'Timer done', body: `Your ${String(label).slice(0, 32)} timer has finished.`, silent: true }).show();
});

ipcMain.on('log-error', (_e, context, message) => logError(`renderer:${String(context).slice(0, 40)}`, String(message).slice(0, 500)));

// ---- lifecycle ----------------------------------------------------------------------------

app.whenReady().then(() => {
  app.setAppUserModelId('NotchClock');
  enableStartupOnFirstRun();
  allowLoopbackAudio();
  createWindow();
  createTray();
  startHelper();
  globalShortcut.register(TOGGLE_SHORTCUT, toggleWindow);
});

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (helper) helper.kill();
});

app.on('window-all-closed', (e) => e.preventDefault());
