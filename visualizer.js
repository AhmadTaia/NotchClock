// Audio-reactive bars driven by the real system audio output (WASAPI loopback via Electron).
// Nothing is recorded or saved: samples go straight into an AnalyserNode in memory.
window.NotchViz = (() => {
  'use strict';

  // Frequency band edges in Hz, one band per bar (bass on the left, treble on the right).
  const BAND_EDGES = [40, 120, 350, 1000, 3000, 9000];
  const IDLE_SCALE = 0.15;
  const ATTACK = 0.55;
  const DECAY = 0.82;
  const BAND_GAIN = [1.0, 1.05, 1.2, 1.45, 1.9]; // treble carries less energy; lift it a bit
  const FRAME_INTERVAL_MS = 1000 / 24; // smooth enough for 3px bars, ~20% less drawing than 30 fps

  let analyser = null;
  let audioContext = null;
  let bins = null;
  let bandRanges = [];
  let starting = null;
  let running = false;
  let frameId = 0;
  let lastDraw = 0;
  const levels = new Array(BAND_EDGES.length - 1).fill(0);

  let barGroups = null;
  function bars() {
    // The bar elements never change, so look them up once.
    if (!barGroups) barGroups = Array.from(document.querySelectorAll('.viz')).map((group) => Array.from(group.children));
    return barGroups;
  }

  async function ensureAnalyser() {
    if (analyser) return true;
    if (!starting) {
      starting = (async () => {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
          // Only the audio is wanted; drop the screen video track immediately.
          stream.getVideoTracks().forEach((track) => track.stop());
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) throw new Error('no loopback audio track');
          captureTracks = audioTracks;
          audioTracks.forEach((track) => track.addEventListener('ended', reattach));

          audioContext = new AudioContext();
          const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.55;
          source.connect(analyser);
          bins = new Uint8Array(analyser.frequencyBinCount);

          const hzPerBin = audioContext.sampleRate / analyser.fftSize;
          bandRanges = levels.map((_, i) => {
            const from = Math.max(1, Math.floor(BAND_EDGES[i] / hzPerBin));
            const to = Math.max(from + 1, Math.ceil(BAND_EDGES[i + 1] / hzPerBin));
            return [from, Math.min(to, bins.length)];
          });
          return true;
        } catch (err) {
          window.notch.logError('visualizer', err && err.message ? err.message : String(err));
          starting = null; // allow a retry next time playback starts
          return false;
        }
      })();
    }
    return starting;
  }

  // Loopback capture is tied to the output device that was default when it started. When the
  // output changes (earbuds/headphones connect or disconnect), drop it and capture the new one.
  let captureTracks = [];
  let reattachTimer = 0;
  const REATTACH_DELAY_MS = 700; // let Windows finish switching the default device
  const SILENCE_REATTACH_MS = 2500;
  const WATCHDOG_COOLDOWN_MS = 6000;
  let silentSince = 0;
  let lastWatchdogReattach = 0;

  function teardown() {
    captureTracks.forEach((track) => track.stop());
    captureTracks = [];
    if (audioContext) audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
    starting = null;
  }

  function reattach() {
    clearTimeout(reattachTimer);
    reattachTimer = setTimeout(async () => {
      teardown();
      if (!running) return; // will capture the right device next time playback starts
      running = false;
      cancelAnimationFrame(frameId);
      await start();
    }, REATTACH_DELAY_MS);
  }

  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', reattach);

  function frame(time) {
    if (!running) return;
    frameId = requestAnimationFrame(frame);
    if (time - lastDraw < FRAME_INTERVAL_MS) return;
    lastDraw = time;
    analyser.getByteFrequencyData(bins);

    // Watchdog: Bluetooth earbuds can drop/reconnect or switch modes without Windows reporting a
    // device change, which leaves the capture silently dead. Real music is never pure digital
    // silence for seconds, so if that happens while playing, capture the current output again.
    let energy = 0;
    for (let b = 1; b < bins.length; b++) energy += bins[b];
    if (energy > 0) {
      silentSince = 0;
    } else {
      if (!silentSince) silentSince = time;
      if (time - silentSince > SILENCE_REATTACH_MS && time - lastWatchdogReattach > WATCHDOG_COOLDOWN_MS) {
        lastWatchdogReattach = time;
        silentSince = 0;
        reattach();
        return;
      }
    }
    // Only one set of bars is ever visible (collapsed notch or open panel); skip the hidden one.
    const visible = document.getElementById('island').classList.contains('expanded') ? 1 : 0;
    const groups = [bars()[visible]].filter(Boolean);

    for (let i = 0; i < levels.length; i++) {
      const [from, to] = bandRanges[i];
      let peak = 0;
      for (let b = from; b < to; b++) peak = Math.max(peak, bins[b]);
      const target = Math.min(1, Math.pow(peak / 255, 1.6) * BAND_GAIN[i]);
      levels[i] = target > levels[i]
        ? levels[i] + (target - levels[i]) * ATTACK
        : levels[i] * DECAY;
      const scale = IDLE_SCALE + (1 - IDLE_SCALE) * levels[i];
      groups.forEach((group) => { if (group[i]) group[i].style.transform = `scaleY(${scale.toFixed(3)})`; });
    }
  }

  function rest() {
    levels.fill(0);
    bars().flat().forEach((bar) => { bar.style.transform = `scaleY(${IDLE_SCALE})`; });
  }

  async function start() {
    if (running) return;
    running = true;
    const ok = await ensureAnalyser();
    if (!ok || !running) return;
    if (audioContext.state === 'suspended') await audioContext.resume();
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frameId);
    // Suspending the context stops audio processing entirely while paused.
    if (audioContext && audioContext.state === 'running') audioContext.suspend();
    rest();
  }

  return { start, stop };
})();
