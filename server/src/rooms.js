// Комнаты: ожидание игроков, запуск стола, снимки состояния для каждого игрока, банкротство, «отошёл», чат.
// Турниры (Sit & Go): очередь по режиму и взносу, старт без комнаты ожидания, места и приз победителю.
'use strict';

const crypto = require('node:crypto');
const { P } = require('./engine');
const { ratingId } = require('./ratings');

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
const TOURNEY_WAIT_MS = 30 * 1000;      // очередь из 2+ игроков стартует, не дождавшись полного стола
const FINISHED_TTL_MS = 10 * 60 * 1000; // доигранный турнир держим, пока все не посмотрят итог
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // сессию с недоставленным итогом или уходом храним сутки
const TOURNEY_RETRY_MS = 5000;          // сервер полон — старт турнира откладывается
// Метка запуска процесса: по ней клиент отличает «сервер перезапускался» от «нас выписали без связи».
const BOOT_ID = crypto.randomBytes(6).toString('hex');
const MODE_NAME = { holdem: 'Холдем', omaha: 'Омаха', joker: 'С джокерами', short: 'Шорт-дек', aof: 'AoF Холдем', aofomaha: 'AoF Омаха' };
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
    this.raters = new Map();    // id → { rid, nick } — и для ушедших посреди раздачи, их итог тоже идёт в рейтинг
    this.chat = [];
    this.game = null;
    this.turns = new Map();     // id → { limits, deadline } — чтобы вернуть ход после переподключения
    this.rebuys = new Map();    // id → { resolve, timer, deadline }
    this.rebuyCount = new Map();
    this.sitOuts = new Map();   // id → { timer, deadline }
    this.graceTimers = new Map();
    this.flushQueued = false;
    this.lastActivity = Date.now();
    this.entrants = 0;          // турнир: сколько игроков начали (от этого приз)
    this.results = new Map();   // турнир: id → итог, чтобы повторить его после переподключения
    this.finished = false;
  }

  get started() { return Boolean(this.game); }
  get tournament() { return this.settings.format === 'tournament'; }
  get prize() { return this.settings.buyIn * this.entrants; }
  // Кэш: блайнды — сотая часть взноса и не растут; турнир — текущий уровень движка.
  get blinds() {
    if (this.game && this.game.bb) return [this.game.sb, this.game.bb];
    const [sb, bb] = this.tournament ? P.TOURNEY.levels[0] : P.blindsFor(this.settings.buyIn);
    return [sb, bb];
  }

  touch() { this.lastActivity = Date.now(); }

  summary() {
    return {
      code: this.code, name: this.settings.name, mode: this.settings.mode,
      buyIn: this.settings.buyIn, blinds: this.blinds, bots: this.settings.bots,
      humans: this.members.size, seats: MAX_SEATS, started: this.started, format: this.settings.format || 'cash',
    };
  }

  info() {
    return {
      ...this.summary(),
      visibility: this.settings.visibility,
      ...(this.tournament ? { prize: this.prize, players: this.entrants, finished: this.finished } : {}),
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
    this.raters.set(session.id, { rid: session.rid, nick: session.nick });
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
    // Турнирные фишки — не деньги: ушедший из турнира ничего не получает (это сдача турнира).
    const chips = this.tournament ? 0 : (seat ? (seat.leaving ? 0 : seat.chips) : this.settings.buyIn);
    this.members.delete(session.id);
    session.roomCode = null;
    this.turns.delete(session.id);
    // Итог турнира без связи (комнату распустили до переподключения) дождётся игрока в сессии — приз не пропадёт.
    const result = this.results.get(session.id);
    if (result && !session.ws) session.pendingResult = result;
    this.results.delete(session.id);
    this.cancelRebuy(session.id);
    this.cancelSitOut(session.id);
    this.clearGrace(session.id);
    if (this.game) this.game.removePlayer(session.id);
    // Из турнира — с кодом и меткой запуска: по ним клиент найдёт свою отметку о взносе (например, для возврата).
    const left = this.tournament ? { t: 'left', reason, chips, code: this.code, boot: BOOT_ID } : { t: 'left', reason, chips };
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
    if (away) this.sendTo(session.id, { t: 'sitout', remaining: away.deadline ? away.deadline - now : null, tournament: this.tournament });
    const result = this.results.get(session.id);
    if (result) this.sendTo(session.id, result);
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
    // Блайнды движок выводит из взноса (P.blindsFor) и за кэш-столом не поднимает.
    this.game = new P.Game({
      mode: s.mode, stack: s.buyIn, speed: 'normal',
      bots: s.bots, opponents: MAX_SEATS - 1, autoNextMs: this.lobby.autoNextMs, players,
    }, this.hooks());
    this.game.start();
    this.touch();
    this.system('Игра началась');
    this.broadcastInfo();
    return null;
  }

  // Турнир: участники уже собраны очередью, игра начинается сразу. Стек у всех одинаковый, ботов нет.
  // Сначала то, что может упасть (движок), и только потом игроки привязываются к комнате и получают сообщения.
  startTournament(sessions) {
    this.entrants = sessions.length;
    const players = sessions.map((m) => ({ id: m.id, name: m.nick, avatar: m.avatar, chips: P.TOURNEY.stack }));
    this.game = new P.Game({
      mode: this.settings.mode, format: 'tournament', stack: P.TOURNEY.stack, speed: 'normal',
      bots: false, opponents: MAX_SEATS - 1, autoNextMs: this.lobby.autoNextMs, players,
    }, this.hooks());
    this.game.start();
    for (const session of sessions) {
      this.members.set(session.id, session);
      session.roomCode = this.code;
    }
    this.touch();
    this.system(`Турнир начался: игроков — ${sessions.length}, приз ${this.prize.toLocaleString('ru-RU')}`);
    this.broadcastInfo();
    for (const session of sessions) this.sendTo(session.id, { t: 'chatHistory', messages: this.chat });
  }

  // Итог турнира игроку: выбывшему — сразу, победителю — в конце. Хранится, пока игрок в комнате.
  tourneyResult(id, place, prize) {
    const msg = { t: 'tourneyResult', code: this.code, boot: BOOT_ID, place, prize, players: this.entrants, buyIn: this.settings.buyIn };
    this.results.set(id, msg);
    this.sendTo(id, msg);
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
        this.recordRating(summary);
        const winners = summary.winners.map((w) => ({ id: w.id, name: w.name, won: w.won, handName: w.handName }));
        // Все спасовали: показываем карты, которые легли бы на стол. Колода всё равно перемешивается заново.
        const rest = summary.type === 'fold' && Array.isArray(summary.rest) ? summary.rest : [];
        this.flushNow();
        this.broadcast({ t: 'handEnd', summary: { type: summary.type, winners, rest }, nextIn: this.lobby.autoNextMs });
      },
      // Турнирные фишки — не деньги: на баланс клиента они не попадают, поэтому и не сообщаем.
      onHandSettled: (p, chips) => { if (!this.tournament) this.sendTo(p.id, { t: 'chips', chips }); },
      onBankrupt: (p) => this.askRebuy(p),
      onSitOut: (p) => this.startSitOut(p),
      // Ушедший сам уже получил «left» — итог нужен только тем, кто ещё в комнате.
      onEliminated: (p, place) => { if (p.human && this.members.has(p.id)) this.tourneyResult(p.id, place, 0); },
      onTournamentEnd: ({ winner }) => {
        this.finished = true;
        this.turns.clear();
        if (winner && winner.human) this.tourneyResult(winner.id, 1, this.prize);
        this.system(winner ? `Турнир окончен. Победитель — ${winner.name}` : 'Турнир окончен');
        this.broadcastInfo();
      },
      onError: (e) => {
        console.error(`[room ${this.code}] engine error:`, e);
        // Турнир без движка не доиграть: распускаем, клиенты вернут себе взнос (уход с причиной «aborted»).
        if (this.tournament) { this.destroy('aborted'); return; }
        this.broadcast({ t: 'error', msg: 'Игра на сервере остановилась. Выйдите из комнаты и создайте новую.' });
      },
      onLog: (text, kind) => this.broadcast({ t: 'log', text, kind }),
      sound: (kind) => this.broadcast({ t: 'sound', kind }),
    };
  }

  // Чистый итог раздачи каждого человека: выигрыш минус вложенное в банк. Столы с ботами не считаются —
  // иначе рейтинг набивали бы на ботах. Сбой рейтинга не должен останавливать игру.
  recordRating(summary) {
    const ratings = this.lobby.ratings;
    if (!ratings || this.settings.bots || this.tournament || !summary.winners.length) return;
    try {
      ratings.recordHand(this.handResults());
    } catch (e) {
      console.error(`[room ${this.code}] ошибка рейтинга:`, e);
    }
  }

  handResults() {
    return this.game.players
      .filter((p) => p.human && p.hole.length && this.raters.has(p.id))
      .map((p) => {
        const rater = this.raters.get(p.id);
        const member = this.members.get(p.id);
        return { rid: rater.rid, nick: member ? member.nick : rater.nick, net: p.won - p.total };
      });
  }

  // Сохранённый ход стираем, только если ход действительно этого игрока: чужой «ход» движок всё равно отбросит.
  act(session, action) {
    const g = this.game;
    if (!g) return;
    if (g.pendingKind === 'action' && g.pendingPlayer === session.id) this.turns.delete(session.id);
    g.humanAct(action, session.id);
  }

  // Турнир: выбывшие смотрят молча, чтобы не подсказывать оставшимся. Победителю писать можно.
  canChat(session) {
    if (!this.tournament || !this.game) return true;
    const seat = this.game.byId(session.id);
    return Boolean(seat) && (!seat.place || seat.place === 1);
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
  // В турнире место не освобождаем: отошедший сидит в раздачах и платит блайнды, пока не вернётся или не выбудет.
  startSitOut(p) {
    this.cancelSitOut(p.id);
    if (this.tournament) {
      this.sitOuts.set(p.id, { timer: null, deadline: 0 });
      this.sendTo(p.id, { t: 'sitout', remaining: null, tournament: true });
      return;
    }
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
  // tourneyWaitMs и autoNextMs настраиваются ради быстрых тестов.
  constructor(ratings = null, { tourneyWaitMs = TOURNEY_WAIT_MS, autoNextMs = AUTO_NEXT_MS } = {}) {
    this.ratings = ratings;
    this.rooms = new Map();
    this.sessions = new Map(); // секретный ключ клиента → сессия
    this.queues = new Map();   // «режим:взнос» → { key, mode, buyIn, members: [сессии], timer, since }
    this.tourneyWaitMs = tourneyWaitMs;
    this.autoNextMs = autoNextMs;
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
      s = {
        key, rid: ratingId(key), id: newId('p'), nick: 'Игрок', avatar: null, ws: null, roomCode: null,
        queueKey: null, lastSeen: Date.now(), pendingLeft: null, pendingResult: null,
      };
      this.sessions.set(key, s);
    }
    return s;
  }

  roomOf(session) { return session.roomCode ? this.rooms.get(session.roomCode) || null : null; }

  // Игроки на связи: представившиеся сессии с открытым соединением (одно устройство — один игрок).
  onlineCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.ws && s.ws.readyState === 1) n++;
    return n;
  }

  // Открытые комнаты в списке; закрытые и турнирные находятся только по коду.
  list() {
    return [...this.rooms.values()]
      .filter((r) => r.settings.visibility === 'open' && !r.tournament)
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
    if (room.tournament) return 'Это турнирный стол — к идущему турниру подсесть нельзя. Встаньте в очередь на новый турнир.';
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

  /* ---------- очередь на турнир ---------- */

  // Сводка очередей для лобби: кто где ждёт (без имён).
  queueList() {
    return [...this.queues.values()].map((q) => ({ mode: q.mode, buyIn: q.buyIn, count: q.members.length }));
  }

  queueStatus(q) {
    return {
      mode: q.mode, buyIn: q.buyIn, count: q.members.length, max: MAX_SEATS,
      startsIn: q.since ? Math.max(0, q.since + this.tourneyWaitMs - Date.now()) : null,
    };
  }

  notifyQueue(q) {
    const data = JSON.stringify({ t: 'queue', queue: this.queueStatus(q) });
    for (const s of q.members) safeSend(s.ws, data);
  }

  // null — встал в очередь; строка — причина отказа. Сессия бывает либо в одной очереди, либо в одной комнате.
  enqueue(session, { mode, buyIn }) {
    if (session.roomCode) return 'Сначала выйдите из-за стола';
    const key = `${mode}:${buyIn}`;
    if (session.queueKey === key) { this.notifyQueue(this.queues.get(key)); return null; }
    if (this.rooms.size >= MAX_ROOMS) return 'Сервер переполнен, попробуйте позже';
    this.dequeue(session, false);
    let q = this.queues.get(key);
    if (!q) {
      q = { key, mode, buyIn, members: [], timer: null, since: 0 };
      this.queues.set(key, q);
    }
    q.members.push(session);
    session.queueKey = key;
    this.queueChanged(q);
    return null;
  }

  // notify — сообщить самому игроку, что он больше не в очереди.
  dequeue(session, notify = true) {
    const q = session.queueKey ? this.queues.get(session.queueKey) : null;
    session.queueKey = null;
    if (!q) return;
    q.members = q.members.filter((s) => s !== session);
    if (notify) safeSend(session.ws, JSON.stringify({ t: 'queue', queue: null }));
    this.queueChanged(q);
  }

  // Полный стол — старт сразу; двое и больше — через tourneyWaitMs после того, как набралось двое.
  queueChanged(q) {
    const n = q.members.length;
    if (!n) { clearTimeout(q.timer); this.queues.delete(q.key); return; }
    if (n >= MAX_SEATS) { this.startTourney(q); return; }
    if (n < 2) { clearTimeout(q.timer); q.timer = null; q.since = 0; }
    else if (!q.timer) {
      q.since = Date.now();
      q.timer = setTimeout(() => this.startTourney(q), this.tourneyWaitMs);
    }
    this.notifyQueue(q);
  }

  // Старт либо проходит целиком, либо откатывается: игроки свободны и знают, что турнир не начался.
  startTourney(q) {
    clearTimeout(q.timer);
    q.timer = null;
    if (this.rooms.size >= MAX_ROOMS) {
      // Сервер полон: очередь сохраняется, пробуем снова чуть позже.
      q.timer = setTimeout(() => this.startTourney(q), Math.min(TOURNEY_RETRY_MS, this.tourneyWaitMs));
      return;
    }
    this.queues.delete(q.key);
    // Старт ровно на шестом игроке, поэтому больше шести в очереди не бывает.
    const sessions = q.members.splice(0);
    sessions.forEach((s) => { s.queueKey = null; });
    const settings = {
      name: `Турнир · ${MODE_NAME[q.mode] || q.mode}`, visibility: 'closed', mode: q.mode,
      buyIn: q.buyIn, bots: false, format: 'tournament',
    };
    const queueOff = JSON.stringify({ t: 'queue', queue: null });
    let room = null;
    try {
      room = new Room(this, settings, sessions[0]);
      this.rooms.set(room.code, room);
      sessions.forEach((s) => safeSend(s.ws, queueOff));
      room.startTournament(sessions);
    } catch (e) {
      console.error('не удалось начать турнир:', e);
      if (room) {
        if (room.game) room.game.stop();
        this.rooms.delete(room.code);
      }
      const failed = JSON.stringify({ t: 'error', msg: 'Турнир не удалось начать. Встаньте в очередь ещё раз.' });
      sessions.forEach((s) => {
        if (room && s.roomCode === room.code) s.roomCode = null;
        safeSend(s.ws, failed);
      });
    }
  }

  // Уборка: сессии без соединения и без комнаты, «мёртвые» сокеты, забытые комнаты без игры.
  sweep(maxIdleMs) {
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if (s.ws && s.ws.readyState !== 1) {
        s.ws = null;
        const room = this.roomOf(s);
        if (room) room.disconnected(s);
        this.dequeue(s, false);
      }
      // Недоставленный итог турнира или уход (с фишками) не теряем: такую сессию держим сутки.
      const ttl = s.pendingResult || s.pendingLeft ? PENDING_TTL_MS : maxIdleMs;
      if (!s.ws && !s.roomCode && !s.queueKey && now - s.lastSeen > ttl) this.sessions.delete(key);
    }
    for (const room of [...this.rooms.values()]) {
      if (!room.game && now - room.lastActivity > ROOM_IDLE_MS) room.destroy('idle');
      else if (room.finished && now - room.lastActivity > FINISHED_TTL_MS) room.destroy('finished');
    }
  }
}

module.exports = { Lobby, Room, P, safeSend, BOOT_ID };
