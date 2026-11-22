# NotchClock

A tiny Dynamic Island–style notch for Windows. It hangs from the top edge of your screen like a MacBook notch and springs open when you hover over it.

## Features

- **Stays out of the way:** collapsed, it's a small notch with a clock icon, flush with the top edge of the screen and short enough not to cover your browser tabs. Clicks anywhere outside it go straight through to your apps.
- **Hover to expand:** a fluid, spring-animated panel with the time (including seconds) and the date.
- **Live media controls:** works with anything Windows can control (Spotify, YouTube, YouTube Music, Instagram, Netflix, VLC and more).
  - artwork, title and artist
  - play / pause / next / previous
  - **drag the progress bar** to jump anywhere in the track
- **Real app icons:** while something plays, the pill shows that app's icon. Desktop apps use their own Windows icon. Recognised sites (YouTube, YouTube Music, Instagram, TikTok, Netflix, Twitch, SoundCloud, Facebook, X) get their logo. The icon hides when you pause.
- **Audio-reactive bars:** the bars follow the actual sound coming out of your speakers (bass on the left, treble on the right) in the app's colour.
- **Ask Gemini about your screen:** press the Gemini button (or **Ctrl+Alt+G**). NotchClock takes a screenshot, opens Gemini in your signed-in Chrome/Edge as a clean app window and pastes the screenshot in, so you can just type your question. It uses your own Google account and Gemini plan.
- **Timer & stopwatch:** a compact row that opens when you click it. While one is running, the collapsed pill shows the countdown, Live Activity–style, and you get a chime and a notification when a timer finishes.
- **Lightweight and always on:** starts with Windows and lives in the system tray. **Ctrl+Alt+N** shows or hides it.

## Install

1. Go to the [**Releases**](https://github.com/AhmadTaia/NotchClock/releases) page.
2. Download `NotchClock-Setup-x.y.z.exe` and run it.
3. The island appears at the top centre of your main screen.

> **Windows may warn you.** The installer isn't code-signed, so SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. If **Smart App Control** is on, it may block unsigned apps entirely. Run from source instead (below).

## Run from source

Requires [Node.js](https://nodejs.org) 18+ on Windows 10/11.

```powershell
git clone https://github.com/AhmadTaia/NotchClock.git
cd NotchClock
npm install
npm start
```

Build the installer yourself:

```powershell
npm run dist
```

The installer is written to `dist/`.

## Using it

| Action | How |
| --- | --- |
| Open the panel | Hover over the island |
| Seek in a track | Click or drag the progress bar |
| Ask Gemini about the screen | Gemini button in the panel, or **Ctrl+Alt+G** |
| Timer / stopwatch | Click the **Timer & Stopwatch** row |
| Show / hide | **Ctrl+Alt+N** or double-click the tray icon |
| Start with Windows on/off, exit | Right-click the tray icon |

## How it works

- **Electron** renders a transparent, always-on-top window. Mouse events pass through everywhere except the island itself.
- **Media info and controls** come from Windows' own media session API (`GlobalSystemMediaTransportControls`), read by a small PowerShell helper (`helper/media.ps1`). No native modules are needed.
- **The bars** analyse the system audio output (WASAPI loopback) with the Web Audio API. Audio is only analysed in memory, never recorded or saved, and processing stops when playback pauses.
- **Gemini** opens in an app-style window of the browser you are already signed into (Chrome, Edge or Brave), so it uses your own Google account and Gemini plan. The screenshot is copied to your clipboard and pasted into Gemini automatically; press Ctrl+V if it is not.
- **Site detection for browsers** uses window titles, because browsers only tell Windows that "Chrome" (for example) is playing, not which site.

## Privacy

NotchClock makes no network requests of its own. The only exception is the Gemini window: when you press the Gemini button, a screenshot of your screen is attached to Gemini and sent to Google only when you send the message. Settings and logs stay in `%APPDATA%\notchclock`.

## License

[MIT](LICENSE) © 2026 AhmadTaia
