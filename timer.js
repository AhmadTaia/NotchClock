// Timer + stopwatch card. Reports its "live activity" (running time) so the collapsed pill can show it.
window.NotchTimer = (() => {
  'use strict';

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const MAX_TIMER = 12 * 60 * MINUTE;
  const DEFAULT_TIMER = 5 * MINUTE;
  const TICK_MS = 100;
  const ALARM_MS = 10 * SECOND;

  const $ = (id) => document.getElementById(id);
  const card = $('timer');
  const seg = card.querySelector('.seg');
  const MODE_LABEL = { timer: 'Timer', stopwatch: 'Stopwatch' };

  let mode = 'timer';
  let timer = { duration: DEFAULT_TIMER, remaining: DEFAULT_TIMER, endAt: 0, running: false };
  let stopwatch = { elapsed: 0, startAt: 0, running: false };
  let alarm = false;
  let alarmTimeout = 0;
  let tickId = 0;
  let lastActivity = '';
  let activityListener = () => {};

  const timerLeft = () => (timer.running ? Math.max(0, timer.endAt - Date.now()) : timer.remaining);
  const stopwatchTime = () => (stopwatch.running ? stopwatch.elapsed + Date.now() - stopwatch.startAt : stopwatch.elapsed);

  function formatClock(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = String(totalSeconds % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  const formatTimer = (ms) => formatClock(Math.ceil(ms / SECOND));
  const formatStopwatch = (ms) => `${formatClock(Math.floor(ms / SECOND))}.${Math.floor((ms % SECOND) / 100)}`;

  // ---- state changes (each returns a new state object) ----------------------------------

  function startPause() {
    if (mode === 'timer') {
      if (timer.running) {
        timer = { ...timer, remaining: timerLeft(), running: false };
      } else if (timer.remaining > 0) {
        timer = { ...timer, endAt: Date.now() + timer.remaining, running: true };
      }
    } else if (stopwatch.running) {
      stopwatch = { ...stopwatch, elapsed: stopwatchTime(), running: false };
    } else {
      stopwatch = { ...stopwatch, startAt: Date.now(), running: true };
    }
    update();
  }

  function reset() {
    if (mode === 'timer') timer = { ...timer, remaining: timer.duration, running: false };
    else stopwatch = { elapsed: 0, startAt: 0, running: false };
    update();
  }

  function setDuration(ms) {
    const duration = Math.max(MINUTE, Math.min(MAX_TIMER, ms));
    timer = { duration, remaining: duration, endAt: 0, running: false };
    update();
  }

  function adjust(deltaMs) {
    if (timer.running) {
      const left = Math.max(SECOND, Math.min(MAX_TIMER, timerLeft() + deltaMs));
      timer = { ...timer, endAt: Date.now() + left, duration: Math.max(timer.duration, left) };
      update();
    } else {
      const base = timer.remaining === timer.duration ? timer.duration : timer.remaining;
      setDuration(Math.round((base + deltaMs) / MINUTE) * MINUTE);
    }
  }

  function finish() {
    timer = { ...timer, remaining: timer.duration, running: false };
    alarm = true;
    chime();
    window.notch.timerDone(formatTimer(timer.duration));
    clearTimeout(alarmTimeout);
    alarmTimeout = setTimeout(dismissAlarm, ALARM_MS);
    update();
  }

  function dismissAlarm() {
    if (!alarm) return;
    alarm = false;
    clearTimeout(alarmTimeout);
    update();
  }

  // ---- sound --------------------------------------------------------------------------

  let chimeContext = null;
  function chime() {
    try {
      chimeContext = chimeContext || new AudioContext();
      const t0 = chimeContext.currentTime;
      [0, 0.28, 0.56].forEach((offset, i) => {
        const osc = chimeContext.createOscillator();
        const gain = chimeContext.createGain();
        osc.type = 'sine';
        osc.frequency.value = i === 2 ? 1175 : 880;
        gain.gain.setValueAtTime(0.0001, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.25);
        osc.connect(gain).connect(chimeContext.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.3);
      });
    } catch (err) {
      window.notch.logError('chime', err && err.message ? err.message : String(err));
    }
  }

  // ---- rendering + ticking ------------------------------------------------------------

  function update() {
    if (timer.running && timerLeft() <= 0) {
      finish();
      return;
    }

    const running = mode === 'timer' ? timer.running : stopwatch.running;
    card.classList.toggle('stopwatch', mode === 'stopwatch');
    card.classList.toggle('running', running);
    seg.classList.toggle('stopwatch', mode === 'stopwatch');
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));

    if (mode === 'timer') {
      const left = timerLeft();
      $('t-display').textContent = formatTimer(left);
      $('t-fill').style.transform = `scaleX(${timer.duration ? 1 - left / timer.duration : 0})`;
      const paused = !timer.running && timer.remaining < timer.duration;
      $('t-start').textContent = timer.running ? 'Pause' : paused ? 'Resume' : 'Start';
    } else {
      const elapsed = stopwatchTime();
      $('t-display').textContent = formatStopwatch(elapsed);
      $('t-start').textContent = stopwatch.running ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start';
    }

    const anyRunning = timer.running || stopwatch.running;
    if (anyRunning && !tickId) tickId = setInterval(update, TICK_MS);
    if (!anyRunning && tickId) { clearInterval(tickId); tickId = 0; }

    updateHeader();
    reportActivity();
  }

  /** The slim row shown while the card is closed: what's running and how long. */
  function updateHeader() {
    let label = 'Timer & Stopwatch';
    let mini = '';
    if (alarm) { label = 'Timer'; mini = 'Done'; }
    else if (timer.running) { label = MODE_LABEL.timer; mini = formatTimer(timerLeft()); }
    else if (stopwatch.running) { label = MODE_LABEL.stopwatch; mini = formatClock(Math.floor(stopwatchTime() / SECOND)); }
    else if (card.classList.contains('open')) label = MODE_LABEL[mode];
    $('t-label').textContent = label;
    $('t-mini').textContent = mini;
  }

  function setOpen(open) {
    card.classList.toggle('open', open);
    updateHeader();
  }

  function reportActivity() {
    let text = '';
    if (alarm) text = 'Done';
    else if (timer.running) text = formatTimer(timerLeft());
    else if (stopwatch.running) text = formatClock(Math.floor(stopwatchTime() / SECOND));
    const key = `${text}|${alarm}`;
    if (key === lastActivity) return;
    lastActivity = key;
    activityListener({ active: text !== '', text, alarm });
  }

  // ---- wiring -------------------------------------------------------------------------

  $('t-head').addEventListener('click', () => setOpen(!card.classList.contains('open')));
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; update(); }));
  $('t-start').addEventListener('click', startPause);
  $('t-reset').addEventListener('click', reset);
  $('t-plus').addEventListener('click', () => adjust(MINUTE));
  $('t-minus').addEventListener('click', () => adjust(-MINUTE));
  card.querySelectorAll('[data-min]').forEach((b) => b.addEventListener('click', () => setDuration(Number(b.dataset.min) * MINUTE)));

  update();

  return {
    onActivity(callback) { activityListener = callback; lastActivity = ''; reportActivity(); },
    dismissAlarm,
    close: () => setOpen(false),
  };
})();
