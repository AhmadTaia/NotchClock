// Simple countdown timer. Reports its "live activity" (time left) so the collapsed notch can show it.
window.NotchTimer = (() => {
  'use strict';

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const MAX_TIMER = 12 * 60 * MINUTE;
  const DEFAULT_TIMER = 5 * MINUTE;
  const TICK_MS = 250;
  const ALARM_MS = 10 * SECOND;

  const $ = (id) => document.getElementById(id);
  const card = $('timer');

  let timer = { duration: DEFAULT_TIMER, remaining: DEFAULT_TIMER, endAt: 0, running: false };
  let alarm = false;
  let alarmTimeout = 0;
  let tickId = 0;
  let lastActivity = '';
  let activityListener = () => {};

  const timeLeft = () => (timer.running ? Math.max(0, timer.endAt - Date.now()) : timer.remaining);

  function format(ms) {
    const total = Math.ceil(ms / SECOND);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // ---- actions (each replaces the timer state with a new object) --------------------------

  function startPause() {
    if (timer.running) timer = { ...timer, remaining: timeLeft(), running: false };
    else if (timer.remaining > 0) timer = { ...timer, endAt: Date.now() + timer.remaining, running: true };
    update();
  }

  function reset() {
    timer = { ...timer, remaining: timer.duration, running: false };
    update();
  }

  function setDuration(ms) {
    const duration = Math.max(MINUTE, Math.min(MAX_TIMER, ms));
    timer = { duration, remaining: duration, endAt: 0, running: false };
    update();
  }

  function adjust(deltaMs) {
    if (timer.running) {
      const left = Math.max(SECOND, Math.min(MAX_TIMER, timeLeft() + deltaMs));
      timer = { ...timer, endAt: Date.now() + left, duration: Math.max(timer.duration, left) };
      update();
    } else {
      setDuration(Math.round((timer.remaining + deltaMs) / MINUTE) * MINUTE);
    }
  }

  function finish() {
    timer = { ...timer, remaining: timer.duration, running: false };
    alarm = true;
    chime();
    window.notch.timerDone(format(timer.duration));
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

  // ---- rendering ----------------------------------------------------------------------

  function update() {
    if (timer.running && timeLeft() <= 0) {
      finish();
      return;
    }

    const left = timeLeft();
    const paused = !timer.running && timer.remaining < timer.duration;
    card.classList.toggle('running', timer.running);
    $('t-display').textContent = format(left);
    $('t-start').textContent = timer.running ? 'Pause' : paused ? 'Resume' : 'Start';
    $('t-mini').textContent = alarm ? 'Done' : (timer.running || paused) ? format(left) : '';

    if (timer.running && !tickId) tickId = setInterval(update, TICK_MS);
    if (!timer.running && tickId) { clearInterval(tickId); tickId = 0; }

    reportActivity();
  }

  function reportActivity() {
    const text = alarm ? 'Done' : timer.running ? format(timeLeft()) : '';
    const key = `${text}|${alarm}`;
    if (key === lastActivity) return;
    lastActivity = key;
    activityListener({ active: text !== '', text, alarm });
  }

  // ---- wiring -------------------------------------------------------------------------

  $('t-head').addEventListener('click', () => card.classList.toggle('open'));
  $('t-start').addEventListener('click', startPause);
  $('t-reset').addEventListener('click', reset);
  $('t-plus').addEventListener('click', () => adjust(MINUTE));
  $('t-minus').addEventListener('click', () => adjust(-MINUTE));
  card.querySelectorAll('[data-min]').forEach((b) => b.addEventListener('click', () => setDuration(Number(b.dataset.min) * MINUTE)));

  update();

  return {
    onActivity(callback) { activityListener = callback; lastActivity = ''; reportActivity(); },
    dismissAlarm,
    close: () => card.classList.remove('open'),
  };
})();
