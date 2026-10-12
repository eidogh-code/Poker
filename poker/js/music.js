// Фоновая музыка: неспешный лаунж-джаз, синтезированный на лету — без файлов и сэмплов.
// Rhodes-комп, шагающий контрабас, щётки и райд со свингом, изредка — короткие фразы в пентатонике.
(function (P) {
  'use strict';

  const MASTER = 0.1;       // ≈ −20 dB после компрессора: музыка строго «на фоне»
  const LOOKAHEAD = 0.2;    // на сколько секунд вперёд планируются события
  const TICK_MS = 40;       // период планировщика
  const FADE = { in: 2, out: 1.5, hide: 0.3 }; // плавность включения, выключения и сворачивания, с
  const SWING = 0.64;       // где внутри доли звучит вторая восьмая (2/3 — классический свинг)
  const BASS_LOW = 33;      // диапазон контрабаса, MIDI
  const BASS_HIGH = 55;

  // Гармония: 16 тактов в фа мажоре / ре миноре, по аккорду на такт.
  // root — нота баса (MIDI), tones — ступени для шагающего баса, keys — бескорневой войсинг Rhodes,
  // lead — можно ли поверх играть пентатонику (на альтерированных доминантах — нет).
  const M7 = [0, 3, 7, 10];
  const DOM = [0, 4, 7, 10];
  const MAJ = [0, 4, 7, 11];
  const HALF = [0, 3, 6, 10];
  const chord = (root, tones, keys, lead) => ({ root, tones, keys, lead });
  const GM9 = chord(43, M7, [58, 62, 65, 69], true);
  const C13 = chord(36, DOM, [58, 62, 64, 69], true);
  const FMAJ9 = chord(41, MAJ, [57, 60, 64, 67], true);
  const DM9 = chord(38, M7, [53, 57, 60, 64], true);
  const EM7B5 = chord(40, HALF, [55, 58, 62, 64], false);
  const A7B9 = chord(45, DOM, [55, 58, 61, 64], false);
  const D7B9 = chord(38, DOM, [54, 57, 60, 63], false);
  const AM9 = chord(45, M7, [55, 59, 60, 64], true);
  const BBMAJ9 = chord(46, MAJ, [57, 60, 62, 65], true);
  const FORM = [
    GM9, C13, FMAJ9, DM9, EM7B5, A7B9, DM9, D7B9,
    GM9, C13, AM9, DM9, BBMAJ9, A7B9, DM9, D7B9,
  ];
  const PENTA = [62, 65, 67, 69, 72, 74, 77, 79]; // ре-минорная пентатоника
  // Ритмы компа: [восьмая в такте 0..7, длительность в долях].
  const COMP = [
    [[0, 3.5]], [[0, 1.4], [5, 1.2]], [[1, 1.2], [4, 1.8]],
    [[3, 1], [6, 1.6]], [[0, 1], [3, 2.2]], [[2, 0.6], [5, 2]],
  ];

  let ctx = null;
  let bus = null;       // постоянные узлы: шины инструментов и мастер
  let noiseBuf = null;
  let wanted = false;   // желание вызывающего кода (то, что вернёт enabled)
  let playing = false;  // планировщик работает и не затухает
  let broken = false;   // Web Audio недоступен или упал — молчим
  let volume = 1;
  let timer = null;
  let stopTimer = null;
  let beat = 0.75;      // длительность доли, с; темп выбирается при создании контекста
  let nextTime = 0;
  let step = 0;         // номер доли с начала игры
  let plan = null;      // план текущего такта
  let leadRest = 2;     // сколько тактов мелодия ещё молчит
  let leadIdx = 3;      // текущая ступень пентатоники

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const fitBass = (m) => (m > BASS_HIGH ? fitBass(m - 12) : m < BASS_LOW ? fitBass(m + 12) : m);

  function fail(e) {
    broken = true;
    playing = false;
    clearInterval(timer);
    clearTimeout(stopTimer);
    timer = null;
    try { if (ctx) ctx.close().catch(() => {}); } catch (_) { /* контекст уже закрыт */ }
    console.warn('Музыка отключена:', e);
  }

  // resume/suspend могут отклониться (политика автозапуска) — это не повод ломать музыку навсегда.
  function setRunning(on) {
    try {
      const p = on ? ctx.state !== 'running' && ctx.resume() : ctx.state === 'running' && ctx.suspend();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { fail(e); }
  }

  // ---------- Граф: инструменты → компрессор → затухание → громкость → выход ----------
  function makeBuffer(channels, sec, shape) {
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * shape(i / len);
    }
    return buf;
  }

  function gainNode(value, to) {
    const g = ctx.createGain();
    g.gain.value = value;
    if (to) g.connect(to);
    return g;
  }

  function filterNode(type, freq, to) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.connect(to);
    return f;
  }

  function buildGraph() {
    const out = gainNode(MASTER * volume, ctx.destination);
    const fade = gainNode(0, out);
    const comp = ctx.createDynamicsCompressor();
    const knobs = { threshold: -18, knee: 12, ratio: 4, attack: 0.01, release: 0.25 };
    Object.keys(knobs).forEach((k) => { comp[k].value = knobs[k]; });
    comp.connect(fade);
    const mix = gainNode(1, comp);
    // «Комната»: свёртка с синтезированным затухающим шумом.
    const verb = ctx.createConvolver();
    verb.buffer = makeBuffer(2, 1.4, (x) => Math.pow(1 - x, 3));
    verb.connect(gainNode(0.22, comp));
    const send = gainNode(1, verb);
    const keysTone = filterNode('lowpass', 3200, mix);
    keysTone.connect(send);
    const keys = gainNode(0.85, keysTone);
    // Тремоло Rhodes: один общий LFO на шину клавиш.
    const lfo = osc('sine', 4.3);
    lfo.connect(gainNode(0.12, keys.gain));
    lfo.start();
    const bass = gainNode(1, filterNode('lowpass', 800, mix));
    const drums = gainNode(1, mix);
    drums.connect(send);
    noiseBuf = makeBuffer(1, 1, () => 1);
    bus = { out, fade, keys, bass, drums };
  }

  // ---------- Инструменты: каждая нота сама отключает свою цепочку после окончания ----------
  function osc(type, freq) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  // Огибающая ноты: атака, спад к «полке» shelf·peak, отпускание после dur.
  function envelope(t, peak, attack, shelf, decay, dur, rel) {
    const env = gainNode(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.setTargetAtTime(peak * shelf, t + attack, decay);
    env.gain.setTargetAtTime(0, t + dur, rel);
    return env;
  }

  // Источник играет [t, end], затем отключает всю свою цепочку — узлы уходят сборщику мусора.
  function play(sources, t, end, chain) {
    sources.forEach((s) => { s.start(t); s.stop(end); });
    sources[0].onended = () => chain.forEach((n) => n.disconnect());
  }

  // Электропиано: FM-пара синусов, индекс модуляции быстро гаснет — мягкий удар молоточка.
  function epiano(midi, t, dur, vel) {
    const f = hz(midi);
    const car = osc('sine', f);
    const mod = osc('sine', f);
    const idx = gainNode(0);
    idx.gain.setValueAtTime(f * 1.4, t);
    idx.gain.exponentialRampToValueAtTime(f * 0.15, t + 0.4);
    const env = envelope(t, vel, 0.008, 0.35, 0.5, dur, 0.08);
    mod.connect(idx).connect(car.frequency);
    car.connect(env).connect(bus.keys);
    play([car, mod], t, t + dur + 0.5, [car, mod, idx, env]);
  }

  // Контрабас: треугольник через общий фильтр, мягкая атака и короткое затухание.
  function bassNote(midi, t, dur, vel) {
    const o = osc('triangle', hz(midi));
    const env = envelope(t, vel, 0.02, 0.45, 0.18, dur, 0.05);
    o.connect(env).connect(bus.bass);
    play([o], t, t + dur + 0.3, [o, env]);
  }

  // Щётки и тарелки: фильтрованный шум из общего буфера, при f1 — свип частоты.
  function noiseHit(t, dur, vol, type, f0, f1, attack) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const env = gainNode(0, bus.drums);
    const flt = filterNode(type, f0, env);
    flt.frequency.setValueAtTime(f0, t);
    if (f1) flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt);
    src.start(t, rand(0, 0.9));
    src.stop(t + dur + 0.02);
    src.onended = () => [src, flt, env].forEach((n) => n.disconnect());
  }

  // ---------- Сочинение такта: немного случайности в голосоведении и ритме ----------
  function planBass(ch, next) {
    const r = ch.root;
    if (Math.random() < 0.15) return [r, null, fitBass(r + 7), null]; // «на два» — половинками
    const n1 = fitBass(r + pick([ch.tones[1], ch.tones[2]]));
    let n2 = fitBass(r + pick([ch.tones[2], ch.tones[3], 12]));
    if (n2 === n1) n2 = fitBass(r + ch.tones[3]);
    const n3 = fitBass(next.root + pick([-1, 1, -1, -5])); // хроматический или квинтовый подход
    return [r, n1, n2, n3];
  }

  function voicing(keys) {
    let v = keys.slice();
    if (Math.random() < 0.3) v = [v[3] - 12].concat(v.slice(0, 3)); // верхний голос на октаву вниз
    if (Math.random() < 0.25) v = v.filter((_, i) => i !== 2);       // прозрачнее, без одного голоса
    return v;
  }

  function planComp(ch) {
    if (Math.random() < 0.1) return []; // пианист иногда пропускает такт
    return pick(COMP).map(([e, len]) => ({ e, len, notes: voicing(ch.keys), vel: rand(0.06, 0.09) }));
  }

  function planLead(ch) {
    leadRest = Math.max(0, leadRest - 1);
    if (leadRest > 0 || !ch.lead || Math.random() > 0.35) return [];
    leadRest = 3;
    const notes = [];
    let e = pick([0, 1, 2, 3]);
    const count = 3 + Math.floor(Math.random() * 3);
    while (e <= 7 && notes.length < count) {
      leadIdx = Math.min(PENTA.length - 1, Math.max(0, leadIdx + pick([-2, -1, -1, 1, 1, 2])));
      const gap = pick([1, 1, 2]);
      notes.push({ e, len: gap * 0.45, midi: PENTA[leadIdx], vel: rand(0.05, 0.075) });
      e += gap;
    }
    notes[notes.length - 1].len = 1.5; // последнюю ноту фразы тянем
    return notes;
  }

  function planBar(n) {
    const ch = FORM[n % FORM.length];
    const next = FORM[(n + 1) % FORM.length];
    return { bass: planBass(ch, next), comp: planComp(ch), lead: planLead(ch) };
  }

  // ---------- Планировщик: события одной доли ----------
  function playDrums(b, t) {
    const off = t + SWING * beat;
    noiseHit(t, 0.18, b % 2 ? 0.04 : 0.03, 'highpass', 7000, 0, 0.002); // райд на каждую долю
    if (b % 2 && Math.random() < 0.85) noiseHit(off, 0.12, 0.02, 'highpass', 7500, 0, 0.002);
    if (b % 2) {
      noiseHit(t, 0.05, 0.03, 'bandpass', 5000, 0, 0.002);       // хай-хэт ногой на 2 и 4
      noiseHit(t, 0.12, 0.05, 'bandpass', 1800, 1200, 0.004);    // шлепок щёткой
    } else {
      noiseHit(t, beat * 2, 0.015, 'bandpass', 900, 2600, beat * 0.6); // круговой свип
    }
  }

  function scheduleBeat(t) {
    const b = step % 4;
    if (b === 0 || !plan) plan = planBar(Math.floor(step / 4));
    const at = (e) => t + (e % 2 ? SWING * beat : 0) + rand(0, 0.008);
    const bassMidi = plan.bass[b];
    if (bassMidi !== null) {
      const len = plan.bass[b + 1] === null ? 2 : 1;
      bassNote(bassMidi, at(0), len * beat * 0.92, rand(0.32, 0.4));
    }
    plan.comp.forEach((h) => {
      if (h.e >> 1 !== b) return;
      const t0 = at(h.e);
      h.notes.forEach((m, i) => epiano(m, t0 + i * rand(0, 0.012), h.len * beat, h.vel));
    });
    plan.lead.forEach((n) => {
      if (n.e >> 1 === b) epiano(n.midi, at(n.e), n.len * beat, n.vel);
    });
    playDrums(b, t);
  }

  function tick() {
    try {
      const now = ctx.currentTime;
      if (nextTime < now) nextTime = now + 0.05; // после «засыпания» таймера не догоняем пропущенное
      while (nextTime < now + LOOKAHEAD) {
        scheduleBeat(nextTime);
        nextTime += beat;
        step += 1;
      }
    } catch (e) { fail(e); }
  }

  // ---------- Старт, остановка, затухание ----------
  function fadeTo(v, sec) {
    const g = bus.fade.gain;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(v, now + sec);
  }

  function start() {
    clearTimeout(stopTimer);
    setRunning(true);
    if (playing || broken) return;
    playing = true;
    if (!timer) {
      step = Math.ceil(step / 4) * 4; // продолжаем с начала такта
      plan = null;
      nextTime = ctx.currentTime + 0.1;
      timer = setInterval(tick, TICK_MS);
    }
    fadeTo(1, FADE.in);
  }

  function halt() {
    clearInterval(timer);
    timer = null;
    setRunning(false); // спящий контекст не тратит батарею
  }

  function stop(sec) {
    if (!playing) return;
    playing = false;
    fadeTo(0, sec);
    clearTimeout(stopTimer);
    stopTimer = setTimeout(halt, sec * 1000 + 80);
  }

  function init() {
    try {
      const A = window.AudioContext || window.webkitAudioContext;
      if (!A) { broken = true; return false; }
      ctx = new A();
      beat = 60 / rand(76, 84);
      buildGraph();
      return true;
    } catch (e) { fail(e); return false; }
  }

  function unlock() {
    if (broken) return;
    if (!ctx && !init()) return;
    if (wanted && !document.hidden) start();
    else if (!playing) setRunning(false);
  }

  function setEnabled(on) {
    wanted = Boolean(on);
    if (!ctx || broken) return; // включение до unlock() запомнено в wanted
    try {
      if (wanted && !document.hidden) start();
      else if (!wanted) stop(FADE.out);
    } catch (e) { fail(e); }
  }

  function setVolume(v) {
    const n = Number(v);
    if (Number.isFinite(n)) volume = Math.min(1, Math.max(0, n));
    if (!bus || broken) return;
    try { bus.out.gain.setTargetAtTime(MASTER * volume, ctx.currentTime, 0.05); } catch (e) { fail(e); }
  }

  document.addEventListener('visibilitychange', () => {
    if (!ctx || broken) return;
    try {
      if (document.hidden) stop(FADE.hide);
      else if (wanted) start();
    } catch (e) { fail(e); }
  });

  P.Music = {
    unlock,
    setEnabled,
    get enabled() { return wanted; },
    setVolume,
  };
})(window.Poker = window.Poker || {});
