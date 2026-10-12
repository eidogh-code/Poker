// Сетевая игра на клиенте: соединение с сервером и RemoteGame — снимки сервера в форме офлайн-Game,
// чтобы стол, карты, кнопки и таймер работали одинаково в обоих режимах.
(function (P) {
  'use strict';

  const KEY_STORE = 'poker.netKey';
  const URL_STORE = 'poker.server';
  const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища ключ живёт до закрытия */ } },
  };

  // Секретный ключ устройства: по нему сервер узнаёт игрока после переподключения.
  function deviceKey() {
    let key = store.get(KEY_STORE);
    if (!key || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      store.set(KEY_STORE, key);
    }
    return key;
  }

  // Адрес сервера: wss://… (из приложения нужен защищённый адрес). Пустой — сетевая игра не настроена.
  function normalizeUrl(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const withScheme = /^wss?:\/\//i.test(text) ? text : `wss://${text.replace(/^https?:\/\//i, '')}`;
    try { return new URL(withScheme).toString().replace(/\/$/, ''); } catch (e) { return ''; }
  }

  const serverUrl = () => normalizeUrl(store.get(URL_STORE) || (P.Config && P.Config.serverUrl) || '');
  const setServerUrl = (url) => store.set(URL_STORE, normalizeUrl(url));

  /* ---------- соединение ---------- */

  const listeners = new Map();
  let ws = null;
  let wanted = false;
  let attempt = 0;
  let retryTimer = 0;
  let status = 'off';
  let myId = null;

  // Ошибка одного подписчика не должна лишать сообщений остальных.
  function emit(type, payload) {
    const call = (fn, ...args) => {
      try { fn(...args); } catch (e) { console.error(`Ошибка обработки «${type}»:`, e); }
    };
    (listeners.get(type) || []).forEach((fn) => call(fn, payload));
    (listeners.get('*') || []).forEach((fn) => call(fn, type, payload));
  }

  function setStatus(next) {
    status = next;
    emit('status', next);
  }

  function connect() {
    wanted = true;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const url = serverUrl();
    if (!url) { setStatus('unconfigured'); return; }
    clearTimeout(retryTimer);
    setStatus('connecting');
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      setStatus('error');
      scheduleRetry();
      return;
    }
    ws = sock;
    // Обработчики привязаны к своему сокету: события старого соединения не трогают новое.
    sock.onopen = () => {
      if (sock !== ws) return;
      attempt = 0;
      const profile = P.Profile.get();
      send({ t: 'hello', key: deviceKey(), nick: profile.nick, avatar: profile.avatar });
    };
    sock.onmessage = (e) => {
      if (sock !== ws) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'welcome') { myId = msg.id; setStatus('online'); }
      if (msg.t === 'replaced') wanted = false;
      emit(msg.t, msg);
    };
    sock.onclose = () => {
      if (sock !== ws) return;
      ws = null;
      setStatus(wanted ? 'reconnecting' : 'off');
      if (wanted) scheduleRetry();
    };
    sock.onerror = () => { /* onclose придёт следом и запланирует повтор */ };
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt++;
    retryTimer = setTimeout(() => { if (wanted) connect(); }, delay);
  }

  function disconnect() {
    wanted = false;
    clearTimeout(retryTimer);
    const old = ws;
    ws = null;
    if (old) { old.onclose = null; old.onmessage = null; old.close(); }
    setStatus('off');
  }

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  }

  /* ---------- RemoteGame: снимок сервера в форме Game ---------- */

  class RemoteGame {
    constructor(room) {
      this.network = true;
      this.mode = room.mode;
      this.cfg = { mode: room.mode, stack: room.buyIn };
      this.holeN = room.mode === 'omaha' ? 4 : 2;
      this.potLimit = room.mode === 'omaha';
      this.players = [];
      this.board = [];
      this.dealer = -1;
      this.toAct = -1;
      this.handNo = 0;
      this.sb = 0;
      this.bb = 0;
      this.pot = 0;
      this.maxBet = 0;
      this.showdown = false;
      this.handsLeft = null;
      this.room = room;
    }

    // null — игрок ещё в очереди на место (смотрит раздачу со стороны).
    get me() { return this.players.find((p) => p.human) || null; }

    setRoom(room) { this.room = room; }

    // Своё место ставим первым — интерфейс рисует его снизу, как в офлайне. Чужие люди показываются с аватаром.
    // Аватары берём из данных комнаты (в снимках их нет) и ещё раз проверяем: сервер мог оказаться чужим.
    apply(s) {
      const mine = s.players.findIndex((p) => p.id === myId);
      const shift = mine < 0 ? 0 : mine;
      const n = s.players.length;
      const rotated = s.players.map((_, i) => s.players[(i + shift) % n]);
      const members = new Map(((this.room && this.room.members) || []).map((m) => [m.id, m]));
      this.players = rotated.map((p) => {
        const member = members.get(p.id);
        return {
          ...p, human: p.id === myId, person: p.human, persona: null,
          avatar: member ? P.Profile.normalize({ avatar: member.avatar }).avatar : null,
          tone: s.players.indexOf(p),
          hole: p.hole.map((c) => c || null),
        };
      });
      const idx = (id) => this.players.findIndex((p) => p.id === id);
      Object.assign(this, {
        mode: s.mode, holeN: s.holeN, potLimit: s.potLimit, handNo: s.handNo, sb: s.sb, bb: s.bb,
        pot: s.pot, maxBet: s.maxBet, board: s.board, showdown: s.showdown, handsLeft: s.handsLeft,
        dealer: idx(s.dealerId), toAct: s.toActId ? idx(s.toActId) : -1,
      });
      this.cfg.stack = s.buyIn;
    }

    handsLeftAtLevel() { return this.handsLeft; }
    humanAct(action) { send({ t: 'act', action }); }
    nextHand() { /* следующую раздачу сервер начинает сам */ }
    returnToTable() { send({ t: 'return' }); }
    leave() { send({ t: 'leave' }); }
    stop() { /* соединение и комнату ведёт лобби */ }
  }

  P.Net = {
    connect, disconnect, send, on, serverUrl, setServerUrl, normalizeUrl,
    get status() { return status; },
    get id() { return myId; },
    RemoteGame,
  };
})(window.Poker = window.Poker || {});
