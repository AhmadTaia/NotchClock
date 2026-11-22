// "Ask Gemini about my screen": screenshot the screen, open gemini.google.com in its own window
// (signed in with your own Google account / Gemini subscription) and attach the screenshot.
const { BrowserWindow, screen, desktopCapturer, clipboard, shell } = require('electron');

const GEMINI_URL = 'https://gemini.google.com/app';
const PARTITION = 'persist:gemini'; // keeps you signed in between launches
const WINDOW_WIDTH = 460;
const WINDOW_MAX_HEIGHT = 780;
const SCREEN_MARGIN = 16;
const HIDE_SETTLE_MS = 220; // let the island/Gemini windows disappear before capturing
const EDITOR_RETRY_MS = 500;
const EDITOR_MAX_TRIES = 24;
const CLIPBOARD_RESTORE_MS = 1500;
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'media', 'notifications']);

// A normal Chrome user agent: Google's sign-in refuses unknown embedded browsers.
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

// Gemini's prompt box (a contenteditable); several selectors in case Google changes markup.
const FOCUS_EDITOR_JS = `(() => {
  const el = document.querySelector('rich-textarea .ql-editor, div.ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]');
  if (!el) return false;
  el.focus();
  return true;
})()`;

let geminiWin = null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isGoogleUrl(raw) {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== 'https:') return false;
    return hostname === 'google.com' || hostname.endsWith('.google.com') || hostname.endsWith('.gstatic.com') ||
      hostname.endsWith('.googleusercontent.com') || hostname === 'accounts.youtube.com';
  } catch {
    return false;
  }
}

function openExternally(raw) {
  try {
    const { protocol } = new URL(raw);
    if (protocol === 'https:' || protocol === 'http:') shell.openExternal(raw);
  } catch {
    // ignore malformed links
  }
}

function createWindow(isQuitting) {
  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.min(WINDOW_MAX_HEIGHT, workArea.height - SCREEN_MARGIN * 2);
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height,
    x: workArea.x + workArea.width - WINDOW_WIDTH - SCREEN_MARGIN,
    y: workArea.y + SCREEN_MARGIN,
    title: 'Gemini',
    autoHideMenuBar: true,
    backgroundColor: '#131314',
    show: false,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const contents = win.webContents;
  contents.setUserAgent(CHROME_UA);
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  // Only Google pages load in this window; everything else opens in your normal browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isGoogleUrl(url)) return { action: 'allow' };
    openExternally(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isGoogleUrl(url)) {
      event.preventDefault();
      openExternally(url);
    }
  });
  // Closing just hides it, so the conversation and sign-in survive.
  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });

  win.loadURL(GEMINI_URL);
  return win;
}

async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const thumbnailSize = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  return source ? source.thumbnail : null;
}

async function waitForLoad(contents) {
  if (!contents.isLoading()) return;
  await new Promise((resolve) => contents.once('did-stop-loading', resolve));
}

/** Focuses Gemini's prompt box and pastes the screenshot from the clipboard. */
async function attachScreenshot(win, logError) {
  const contents = win.webContents;
  await waitForLoad(contents);
  for (let attempt = 0; attempt < EDITOR_MAX_TRIES; attempt++) {
    if (win.isDestroyed()) return false;
    try {
      if (await contents.executeJavaScript(FOCUS_EDITOR_JS, true)) {
        contents.paste();
        return true;
      }
    } catch (err) {
      logError('gemini-attach', err);
    }
    await delay(EDITOR_RETRY_MS);
  }
  return false; // e.g. still on the sign-in page
}

function snapshotClipboard() {
  const image = clipboard.readImage();
  return image.isEmpty() ? { text: clipboard.readText() } : { image };
}

function restoreClipboard(saved) {
  if (saved.image) clipboard.writeImage(saved.image);
  else clipboard.writeText(saved.text || '');
}

/**
 * @param {{ island: BrowserWindow, isQuitting: () => boolean, logError: Function }} deps
 */
async function askAboutScreen({ island, isQuitting, logError }) {
  const islandVisible = island && island.isVisible();
  if (islandVisible) island.hide();
  if (geminiWin && !geminiWin.isDestroyed() && geminiWin.isVisible()) geminiWin.hide();
  await delay(HIDE_SETTLE_MS);

  let shot = null;
  try {
    shot = await captureScreen();
  } catch (err) {
    logError('gemini-capture', err);
  } finally {
    if (islandVisible) island.showInactive();
  }

  if (!geminiWin || geminiWin.isDestroyed()) geminiWin = createWindow(isQuitting);
  geminiWin.show();
  geminiWin.focus();

  if (!shot || shot.isEmpty()) return;
  const saved = snapshotClipboard();
  clipboard.writeImage(shot);
  const attached = await attachScreenshot(geminiWin, logError);
  // If it couldn't attach (e.g. you still need to sign in), leave the screenshot on the clipboard for Ctrl+V.
  if (attached) setTimeout(() => restoreClipboard(saved), CLIPBOARD_RESTORE_MS);
}

module.exports = { askAboutScreen };
