// Комнаты: ожидание игроков, запуск стола, снимки состояния для каждого игрока, банкротство, «отошёл», чат.
'use strict';

const crypto = require('node:crypto');
const { loadEngine } = require('./engine');

const P = loadEngine();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O и 1/I
const MAX_ROOMS = 500;
const MAX_BOT_ROOMS = 20;              // боты считаются на сервере — ограничиваем нагрузку на процессор
const MAX_SEATS = P.MAX_SEATS;
const MAX_REBUYS = 3;                  // пополнений на игрока за столом
const AUTO_NEXT_MS = 5000;
const REBUY_MS = 60 * 1000;
const SIT_OUT_MS = 3 * 60 * 1000;
const WAITING_GRACE_MS = 60 * 1000;    // сколько держим место в комнате до старта за отключившимся
const ROOM_IDLE_MS = 30 * 60 * 1000;   // комната без игры и без активности удаляется
const CHAT_HISTORY = 50;
const MAX_BUFFERED = 1 << 20;          // клиент, который не читает сокет, не должен копить память сервера

const newId = (prefix) => `${prefix}${crypto.randomBytes(6).toString('hex')}`;

// Единый путь отправки: соединение, отставшее больше чем на мегабайт, обрывается.
function safeSend(ws, data) {
  if (!ws || ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
  ws.send(data);
}

class Room {
  constructor(lobby, settings, host) {
    this.lobby = lobby;
    this.code = lobby.newCode();
    this.settings = settings;
    this.hostId = host.id;
    this.members = new Map();   // id → сессия
    this.chat = [];
    this.game = null;
    this.turns = new Map();     // id → { limits, deadline } — чтобы вернуть ход после переподключения
    this.rebuys = new Map();    // id → { resolve, timer, deadline }
    this.rebuyCount = new Map();
    this.sitOuts = new Map();   // id → { timer, deadline }
    this.graceTimers = new Map();
    this.flushQueued = false;
    this.lastActivity = Date.now();
  }

  get started() { return Boolean(this.game); }
  get blinds() { return P.LEVELS[this.settings.level]; }

  touch() { this.lastActivity = Date.now(); }

  summary() {
    return {
      code: this.code, name: this.settings.name, mode: this.settings.mode,
      buyIn: this.settings.buyIn, blinds: this.blinds, bots: this.settings.bots,
      humans: this.members.size, seats: MAX_SEATS, started: this.started,
    };
  }

  info() {
    return {
      ...this.summary(),
      visibility: this.settings.visibility, level: this.settings.level, blindUp: this.settings.blindUp,
      hostId: this.hostId,
      members: [...this.members.values()].map((s) => ({ id: s.id, nick: s.nick, avatar: s.avatar, connected: Boolean(s.ws) })),
    };
  }

  isFull() { return this.members.size >= MAX_SEATS; }

  /* ---------- участники ---------- */

  // false — за столом нет места (тогда игрок в комнату не попадает и ничего не платит).
  join(session) {
    if (this.game && !this.game.addPlayer({ id: session.id, name: session.nick, avatar: session.avatar, chips: this.settings.buyIn })) return false;
    this.members.set(session.id, session);
    session.roomCode = this.code;
    this.clearGrace(session.id);
    this.touch();
    this.system(`${session.nick} заходит в комнату`);
    this.broadcastInfo();
    this.sendTo(session.id, { t: 'chatHistory', messages: this.chat });
    if (this.game) this.sendState(session.id);
    return true;
  }

  // Уход по любой причине. Фишки со стола сообщаем клиенту — он вернёт их на свой баланс.
  // Если клиент сейчас без связи, сообщение дождётся его переподключения.
  leave(session, reason) {
    if (!this.members.has(session.id)) return;
    const seat = this.game ? this.game.byId(session.id) : null;
    // Не севший за стол (до старта или в очереди на место) получает взнос обратно.
    const chips = seat ? (seat.leaving ? 0 : seat.chips) : this.settings.buyIn;
    this.members.delete(session.id);
    session.roomCode = null;
    this.turns.delete(session.id);
    this.cancelRebuy(session.id);
    this.cancelSitOut(session.id);
    this.clearGrace(session.id);
    if (this.game) this.game.removePlayer(session.id);
    const left = { t: 'left', reason, chips };
    if (session.ws) this.sendSession(session, left); else session.pendingLeft = left;
    this.system(`${session.nick} выходит из комнаты`);
    if (!this.members.size) { this.destroy(); return; }
    if (this.hostId === session.id) this.hostId = this.members.keys().next().value;
    this.broadcastInfo();
  }

  // Отключение — не уход: до старта ждём минуту, во время игры место держит таймер хода и «отошёл».
  disconnected(session) {
    this.broadcastInfo();
    if (this.game) { this.scheduleFlush(); return; }
    this.graceTimers.set(session.id, setTimeout(() => this.leave(session, 'disconnected'), WAITING_GRACE_MS));
  }

  reconnected(session) {
    this.clearGrace(session.id);
    this.broadcastInfo();
    this.sendTo(session.id, { t: 'chatHistory', messages: this.chat });
    if (!this.game) return;
    this.sendState(session.id);
    const now = Date.now();
    const turn = this.turns.get(session.id);
    if (turn && turn.deadline > now) this.sendTo(session.id, { t: 'turn', limits: turn.limits, remaining: turn.deadline - now });
    const rebuy = this.rebuys.get(session.id);
    if (rebuy) this.sendTo(session.id, { t: 'bankrupt', remaining: rebuy.deadline - now, buyIn: this.settings.buyIn });
    const away = this.sitOuts.get(session.id);
    if (away) this.sendTo(session.id, { t: 'sitout', remaining: away.deadline - now });
  }

  clearGrace(id) {
    clearTimeout(this.graceTimers.get(id));
    this.graceTimers.delete(id);
  }

  /* ---------- игра ---------- */

  start(session) {
    if (this.game) return 'Игра уже идёт';
    if (session.id !== this.hostId) return 'Начать игру может только создатель комнаты';
    if (this.members.size < 2 && !this.settings.bots) return 'Нужен хотя бы ещё один игрок — или включите ботов';
    const s = this.settings;
    const players = [...this.members.values()].map((m) => ({ id: m.id, name: m.nick, avatar: m.avatar, chips: s.buyIn }));
    this.game = new P.Game({
      mode: s.mode, stack: s.buyIn, level: s.level, blindUp: s.blindUp, speed: 'normal',
      bots: s.bots, opponents: MAX_SEATS - 1, autoNextMs: AUTO_NEXT_MS, players,
    }, this.hooks());
    this.game.start();
    this.touch();
    this.system('Игра началась');
    this.broadcastInfo();
    return null;
  }

  hooks() {
    return {
      onChange: () => this.scheduleFlush(),
      onNewHand: () => { this.turns.clear(); this.broadcast({ t: 'newHand' }); },
      onHumanTurn: (p, limits, deadline) => {
        this.turns.set(p.id, { limits, deadline });
        this.scheduleFlush();
        this.sendTo(p.id, { t: 'turn', limits, remaining: deadline - Date.now() });
      },
      onHandEnd: (summary) => {
        this.turns.clear();
        const winners = summary.winners.map((w) => ({ id: w.id, name: w.name, won: w.won, handName: w.handName }));
        this.flushNow();
        this.broadcast({ t: 'handEnd', summary: { type: summary.type, winners }, nextIn: AUTO_NEXT_MS });
      },
      onHandSettled: (p, chips) => this.sendTo(p.id, { t: 'chips', chips }),
      onBankrupt: (p) => this.askRebuy(p),
      onSitOut: (p) => this.startSitOut(p),
      onError: (e) => {
        console.error(`[room ${this.code}] engine error:`, e);
        this.broadcast({ t: 'error', msg: 'Игра на сервере остановилась. Выйдите из комнаты и создайте новую.' });
      },
      onLog: (text, kind) => this.broadcast({ t: 'log', text, kind }),
      sound: (kind) => this.broadcast({ t: 'sound', kind }),
    };
  }

  act(session, action) {
    if (!this.game) return;
    this.turns.delete(session.id);
    this.game.humanAct(action, session.id);
  }

  // Кончились фишки: минута на ответ «пополнить / уйти». Молчание — уход.
  askRebuy(p) {
    return new Promise((resolve) => {
      const deadline = Date.now() + REBUY_MS;
      const finish = (amount) => {
        const pending = this.rebuys.get(p.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.rebuys.delete(p.id);
        resolve(amount);
        const session = this.members.get(p.id);
        if (!amount && session) this.leave(session, 'bankrupt');
      };
      this.rebuys.set(p.id, { resolve: finish, timer: setTimeout(() => finish(0), REBUY_MS), deadline });
      const left = MAX_REBUYS - (this.rebuyCount.get(p.id) || 0);
      this.sendTo(p.id, { t: 'bankrupt', remaining: REBUY_MS, buyIn: this.settings.buyIn, rebuysLeft: left });
    });
  }

  // Пополнений не больше MAX_REBUYS: сервер не знает баланса игрока, но ограничивает подкуп фишек.
  answerRebuy(session, accept) {
    const pending = this.rebuys.get(session.id);
    if (!pending) return;
    const used = this.rebuyCount.get(session.id) || 0;
    if (accept && used < MAX_REBUYS) {
      this.rebuyCount.set(session.id, used + 1);
      pending.resolve(this.settings.buyIn);
    } else {
      pending.resolve(0);
    }
  }

  cancelRebuy(id) {
    const pending = this.rebuys.get(id);
    if (pending) pending.resolve(0);
  }

  // «Отошёл»: три минуты, чтобы вернуться, иначе место освобождается.
  startSitOut(p) {
    this.cancelSitOut(p.id);
    const deadline = Date.now() + SIT_OUT_MS;
    const timer = setTimeout(() => {
      this.sitOuts.delete(p.id);
      const session = this.members.get(p.id);
      const seat = this.game && this.game.byId(p.id);
      if (session && seat && seat.sittingOut) this.leave(session, 'afk');
    }, SIT_OUT_MS);
    this.sitOuts.set(p.id, { timer, deadline });
    this.sendTo(p.id, { t: 'sitout', remaining: SIT_OUT_MS });
  }

  returnToTable(session) {
    this.cancelSitOut(session.id);
    if (this.game) this.game.returnToTable(session.id);
  }

  cancelSitOut(id) {
    const away = this.sitOuts.get(id);
    if (away) clearTimeout(away.timer);
    this.sitOuts.delete(id);
  }

  /* ---------- снимки состояния ---------- */

  // Каждый видит свои карты; чужие — только на вскрытии. Колода остаётся на сервере.
  // Аватары в снимок не входят — они приходят один раз в данных комнаты.
  snapshotFor(viewerId) {
    const g = this.game;
    const current = g.players[g.toAct];
    return {
      mode: g.mode, holeN: g.holeN, potLimit: g.potLimit, handNo: g.handNo,
      sb: g.sb, bb: g.bb, handsLeft: g.handsLeftAtLevel(), pot: g.pot, maxBet: g.maxBet,
      board: g.board, dealerId: g.dealerId, toActId: current ? current.id : null, showdown: g.showdown,
      buyIn: this.settings.buyIn,
      players: g.players.map((p) => {
        const reveal = p.id === viewerId || (g.showdown && !p.folded && !p.out);
        const member = this.members.get(p.id);
        return {
          id: p.id, name: p.name, human: p.human,
          connected: p.human ? Boolean(member && member.ws) : true,
          chips: p.chips, bet: p.bet, folded: p.folded, allIn: p.allIn, out: p.out, sittingOut: p.sittingOut,
          lastAction: p.lastAction, handName: reveal ? p.handName : '', winner: p.winner, won: p.won,
          hole: reveal ? p.hole : p.hole.map(() => null),
        };
      }),
    };
  }

  sendState(id) {
    if (this.game) this.sendTo(id, { t: 'state', s: this.snapshotFor(id) });
  }

  // Движок дёргает onChange на каждую карту — отправляем один снимок на «такт» событий.
  scheduleFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    setImmediate(() => {
      try {
        this.flushNow();
      } catch (e) {
        console.error(`[room ${this.code}] ошибка рассылки состояния:`, e);
      }
    });
  }

  flushNow() {
    this.flushQueued = false;
    if (!this.game) return;
    for (const id of this.members.keys()) this.sendState(id);
  }

  /* ---------- чат и рассылка ---------- */

  chatFrom(session, text) {
    this.touch();
    this.pushChat({ from: session.id, nick: session.nick, text, at: Date.now() });
  }

  system(text) { this.pushChat({ from: null, nick: '', text, at: Date.now() }); }

  pushChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    this.broadcast({ t: 'chat', msg });
  }

  broadcastInfo() { this.broadcast({ t: 'room', room: this.info() }); }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const s of this.members.values()) safeSend(s.ws, data);
  }

  sendTo(id, msg) { this.sendSession(this.members.get(id), msg); }

  sendSession(session, msg) {
    if (session && session.ws) safeSend(session.ws, JSON.stringify(msg));
  }

  // Комната распускается: все, кто ещё в ней, получают фишки обратно (в том числе после переподключения).
  destroy(reason) {
    for (const session of [...this.members.values()]) {
      if (reason) this.leave(session, reason);
    }
    if (this.game) this.game.stop();
    [...this.rebuys.keys()].forEach((id) => this.cancelRebuy(id));
    [...this.sitOuts.keys()].forEach((id) => this.cancelSitOut(id));
    [...this.graceTimers.keys()].forEach((id) => this.clearGrace(id));
    this.lobby.rooms.delete(this.code);
  }
}

class Lobby {
  constructor() {
    this.rooms = new Map();
    this.sessions = new Map(); // секретный ключ клиента → сессия
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  session(key) {
    let s = this.sessions.get(key);
    if (!s) {
      s = { key, id: newId('p'), nick: 'Игрок', avatar: null, ws: null, roomCode: null, lastSeen: Date.now(), pendingLeft: null };
      this.sessions.set(key, s);
    }
    return s;
  }

  roomOf(session) { return session.roomCode ? this.rooms.get(session.roomCode) || null : null; }

  // Открытые комнаты в списке; закрытые находятся только по коду.
  list() {
    return [...this.rooms.values()]
      .filter((r) => r.settings.visibility === 'open')
      .map((r) => r.summary())
      .sort((a, b) => Number(a.started) - Number(b.started) || b.humans - a.humans);
  }

  canCreate(settings) {
    if (this.rooms.size >= MAX_ROOMS) return 'Сервер переполнен, попробуйте позже';
    const withBots = [...this.rooms.values()].filter((r) => r.settings.bots).length;
    if (settings.bots && withBots >= MAX_BOT_ROOMS) return 'Сейчас слишком много столов с ботами. Создайте стол только для людей или попробуйте позже.';
    return null;
  }

  canJoin(code) {
    const room = this.rooms.get(code);
    if (!room) return 'Комнаты с таким кодом нет. Проверьте код или попросите новый.';
    if (room.isFull()) return 'За этим столом нет свободных мест';
    if (room.game && room.game.freeSeatsForHumans() <= 0) return 'За этим столом нет свободных мест';
    return null;
  }

  create(session, settings) {
    const room = new Room(this, settings, session);
    this.rooms.set(room.code, room);
    room.join(session);
    return { room };
  }

  join(session, code) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'Комнаты с таким кодом нет' };
    if (room.members.has(session.id)) return { room };
    if (room.isFull() || !room.join(session)) return { error: 'За этим столом нет свободных мест' };
    return { room };
  }

  // Уборка: сессии без соединения и без комнаты, «мёртвые» сокеты, забытые комнаты без игры.
  sweep(maxIdleMs) {
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if (s.ws && s.ws.readyState !== 1) {
        s.ws = null;
        const room = this.roomOf(s);
        if (room) room.disconnected(s);
      }
      if (!s.ws && !s.roomCode && now - s.lastSeen > maxIdleMs) this.sessions.delete(key);
    }
    for (const room of [...this.rooms.values()]) {
      if (!room.game && now - room.lastActivity > ROOM_IDLE_MS) room.destroy('idle');
    }
  }
}

module.exports = { Lobby, Room, P, safeSend };
