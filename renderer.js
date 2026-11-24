// NotchClock renderer: spring-driven island, clock, media card; timer + visualizer live in their own files.
(() => {
  'use strict';

  // Collapsed: a small notch hanging from the top edge, short enough not to cover browser tabs.
  const COLLAPSED_HEIGHT = 26;
  const COLLAPSED_MIN_WIDTH = 38;
  const COLLAPSED_RADIUS = 13;
  const COLLAPSED_PADDING = 18; // horizontal breathing room when it grows for media / timers
  const EXPANDED_WIDTH = 360;
  const EXPANDED_RADIUS = 26;
  const MAX_HEIGHT = 540;
  const COLLAPSE_DELAY_MS = 60; // just enough to ignore brushing past the edge
  const PROGRESS_TICK_MS = 500;

  const $ = (id) => document.getElementById(id);
  const island = $('island');
  const full = $('full');
  const compactInner = $('c-inner');

  /** Damped spring: slightly under-damped for the Dynamic Island "settle" bounce. */
  class Spring {
    constructor(value, stiffness = 420, damping = 32) {
      this.value = value;
      this.target = value;
      this.velocity = 0;
      this.stiffness = stiffness;
      this.damping = damping;
    }

    /** @returns {boolean} true while still moving */
    step(dt) {
      const MAX_STEP = 1 / 120;
      for (let left = dt; left > 0; left -= MAX_STEP) {
        const h = Math.min(left, MAX_STEP);
        const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
        this.velocity += force * h;
        this.value += this.velocity * h;
      }
      if (Math.abs(this.value - this.target) < 0.25 && Math.abs(this.velocity) < 0.5) {
        this.value = this.target;
        this.velocity = 0;
        return false;
      }
      return true;
    }
  }

  const springs = {
    w: new Spring(COLLAPSED_MIN_WIDTH),
    h: new Spring(COLLAPSED_HEIGHT),
    r: new Spring(COLLAPSED_RADIUS),
  };

  let expanded = false;
  let hovering = false;
  let frameId = 0;
  let lastFrame = 0;
  let collapseTimer = 0;
  let media = { has: false };
  let mediaReceivedAt = 0;

  // ---- spring animation loop (only runs while something is moving) ----------------------

  function retarget() {
    if (expanded) {
      springs.w.target = EXPANDED_WIDTH;
      springs.h.target = Math.min(MAX_HEIGHT, full.offsetHeight);
      springs.r.target = EXPANDED_RADIUS;
      // Main process watches the real cursor against this size and tells us when it leaves.
      window.notch.islandOpen({ w: EXPANDED_WIDTH, h: springs.h.target });
    } else {
      // The pill hugs whatever the collapsed view shows (clock, app icon + bars, timer).
      springs.w.target = Math.max(COLLAPSED_MIN_WIDTH, compactInner.offsetWidth + COLLAPSED_PADDING);
      const toast = island.classList.contains('connect-toast');
      springs.h.target = toast ? TOAST_HEIGHT : COLLAPSED_HEIGHT;
      springs.r.target = toast ? TOAST_HEIGHT / 2 : COLLAPSED_RADIUS;
    }
    if (!frameId) {
      lastFrame = 0;
      frameId = requestAnimationFrame(frame);
    }
  }

  function frame(time) {
    const dt = lastFrame ? Math.min((time - lastFrame) / 1000, 0.05) : 1 / 60;
    lastFrame = time;
    const movingW = springs.w.step(dt);
    const movingH = springs.h.step(dt);
    const movingR = springs.r.step(dt);
    applyFrame();
    frameId = movingW || movingH || movingR ? requestAnimationFrame(frame) : 0;
  }

  function applyFrame() {
    const w = Math.max(1, springs.w.value);
    const h = Math.max(1, springs.h.value);
    island.style.width = `${w}px`;
    island.style.height = `${h}px`;
    // Top corners stay square so the notch reads as part of the screen edge.
    const r = Math.max(0, Math.min(springs.r.value, w / 2, h));
    island.style.borderRadius = `0 0 ${r}px ${r}px`;
  }

  // Keeps the island fitted to its content (media appearing, timer mode switching, etc.).
  new ResizeObserver(() => { if (expanded) retarget(); }).observe(full);

  // ---- hover / expand / collapse -------------------------------------------------------

  function expand() {
    if (expanded) return;
    expanded = true;
    island.classList.add('expanded');
    updateClock();
    retarget();
    updateProgress();
  }

  function collapse() {
    if (!expanded) return;
    expanded = false;
    island.classList.remove('expanded');
    window.notch.islandClosed();
    window.NotchTimer.close(); // reopen compact next time
    retarget();
  }

  island.addEventListener('mouseenter', () => {
    hovering = true;
    clearTimeout(collapseTimer);
    window.notch.setInteractive(true);
    window.NotchTimer.dismissAlarm();
    expand();
  });

  island.addEventListener('mouseleave', () => {
    hovering = false;
    // Let clicks fall through to apps underneath right away.
    window.notch.setInteractive(false);
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => { if (!hovering) collapse(); }, COLLAPSE_DELAY_MS);
  });

  window.notch.onBlur(() => { if (!hovering) collapse(); });

  // Backup for missed mouseleave events (see main.js): the cursor is definitely outside.
  window.notch.onPointerLeft(() => {
    hovering = false;
    clearTimeout(collapseTimer);
    collapse();
  });

  // ---- clock ---------------------------------------------------------------------------

  const hour12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 });
  const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' });

  function updateClock() {
    const now = new Date();
    const parts = timeFormat.formatToParts(now);
    const hm = parts.filter((p) => p.type === 'hour' || p.type === 'minute' || p.type === 'literal')
      .map((p) => p.value).join('').trim();
    const period = parts.find((p) => p.type === 'dayPeriod');
    $('hm').textContent = hm;
    $('sec').textContent = `:${String(now.getSeconds()).padStart(2, '0')}`;
    $('day').textContent = dayFormat.format(now);
    $('date-line').textContent = dateFormat.format(now) + (period ? `  ·  ${period.value}` : '');
  }

  function scheduleClock() {
    // The collapsed notch shows a static icon, so only touch the DOM while the panel is open.
    if (expanded) updateClock();
    // Re-align to the next whole second so the seconds tick exactly on time.
    setTimeout(scheduleClock, 1000 - (Date.now() % 1000) + 5);
  }

  // ---- media ---------------------------------------------------------------------------

  // Simplified brand marks for sites/apps we can recognise (24x24, circular).
  const RING = '<circle cx="12" cy="12" r="11.6" fill="none" stroke="rgba(255,255,255,.22)" stroke-width=".8"/>';
  const TIKTOK_NOTE = 'M12.5 6.4h2c.2 1.3 1 2.2 2.4 2.4v2c-.9 0-1.7-.3-2.4-.7v4.1a3.2 3.2 0 1 1-3.2-3.2v2a1.2 1.2 0 1 0 1.2 1.2z';
  const BRAND_ICONS = {
    youtube: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#FF0000"/><path d="M9.6 7.6v8.8l7-4.4z" fill="#fff"/></svg>',
    ytmusic: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#FF0000"/><circle cx="12" cy="12" r="6.3" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M10.3 9.2v5.6l4.4-2.8z" fill="#fff"/></svg>',
    spotify: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1ED760"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M6.4 9.2c3.8-1.1 7.8-.8 11.2 1" stroke-width="1.9"/><path d="M7 12.4c3.1-.9 6.4-.6 9.1.9" stroke-width="1.6"/><path d="M7.6 15.3c2.5-.6 5-.4 7.1.7" stroke-width="1.3"/></g></svg>',
    instagram: '<svg viewBox="0 0 24 24"><defs><linearGradient id="igGrad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FEDA75"/><stop offset=".35" stop-color="#FA7E1E"/><stop offset=".62" stop-color="#D62976"/><stop offset="1" stop-color="#4F5BD5"/></linearGradient></defs><circle cx="12" cy="12" r="12" fill="url(#igGrad)"/><rect x="6.6" y="6.6" width="10.8" height="10.8" rx="3.3" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="15.2" cy="8.8" r=".9" fill="#fff"/></svg>',
    tiktok: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#111"/>${RING}<path d="${TIKTOK_NOTE}" fill="#25F4EE" transform="translate(-.5 -.4)"/><path d="${TIKTOK_NOTE}" fill="#FE2C55" transform="translate(.5 .4)"/><path d="${TIKTOK_NOTE}" fill="#fff"/></svg>`,
    netflix: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#111"/>${RING}<path d="M9 6.5h2.1l1.9 6V6.5h2v11h-2.1l-1.9-6v6H9z" fill="#E50914"/></svg>`,
    twitch: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#9146FF"/><path d="M8 6.5h9v6.2L14.6 15H12l-1.8 1.8V15H8z" fill="#fff"/><rect x="11.1" y="8.7" width="1.3" height="3" fill="#9146FF"/><rect x="14" y="8.7" width="1.3" height="3" fill="#9146FF"/></svg>',
    soundcloud: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#FF5500"/><g stroke="#fff" stroke-width="1.1" stroke-linecap="round"><path d="M6.4 15.4v-2.6M8 15.4v-3.6M9.6 15.4v-4.6"/></g><path d="M11 15.6V9.8a3.5 3.5 0 0 1 6.5 1.6 2.1 2.1 0 0 1-.1 4.2z" fill="#fff"/></svg>',
    facebook: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1877F2"/><path d="M13.2 18.5v-5.6h1.9l.3-2.2h-2.2V9.3c0-.6.2-1.1 1.1-1.1h1.2V6.3a15 15 0 0 0-1.7-.1c-1.7 0-2.8 1-2.8 2.9v1.6H9.1v2.2H11v5.6z" fill="#fff"/></svg>',
    x: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#111"/>${RING}<path d="M7.6 7.2h2.6l6.2 9.6h-2.6z" fill="#fff"/><path d="M16 7.2l-7.6 9.6" stroke="#fff" stroke-width="1.4"/></svg>`,
    note: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#2C2C2E"/><path d="M10.2 16.2a2 2 0 1 1-1-1.7V7.6l6.6-1.4v8a2 2 0 1 1-1-1.7V8.4l-4.6 1z" fill="#fff"/></svg>',
  };
  const VIZ_COLORS = {
    youtube: '#ff4e45', ytmusic: '#ff4e45', spotify: '#1ed760', instagram: '#e1306c', tiktok: '#25f4ee',
    netflix: '#e50914', twitch: '#a970ff', soundcloud: '#ff7a33', facebook: '#4c8ef7', x: '#ffffff',
  };

  // Matched against browser window titles (e.g. "Reels • Instagram - Google Chrome"). Order matters.
  const SITES = [
    ['ytmusic', 'YouTube Music', /youtube music/i],
    ['youtube', 'YouTube', /youtube/i],
    ['instagram', 'Instagram', /instagram/i],
    ['tiktok', 'TikTok', /tiktok/i],
    ['netflix', 'Netflix', /netflix/i],
    ['twitch', 'Twitch', /twitch/i],
    ['soundcloud', 'SoundCloud', /soundcloud/i],
    ['spotify', 'Spotify', /spotify/i],
    ['facebook', 'Facebook', /facebook/i],
    ['x', 'X', /( \/ X\b|twitter)/i],
  ];
  const BROWSERS = [['chrome', 'Chrome'], ['msedge', 'Edge'], ['firefox', 'Firefox'], ['vivaldi', 'Vivaldi'],
    ['brave', 'Brave'], ['opera', 'Opera'], ['308046b0af4a39cb', 'Firefox']];
  // Installed web-app (PWA) ids Chrome/Edge use in the media session's app id.
  const PWA_IDS = { cinhimbnkkaeohfgghhklpknlkffjgod: 'ytmusic', agimnkijcaahngcdmfeangaknmldooml: 'youtube' };

  const SITE_MEMORY_LIMIT = 50;
  const siteMemory = new Map();

  function siteFromTitles(titles, mediaTitle) {
    const list = Array.isArray(titles) ? titles.map(String) : [];
    // Prefer the window whose title mentions what's playing, then any window on a known site.
    const probe = String(mediaTitle || '').slice(0, 24).toLowerCase();
    const ordered = probe ? [...list.filter((t) => t.toLowerCase().includes(probe)), ...list] : list;
    for (const title of ordered) {
      const site = SITES.find(([, , re]) => re.test(title));
      if (site) return site;
    }
    return null;
  }

  /**
   * Works out which app/site is playing and the icon to show for it.
   * @returns {{ key: string, name: string, svg: string, img: string }}
   */
  function detectApp(state) {
    const appId = String(state.source || '');
    const id = appId.toLowerCase();
    const exeIcon = typeof state.appIcon === 'string' && state.appIcon.startsWith('data:image/') ? state.appIcon : '';
    const brand = (key, name) => ({ key, name, svg: BRAND_ICONS[key], img: '' });

    const pwa = Object.keys(PWA_IDS).find((k) => id.includes(k));
    if (pwa) return brand(PWA_IDS[pwa], PWA_IDS[pwa] === 'ytmusic' ? 'YouTube Music' : 'YouTube');
    if (id.includes('spotify')) return brand('spotify', 'Spotify');

    const browser = BROWSERS.find(([needle]) => id.includes(needle));
    if (browser) {
      // Window titles only show each window's active tab, so remember the site a track was
      // seen on (usually when it started) and keep using it after switching tabs.
      const trackKey = `${appId}|${state.title}`;
      const site = siteFromTitles(state.windows, state.title) || siteMemory.get(trackKey);
      if (site) {
        siteMemory.set(trackKey, site);
        if (siteMemory.size > SITE_MEMORY_LIMIT) siteMemory.delete(siteMemory.keys().next().value);
        return brand(site[0], `${site[1]} · ${browser[1]}`);
      }
      // Unknown site: show the browser's own icon.
      if (exeIcon) return { key: 'exe', name: browser[1], svg: '', img: exeIcon };
      return brand(state.album ? 'ytmusic' : 'youtube', browser[1]);
    }

    const name = appId.split('!')[0].replace(/\.exe$/i, '').split(/[\\/]/).pop() || 'Media';
    if (exeIcon) return { key: 'exe', name, svg: '', img: exeIcon };
    return brand('note', id.includes('zunemusic') ? 'Media Player' : name);
  }

  function formatSeconds(total) {
    const s = Math.max(0, Math.floor(total));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function setArt(el, dataUrl) {
    const valid = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/');
    el.style.backgroundImage = valid ? `url("${dataUrl}")` : '';
    el.classList.toggle('loaded', valid);
  }

  function applyMedia(state) {
    if (!state || typeof state !== 'object') return;
    // Windows Energy Saver turns the battery bar yellow (like Low Power Mode).
    $('c-battery').classList.toggle('saver', state.saver === true);
    applyBuds(state.buds);
    applyHeadphones(state.headphones);
    const previous = media;
    const app = detectApp(state);
    media = {
      has: state.has === true,
      playing: state.has === true && state.playing === true,
      title: String(state.title || '') || 'Unknown title',
      artist: String(state.artist || ''),
      source: app.name,
      icon: app.img || app.key,
      pos: Number(state.pos) || 0,
      dur: Number(state.dur) || 0,
    };
    mediaReceivedAt = performance.now();

    island.classList.toggle('has-media', media.has);
    island.classList.toggle('playing', media.playing);

    if (media.icon !== previous.icon) {
      const holder = $('c-app');
      if (app.img) {
        const img = document.createElement('img');
        img.src = app.img;
        img.alt = '';
        holder.replaceChildren(img);
      } else {
        holder.innerHTML = app.svg;
      }
      island.style.setProperty('--viz-color', VIZ_COLORS[app.key] || '#ffffff');
    }
    if (state.artChanged) setArt($('m-art'), state.art);
    if (media.has) {
      $('m-title').textContent = media.title;
      $('m-artist').textContent = [media.artist, media.source].filter(Boolean).join('  ·  ');
      $('pp-icon').innerHTML = media.playing ? '&#xE769;' : '&#xE768;';
    }

    if (media.playing !== previous.playing) {
      if (media.playing) window.NotchViz.start();
      else window.NotchViz.stop();
    }
    updateProgress();
    if (!expanded && (media.has !== previous.has || media.playing !== previous.playing)) retarget();
  }

  let scrubbing = false;

  function renderProgress(pos) {
    $('p-fill').style.transform = `scaleX(${pos / media.dur})`;
    $('p-elapsed').textContent = formatSeconds(pos);
    $('p-remaining').textContent = `-${formatSeconds(media.dur - pos)}`;
  }

  function updateProgress() {
    const show = media.has && media.dur > 1;
    $('progress').classList.toggle('hidden', !show);
    if (!show || !expanded || scrubbing) return;
    const drift = media.playing ? (performance.now() - mediaReceivedAt) / 1000 : 0;
    renderProgress(Math.min(media.dur, media.pos + drift));
  }

  // Drag (or click) the progress bar to jump anywhere in the track.
  const seekBar = $('p-track');
  const positionAt = (event) => {
    const rect = seekBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * media.dur;
  };
  seekBar.addEventListener('pointerdown', (e) => {
    if (!media.has || media.dur <= 1) return;
    scrubbing = true;
    seekBar.setPointerCapture(e.pointerId);
    seekBar.classList.add('scrubbing');
    renderProgress(positionAt(e));
  });
  seekBar.addEventListener('pointermove', (e) => { if (scrubbing) renderProgress(positionAt(e)); });
  seekBar.addEventListener('pointerup', (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    seekBar.classList.remove('scrubbing');
    const target = positionAt(e);
    // Show the new position straight away until the player reports back.
    media = { ...media, pos: target };
    mediaReceivedAt = performance.now();
    renderProgress(target);
    window.notch.media(`seek ${target.toFixed(1)}`);
  });
  seekBar.addEventListener('pointercancel', () => { scrubbing = false; seekBar.classList.remove('scrubbing'); });

  document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => window.notch.media(btn.dataset.cmd));
  });

  // ---- timer live activity in the collapsed pill ---------------------------------------

  window.NotchTimer.onActivity(({ active, text, alarm }) => {
    island.classList.toggle('timer-active', active);
    island.classList.toggle('alarm', alarm);
    $('c-timer-text').textContent = text;
    if (!expanded) retarget();
  });

  // ---- "Connected" animation for earbuds / headphones --------------------------------------

  const TOAST_HEIGHT = 34;
  const CONNECT_TOAST_MS = 3200;
  // Built-in drawings for known models, used when no personal photo is present (e.g. for friends
  // installing from GitHub). Unknown models fall back to the generic headphone icon.
  const MODEL_DRAWINGS = { 'bowie-d05': '<svg class="wide" viewBox="0 0 40 44"><use href="#d05-shape"/></svg>' };
  const HEADPHONE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h1a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H5v-1a7 7 0 0 1 14 0v1h-2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z" fill="#fff"/></svg>';
  let toastTimer = 0;
  let budsSeen = null;   // null until the first report, so app start doesn't trigger it
  let phonesSeen = null;

  /** A photo if it exists, otherwise the given drawing. */
  function photoOr(src, fallbackMarkup, className = '') {
    const wrap = document.createElement('span');
    wrap.className = className;
    const img = new Image();
    img.alt = '';
    img.onerror = () => { wrap.innerHTML = fallbackMarkup; };
    img.src = src;
    wrap.appendChild(img);
    return wrap;
  }

  function showConnectToast(pictures) {
    $('c-connect-img').replaceChildren(...pictures);
    island.classList.remove('connect-toast');
    void island.offsetWidth; // restart the CSS animations
    island.classList.add('connect-toast');
    retarget();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      island.classList.remove('connect-toast');
      retarget();
    }, CONNECT_TOAST_MS);
  }

  function noteBudsConnection(connected) {
    if (budsSeen === false && connected) {
      const bud = '<svg viewBox="0 0 24 40"><use href="#bud-shape"/></svg>';
      showConnectToast([
        photoOr('assets/buds/left.png', bud),
        photoOr('assets/buds/right.png', bud, 'bud-r'),
      ]);
    }
    budsSeen = connected;
  }

  function notePhonesConnection(connected, modelId) {
    if (phonesSeen === false && connected) {
      const safeId = /^[a-z0-9-]+$/.test(modelId) ? modelId : '';
      showConnectToast([photoOr(`assets/headphones/${safeId || 'none'}.png`, MODEL_DRAWINGS[safeId] || HEADPHONE_ICON)]);
    }
    phonesSeen = connected;
  }

  // ---- Galaxy Buds battery card ---------------------------------------------------------

  const BUD_LOW = 20;
  const WEAR_DISCONNECTED = 0;
  const CASE_MEMORY_KEY = 'notchclock.lastCaseBattery';

  // Optional real photos: drop left.png / right.png / case.png into assets/buds/ (kept out of git)
  // and they replace the built-in drawings. Missing files simply keep the drawings.
  const BUD_PHOTO_DIR = 'assets/buds';
  function loadBudPhotos() {
    ['left', 'right', 'case'].forEach((part) => {
      const img = new Image();
      img.alt = '';
      img.className = part === 'case' ? 'case-img photo' : 'bud-img photo';
      img.onload = () => {
        const drawing = document.querySelector(`.bud[data-part="${part}"] svg`);
        if (drawing) drawing.replaceWith(img);
      };
      img.src = `${BUD_PHOTO_DIR}/${part}.png`;
    });
  }
  loadBudPhotos();

  function rememberCase(pct) {
    try { localStorage.setItem(CASE_MEMORY_KEY, String(pct)); } catch { /* storage unavailable */ }
  }

  function lastKnownCase() {
    try {
      const pct = Number(localStorage.getItem(CASE_MEMORY_KEY));
      return pct > 0 && pct <= 100 ? pct : null;
    } catch {
      return null;
    }
  }

  function setBud(part, value, { known, stale = false }) {
    const el = document.querySelector(`.bud[data-part="${part}"]`);
    const pct = Number(value);
    const valid = known && Number.isFinite(pct) && pct >= 0 && pct <= 100;
    el.classList.toggle('na', !valid);
    el.classList.toggle('stale', valid && stale);
    el.classList.toggle('low', valid && !stale && pct <= BUD_LOW);
    el.querySelector('.bud-pct').textContent = valid ? `${pct}%` : '—';
  }

  function applyBuds(buds) {
    const connected = !!buds && buds.connected === true;
    island.classList.toggle('has-buds', connected);
    // Animate on the Bluetooth link itself; the battery reading can take a few more seconds.
    noteBudsConnection(connected || (!!buds && buds.linked === true));
    if (!connected) return;
    setBud('left', buds.left, { known: buds.wearLeft !== WEAR_DISCONNECTED });
    setBud('right', buds.right, { known: buds.wearRight !== WEAR_DISCONNECTED });

    // The buds only know the case's charge while one of them is inside it; otherwise they send 0.
    // Like Galaxy Wearable, keep showing the last charge we saw (dimmed) in the meantime.
    const caseNow = Number(buds.case);
    if (caseNow > 0 && caseNow <= 100) {
      rememberCase(caseNow);
      setBud('case', caseNow, { known: true });
    } else {
      const last = lastKnownCase();
      setBud('case', last, { known: last !== null, stale: true });
    }
  }

  // ---- other headphones battery card ------------------------------------------------------

  const HEADPHONE_PHOTO_DIR = 'assets/headphones'; // personal photos, kept out of git
  let phonesModel = '';

  const GENERIC_HEADPHONE_PATH = '<path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h1a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H5v-1a7 7 0 0 1 14 0v1h-2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z" fill="currentColor"/>';

  function showHeadphonePhoto(modelId) {
    const img = $('phones-img');
    const icon = $('phones-icon');
    img.hidden = true;
    icon.style.display = '';
    // Show the model's drawing (or the generic icon) until/unless a personal photo loads.
    const drawing = MODEL_DRAWINGS[modelId];
    icon.classList.toggle('drawing', !!drawing);
    icon.setAttribute('viewBox', drawing ? '0 0 40 44' : '0 0 24 24');
    icon.innerHTML = drawing ? '<use href="#d05-shape"/>' : GENERIC_HEADPHONE_PATH;
    if (!/^[a-z0-9-]+$/.test(modelId)) return;
    img.onload = () => { img.hidden = false; icon.style.display = 'none'; };
    img.onerror = () => { img.hidden = true; icon.style.display = ''; };
    img.src = `${HEADPHONE_PHOTO_DIR}/${modelId}.png`;
  }

  function applyHeadphones(phones) {
    const connected = !!phones && phones.connected === true;
    island.classList.toggle('has-phones', connected);
    notePhonesConnection(connected, String((phones && phones.id) || ''));
    if (!connected) return;
    const modelId = String(phones.id || '');
    if (modelId !== phonesModel) {
      phonesModel = modelId;
      showHeadphonePhoto(modelId);
    }
    $('phones-name').textContent = String(phones.name || 'Headphones').slice(0, 40);
    const pct = Number(phones.battery);
    const valid = Number.isFinite(pct) && pct >= 0 && pct <= 100;
    $('phones-pct').textContent = valid ? `${pct}%` : '—';
    $('phones-fill').style.width = valid ? `${pct}%` : '0';
    $('phones').classList.toggle('low', valid && pct <= BUD_LOW);
  }

  // ---- battery (idle view) ---------------------------------------------------------------

  const BATTERY_FILL_WIDTH = 18.7; // matches the inner rect in index.html
  const LOW_BATTERY = 0.2;

  async function initBattery() {
    let battery = null;
    try {
      battery = navigator.getBattery ? await navigator.getBattery() : null;
    } catch (err) {
      window.notch.logError('battery', err && err.message ? err.message : String(err));
    }
    // Desktops report a permanently full, charging "battery"; show the clock there instead.
    const noBattery = !battery || (battery.level === 1 && battery.charging && battery.chargingTime === 0 && battery.dischargingTime === Infinity);
    if (noBattery) {
      island.classList.add('no-battery');
      if (!expanded) retarget();
      return;
    }

    const holder = $('c-battery');
    const render = () => {
      const level = Math.max(0, Math.min(1, battery.level));
      const pct = Math.round(level * 100);
      $('c-batt-fill').setAttribute('width', (BATTERY_FILL_WIDTH * Math.max(level, 0.04)).toFixed(2));
      $('c-batt-pct').textContent = `${pct}%`;
      holder.classList.toggle('charging', battery.charging);
      holder.classList.toggle('low', !battery.charging && level <= LOW_BATTERY);
      holder.title = `Battery ${pct}%${battery.charging ? ' (charging)' : ''}`;
      if (!expanded) retarget();
    };
    // Event-driven: Windows tells us when the level or charging state changes, no polling.
    battery.addEventListener('levelchange', render);
    battery.addEventListener('chargingchange', render);
    render();
  }

  // ---- boot ----------------------------------------------------------------------------

  window.notch.onMedia(applyMedia);
  setInterval(() => { if (expanded) updateProgress(); }, PROGRESS_TICK_MS);
  scheduleClock();
  initBattery();
  applyFrame();
})();
