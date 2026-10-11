// Синтезированные звуки стола — без внешних файлов.
(function (P) {
  'use strict';

  let ctx = null;
  let enabled = true;

  function audio() {
    if (!ctx) {
      const A = window.AudioContext || window.webkitAudioContext;
      if (!A) return null;
      ctx = new A();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(c, freq, t0, dur, type, vol) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  function noise(c, t0, dur, vol, freq) {
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
  }

  function play(kind) {
    if (!enabled) return;
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    switch (kind) {
      case 'card': noise(c, t, 0.06, 0.5, 3200); break;
      case 'chip': tone(c, 2600, t, 0.07, 'triangle', 0.05); tone(c, 3400, t + 0.04, 0.06, 'triangle', 0.04); break;
      case 'check': noise(c, t, 0.05, 0.7, 600); noise(c, t + 0.1, 0.05, 0.7, 600); break;
      case 'fold': noise(c, t, 0.14, 0.35, 1400); break;
      case 'turn': tone(c, 880, t, 0.18, 'sine', 0.05); break;
      case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(c, f, t + i * 0.09, 0.4, 'triangle', 0.06)); break;
      default: break;
    }
  }

  P.Sound = {
    play,
    get enabled() { return enabled; },
    set enabled(v) { enabled = Boolean(v); },
  };
})(window.Poker = window.Poker || {});
