// "Ask Gemini about my screen": screenshot the screen, open Gemini in an app-style window of the
// browser you're already signed into (Chrome / Edge / Brave), and paste the screenshot in.
// Nothing heavy stays loaded inside NotchClock.
const { screen, desktopCapturer, clipboard, shell, Notification } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const GEMINI_URL = 'https://gemini.google.com/app';
const HIDE_SETTLE_MS = 220; // let the island disappear before capturing

// Waits for the Gemini window to appear, focuses it and presses Ctrl+V. It only pastes if a window
// titled "Gemini" was actually activated, so it can never paste into some other app.
const PASTE_SCRIPT = [
  '$w = New-Object -ComObject WScript.Shell',
  '$ok = $false',
  'for ($i = 0; $i -lt 40 -and -not $ok; $i++) { Start-Sleep -Milliseconds 250; $ok = $w.AppActivate("Gemini") -or $w.AppActivate("Google Gemini") }',
  'if ($ok) { Start-Sleep -Milliseconds 1800; if ($w.AppActivate("Gemini") -or $w.AppActivate("Google Gemini")) { $w.SendKeys("^v") } }',
].join('; ');

function findChromiumBrowser() {
  const env = process.env;
  const candidates = [
    [env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [env.ProgramFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    [env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  ];
  for (const parts of candidates) {
    if (!parts[0]) continue;
    const exe = path.join(...parts);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
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

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Ask Gemini', body, silent: true }).show();
}

/**
 * @param {{ island: import('electron').BrowserWindow, logError: Function }} deps
 */
async function askAboutScreen({ island, logError }) {
  const islandVisible = island && island.isVisible();
  if (islandVisible) island.hide();
  await new Promise((resolve) => setTimeout(resolve, HIDE_SETTLE_MS));

  let shot = null;
  try {
    shot = await captureScreen();
  } catch (err) {
    logError('gemini-capture', err);
  } finally {
    if (islandVisible) island.showInactive();
  }
  const haveShot = shot && !shot.isEmpty();
  if (haveShot) clipboard.writeImage(shot);

  const browser = findChromiumBrowser();
  if (!browser) {
    shell.openExternal(GEMINI_URL);
    if (haveShot) notify('Screenshot copied. Press Ctrl+V in Gemini to attach it.');
    return;
  }

  // --app gives a clean window without tabs/address bar, using your normal signed-in profile.
  spawn(browser, [`--app=${GEMINI_URL}`], { detached: true, stdio: 'ignore' }).unref();
  if (!haveShot) return;
  const paster = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PASTE_SCRIPT], {
    windowsHide: true,
    stdio: 'ignore',
  });
  paster.on('error', (err) => logError('gemini-paste', err));
  notify('Screenshot attached. If it isn\'t, press Ctrl+V.');
}

module.exports = { askAboutScreen };
