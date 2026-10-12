// Кэш-стол: блайнды, улицы, торговля, побочные банки, вскрытие, таймер хода, «отошёл», пересадка ботов.
// Один движок для офлайна (браузер/приложение) и для сервера сетевой игры: за столом может быть
// сколько угодно людей (human) и ботов, у каждого игрока постоянный id, места меняются между раздачами.
(function (P) {
  'use strict';

  const C = P.Cards;
  const LEVELS = [[5, 10], [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [500, 1000], [1000, 2000]];
  const HANDS_PER_LEVEL = 10;
  const MAX_SEATS = 6;
  const TURN_MS = 30 * 1000;      // время на ход
  const TURN_CHECK_MS = 250;      // как часто сверяться с часами (переживает паузу приложения)
  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const STREET_NAME = { preflop: 'Префлоп', flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' };
  const SPEED = {
    slow: { think: 1500, deal: 140, street: 900 },
    normal: { think: 850, deal: 100, street: 650 },
    fast: { think: 380, deal: 55, street: 380 },
  };
  // Первые пятеро садятся за стол сразу, остальные приходят на места разорившихся.
  const ROSTER = [
    { name: 'Барон', persona: { loose: 0.35, aggr: 0.75, bluff: 0.15 } },
    { name: 'Лиса', persona: { loose: 0.7, aggr: 0.8, bluff: 0.35 } },
    { name: 'Шериф', persona: { loose: 0.25, aggr: 0.3, bluff: 0.05 } },
    { name: 'Профессор', persona: { loose: 0.45, aggr: 0.5, bluff: 0.12 } },
    { name: 'Кузнец', persona: { loose: 0.8, aggr: 0.2, bluff: 0.08 } },
    { name: 'Графиня', persona: { loose: 0.3, aggr: 0.65, bluff: 0.2 } },
    { name: 'Капитан', persona: { loose: 0.55, aggr: 0.6, bluff: 0.18 } },
    { name: 'Тихоня', persona: { loose: 0.2, aggr: 0.15, bluff: 0.03 } },
    { name: 'Маэстро', persona: { loose: 0.5, aggr: 0.7, bluff: 0.25 } },
    { name: 'Ковбой', persona: { loose: 0.85, aggr: 0.85, bluff: 0.4 } },
    { name: 'Банкир', persona: { loose: 0.35, aggr: 0.4, bluff: 0.1 } },
    { name: 'Дуэлянт', persona: { loose: 0.6, aggr: 0.9, bluff: 0.3 } },
  ];
  const ABORT = new Error('game aborted');
  const fmt = (n) => Number(n).toLocaleString('ru-RU');

  let botSeq = 0;
  const botId = () => `bot-${++botSeq}`;

  function freshSeat(info, chips) {
    return Object.assign({}, info, {
      chips, hole: [], bet: 0, total: 0,
      folded: false, allIn: false, acted: false, out: false,
      sittingOut: false, owesBB: false, newcomer: false, leaving: false,
      lastAction: '', handName: '', winner: false, won: 0, tone: 0,
    });
  }

  class Game {
    constructor(cfg, hooks) {
      this.cfg = cfg;
      this.hooks = hooks;
      this.gen = 0;
      this.pending = null;
      this.pendingKind = null;
      this.pendingPlayer = null;
      this.returnWaiter = null;
      this.turnDeadline = 0;
      this.players = [];
      this.joinQueue = [];
    }

    get speed() { return SPEED[this.cfg.speed] || SPEED.normal; }
    // Офлайн за столом один человек; в сетевой игре «me» не используется.
    get me() { return this.players.find((p) => p.human); }
    get dealerId() { return this.players[this.dealer] ? this.players[this.dealer].id : null; }

    byId(id) { return this.players.find((p) => p.id === id) || null; }

    start() {
      this.stop();
      const cfg = this.cfg;
      this.mode = cfg.mode;
      this.holeN = cfg.mode === 'omaha' ? 4 : 2;
      this.potLimit = cfg.mode === 'omaha';
      // cfg.players — люди за столом (сеть); без него — один офлайн-игрок с ником из профиля.
      const humans = cfg.players || [{ id: 'me', name: cfg.nick, avatar: cfg.avatar, human: true, chips: cfg.stack }];
      this.players = humans.map((h) => freshSeat({ id: h.id, name: h.name, avatar: h.avatar, human: true }, h.chips));
      const botCount = cfg.players ? (cfg.bots ? Math.max(0, cfg.opponents + 1 - this.players.length) : 0) : cfg.opponents;
      this.addBots(botCount);
      this.retone();
      this.dealer = C.randInt(this.players.length);
      this.handNo = 0;
      this.level = cfg.level;
      [this.sb, this.bb] = LEVELS[this.level];
      this.board = [];
      this.pot = 0;
      this.maxBet = 0;
      this.toAct = -1;
      this.showdown = false;
      this.street = 'preflop';
      this.loop(this.gen);
    }

    addBots(count) {
      const seated = new Set(this.players.map((p) => p.name));
      const free = ROSTER.filter((b) => !seated.has(b.name));
      for (let i = 0; i < count && this.players.length < MAX_SEATS; i++) {
        const b = free[i] || ROSTER[C.randInt(ROSTER.length)];
        this.players.push(freshSeat({ id: botId(), name: b.name, persona: b.persona, human: false }, this.cfg.stack));
      }
    }

    retone() { this.players.forEach((p, i) => { p.tone = i; }); }

    stop() {
      this.gen++;
      this.resolvePending(null);
      this.wakeReturnWaiter();
    }

    // kind — чего именно ждёт игра: 'action' (ход игрока) или 'next' (следующая раздача).
    // Сигнал не того вида или не от того игрока игнорируется.
    resolvePending(value, kind, playerId) {
      if (!this.pending) return;
      if (kind && kind !== this.pendingKind) return;
      if (playerId !== undefined && playerId !== this.pendingPlayer) return;
      const r = this.pending;
      this.pending = null;
      this.pendingKind = null;
      this.pendingPlayer = null;
      r(value);
    }

    wakeReturnWaiter() {
      if (!this.returnWaiter) return;
      const r = this.returnWaiter;
      this.returnWaiter = null;
      r();
    }

    humanAct(action, playerId) { this.resolvePending(action, 'action', playerId); }
    nextHand() { this.resolvePending(true, 'next'); }

    // Игрок вернулся после «отошёл»: со следующей раздачи снова в игре, пропущенный ББ доплатит.
    returnToTable(playerId) {
      const p = this.byId(playerId);
      if (!p || !p.sittingOut) return;
      p.sittingOut = false;
      this.log(`${p.name} возвращается за стол`, 'sys');
      this.emit();
      this.wakeReturnWaiter();
    }

    /* ---------- места: вход и выход между раздачами ---------- */

    // Сколько ещё людей поместится: боты уступают места людям, поэтому считаем только людей.
    freeSeatsForHumans() {
      const humans = this.players.filter((p) => p.human && !p.leaving).length;
      return MAX_SEATS - humans - this.joinQueue.length;
    }

    // Новый игрок садится со следующей раздачи (если есть место).
    addPlayer(info) {
      if (this.freeSeatsForHumans() <= 0) return false;
      this.joinQueue.push(info);
      this.wakeReturnWaiter();
      return true;
    }

    // Игрок уходит: его карты сбрасываются сразу (ставки остаются в банке), место освобождается после раздачи.
    removePlayer(playerId) {
      this.joinQueue = this.joinQueue.filter((q) => q.id !== playerId);
      const p = this.byId(playerId);
      if (!p) return;
      p.leaving = true;
      p.sittingOut = false;
      if (!p.out && !p.folded) {
        p.folded = true;
        p.lastAction = 'Ушёл';
      }
      // Ход ушедшего — или остался один игрок в раздаче: ждать его решения незачем, банк уже его.
      if (this.pendingKind === 'action' && (this.pendingPlayer === playerId || this.liveCount() <= 1)) this.resolvePending({ type: 'fold' }, 'action');
      this.wakeReturnWaiter();
    }

    applySeatChanges() {
      const leaving = this.players.filter((p) => p.leaving);
      if (!leaving.length && !this.joinQueue.length) return;
      // Кнопка дилера остаётся у того же игрока; если он ушёл — у ближайшего оставшегося перед ним,
      // чтобы следующий шаг nextSeated() отдал её правильному соседу.
      const old = this.players;
      let anchor = old[this.dealer];
      for (let k = 0; anchor && anchor.leaving && k < old.length; k++) anchor = old[(this.dealer - k - 1 + old.length) % old.length];
      const dealerPlayer = anchor && !anchor.leaving ? anchor : null;
      leaving.forEach((p) => this.log(`${p.name} покидает стол`, 'sys'));
      this.players = this.players.filter((p) => !p.leaving);
      for (const info of this.joinQueue.splice(0)) {
        if (this.players.length >= MAX_SEATS) break;
        // Если стол занят ботами, новый человек занимает место бота.
        this.players.push(freshSeat({ id: info.id, name: info.name, avatar: info.avatar, human: true }, info.chips));
        this.log(`${info.name} садится за стол`, 'sys');
      }
      const idx = dealerPlayer ? this.players.indexOf(dealerPlayer) : -1;
      this.dealer = idx >= 0 ? idx : Math.max(0, Math.min(this.dealer, this.players.length - 1));
      this.retone();
      this.emit();
    }

    // В сетевой комнате с ботами новые люди вытесняют ботов, чтобы всем хватало мест.
    makeRoomForHumans() {
      const occupied = () => this.players.filter((p) => !p.leaving).length + this.joinQueue.length;
      while (this.joinQueue.length && occupied() > MAX_SEATS) {
        const bot = this.players.slice().reverse().find((p) => !p.human && !p.leaving);
        if (!bot) break;
        bot.leaving = true;
      }
    }

    /* ---------- главный цикл ---------- */

    async loop(gen) {
      try {
        for (;;) {
          this.makeRoomForHumans();
          this.applySeatChanges();
          await this.waitForPlayers(gen);
          await this.playHand(gen);
          this.players.filter((p) => p.human).forEach((p) => this.hooks.onHandSettled(p, p.chips));
          await this.settleBankruptcies(gen);
          if (this.cfg.autoNextMs) await this.sleep(this.cfg.autoNextMs, gen);
          else if (!this.rebought) await this.waitPending(gen, 'next');
          this.replaceBrokeBots();
        }
      } catch (e) {
        if (e !== ABORT) this.hooks.onError(e);
      }
    }

    guard(gen) { if (gen !== this.gen) throw ABORT; }

    async sleep(ms, gen) {
      await new Promise((r) => setTimeout(r, ms));
      this.guard(gen);
    }

    async waitPending(gen, kind, playerId) {
      const value = await new Promise((r) => {
        this.pending = r;
        this.pendingKind = kind;
        this.pendingPlayer = playerId === undefined ? null : playerId;
      });
      this.guard(gen);
      return value;
    }

    emit() { this.hooks.onChange(); }
    log(text, kind) { this.hooks.onLog(text, kind || ''); }

    // Играть можно, когда за столом хотя бы двое с фишками и не «отошедшие».
    activeCount() { return this.players.filter((p) => p.chips > 0 && !p.sittingOut && !p.leaving).length; }

    async waitForPlayers(gen) {
      while (this.activeCount() < 2) {
        this.emit();
        await new Promise((r) => { this.returnWaiter = r; });
        this.guard(gen);
        this.makeRoomForHumans();
        this.applySeatChanges();
      }
    }

    // Кончились фишки: каждому разорившемуся человеку — минута на пополнение (решает интерфейс или сервер).
    async settleBankruptcies(gen) {
      this.rebought = false;
      const broke = this.players.filter((p) => p.human && p.chips <= 0 && !p.leaving);
      if (!broke.length) return;
      await Promise.all(broke.map(async (p) => {
        const amount = await this.hooks.onBankrupt(p);
        this.guard(gen);
        if (amount > 0 && this.players.includes(p)) {
          p.chips = amount;
          this.rebought = true;
          this.log(`${p.name} пополняет стек на ${fmt(amount)}`, 'sys');
          this.hooks.onHandSettled(p, p.chips);
        } else {
          p.leaving = true;
        }
      }));
      this.emit();
    }

    // Разорившийся бот уходит, на его место садится новый — стол не пустеет.
    replaceBrokeBots() {
      const seated = new Set(this.players.map((p) => p.name));
      for (const p of this.players) {
        if (p.human || p.chips > 0 || p.leaving) continue;
        const free = ROSTER.filter((b) => !seated.has(b.name));
        const pick = free.length ? free[C.randInt(free.length)] : ROSTER[C.randInt(ROSTER.length)];
        this.log(`${p.name} уходит без фишек. За стол садится ${pick.name}`, 'sys');
        seated.delete(p.name);
        seated.add(pick.name);
        Object.assign(p, { id: botId(), name: pick.name, persona: pick.persona, chips: this.cfg.stack, newcomer: true });
      }
    }

    nextSeated(i) {
      const n = this.players.length;
      let j = i;
      for (let k = 0; k < n; k++) {
        j = (j + 1) % n;
        if (!this.players[j].out) return j;
      }
      return i;
    }

    liveCount() { return this.players.filter((p) => !p.folded && !p.out).length; }
    canAct() { return this.players.filter((p) => !p.folded && !p.out && !p.allIn); }

    limits(p) {
      const toCallFull = Math.max(0, this.maxBet - p.bet);
      const potAll = this.pot + this.players.reduce((s, o) => s + o.bet, 0);
      const stackTo = p.bet + p.chips;
      const othersCanAct = this.players.some((o) => o !== p && !o.folded && !o.out && !o.allIn);
      const canRaise = othersCanAct && p.chips > toCallFull;
      let minTo = Math.min(this.maxBet + this.minRaise, stackTo);
      let maxTo = this.potLimit ? Math.min(stackTo, this.maxBet + potAll + toCallFull) : stackTo;
      if (maxTo < minTo) maxTo = minTo;
      return { toCall: Math.min(toCallFull, p.chips), toCallFull, potAll, minTo, maxTo, canRaise, stackTo };
    }

    resetForHand() {
      for (const p of this.players) {
        p.out = p.chips <= 0 || p.sittingOut || p.leaving;
        let note = '';
        if (p.sittingOut) note = 'Отошёл';
        else if (p.out) note = 'Без фишек';
        else if (p.newcomer) note = 'Новый за столом';
        Object.assign(p, {
          hole: [], bet: 0, total: 0, folded: p.out, allIn: false, acted: false,
          lastAction: note, handName: '', winner: false, won: 0, newcomer: false,
        });
      }
      this.board = [];
      this.pot = 0;
      this.maxBet = 0;
      this.street = 'preflop';
      this.showdown = false;
      this.toAct = -1;
    }

    // Сколько раздач (включая текущую) осталось до роста блайндов; null — роста не будет.
    handsLeftAtLevel() {
      if (!this.cfg.blindUp || this.level >= LEVELS.length - 1 || !this.handNo) return null;
      return HANDS_PER_LEVEL - ((this.handNo - 1) % HANDS_PER_LEVEL);
    }

    raiseBlindsIfDue() {
      const due = this.cfg.blindUp && this.handNo > 1 && (this.handNo - 1) % HANDS_PER_LEVEL === 0;
      if (due && this.level < LEVELS.length - 1) {
        this.level++;
        const [sb, bb] = LEVELS[this.level];
        this.log(`Блайнды выросли: ${fmt(sb)} / ${fmt(bb)}`, 'sys');
      }
      [this.sb, this.bb] = LEVELS[this.level];
      this.minRaise = this.bb;
    }

    async playHand(gen) {
      const sp = this.speed;
      this.handNo++;
      this.raiseBlindsIfDue();
      this.resetForHand();
      this.players.forEach((p) => { if (p.sittingOut) p.owesBB = true; });
      this.dealer = this.nextSeated(this.dealer);
      this.deck = C.shuffle(C.makeDeck(this.mode));
      this.hooks.onNewHand();
      this.log(`Раздача ${this.handNo}`, 'hand');

      const seatedCount = this.players.filter((p) => !p.out).length;
      const sbIdx = seatedCount === 2 ? this.dealer : this.nextSeated(this.dealer);
      const bbIdx = this.nextSeated(sbIdx);
      this.post(sbIdx, this.sb, 'Малый блайнд');
      this.post(bbIdx, this.bb, 'Большой блайнд');
      this.maxBet = this.bb;
      this.payMissedBlinds(sbIdx, bbIdx);
      this.hooks.sound('chip');
      this.emit();

      for (let r = 0; r < this.holeN; r++) {
        let i = sbIdx;
        do {
          this.players[i].hole.push(this.deck.pop());
          this.hooks.sound('card');
          this.emit();
          await this.sleep(sp.deal, gen);
          i = this.nextSeated(i);
        } while (i !== sbIdx);
      }

      for (const street of STREETS) {
        if (this.liveCount() <= 1) break;
        if (street !== 'preflop') await this.dealStreet(street, gen);
        const first = street === 'preflop' ? this.nextSeated(bbIdx) : this.nextSeated(this.dealer);
        await this.bettingRound(first, gen);
        if (this.liveCount() > 1 && this.canAct().length <= 1) this.showdown = true;
      }
      this.collect();
      this.resolve();
    }

    // Вернувшийся игрок, пропустивший большой блайнд, докладывает его на стол.
    payMissedBlinds(sbIdx, bbIdx) {
      this.players.forEach((p, i) => {
        if (!p.owesBB || p.out) return;
        if (i !== sbIdx && i !== bbIdx) this.post(i, this.bb, 'Доплата ББ');
        p.owesBB = false;
      });
    }

    async dealStreet(street, gen) {
      const sp = this.speed;
      this.collect();
      this.street = street;
      this.emit();
      await this.sleep(sp.street * 0.5, gen);
      this.deck.pop(); // сжигаем карту
      const n = street === 'flop' ? 3 : 1;
      for (let k = 0; k < n; k++) {
        this.board.push(this.deck.pop());
        this.hooks.sound('card');
        this.emit();
        await this.sleep(sp.deal * 1.8, gen);
      }
      this.log(`${STREET_NAME[street]}: ${C.cardsText(this.board)}`, 'street');
      await this.sleep(this.showdown ? sp.street * 1.6 : sp.street * 0.5, gen);
    }

    post(i, amount, label) {
      const p = this.players[i];
      const pay = Math.min(amount, p.chips);
      p.chips -= pay;
      p.bet += pay;
      p.total += pay;
      if (p.chips === 0) p.allIn = true;
      p.lastAction = `${label} ${fmt(pay)}`;
      this.log(`${p.name}: ${p.lastAction.toLowerCase()}`);
    }

    roundDone() {
      const able = this.canAct();
      if (able.length === 0) return true;
      if (able.length === 1 && able[0].bet >= this.maxBet) return true;
      return able.every((p) => p.acted && p.bet === this.maxBet);
    }

    needsAction(p) {
      return !p.folded && !p.out && !p.allIn && (!p.acted || p.bet < this.maxBet);
    }

    async bettingRound(first, gen) {
      let idx = first;
      for (let guard = 0; guard < 400; guard++) {
        if (this.liveCount() <= 1 || this.roundDone()) return;
        const p = this.players[idx];
        if (this.needsAction(p)) {
          this.toAct = idx;
          this.emit();
          let action;
          if (p.leaving) action = { type: 'fold' };
          else action = (p.human ? await this.askHuman(p, gen) : await this.askBot(p, gen)) || { type: 'fold' };
          // Пока игрок думал, он мог уйти или остаться в раздаче один — тогда его действие уже ничего не меняет.
          if (!p.folded && this.liveCount() > 1) {
            this.apply(p, action);
            if (action.auto && action.type === 'fold') this.sitOut(p);
          }
          this.toAct = -1;
          this.emit();
        }
        idx = (idx + 1) % this.players.length;
      }
    }

    sitOut(p) {
      p.sittingOut = true;
      this.log(`${p.name} отошёл от стола`, 'sys');
      this.hooks.onSitOut(p);
    }

    // Время хода считается по часам, а не по таймерам: свернули приложение — время всё равно идёт.
    async askHuman(p, gen) {
      const L = this.limits(p);
      this.turnDeadline = Date.now() + TURN_MS;
      this.hooks.onHumanTurn(p, L, this.turnDeadline);
      const auto = L.toCallFull > 0 ? { type: 'fold', auto: true } : { type: 'check', auto: true };
      const timer = setInterval(() => {
        if (Date.now() >= this.turnDeadline) this.resolvePending(auto, 'action', p.id);
      }, TURN_CHECK_MS);
      try {
        return await this.waitPending(gen, 'action', p.id);
      } finally {
        clearInterval(timer);
        this.turnDeadline = 0;
      }
    }

    async askBot(p, gen) {
      await this.sleep(this.speed.think * (0.55 + Math.random() * 0.9), gen);
      return P.AI.decide(this, p);
    }

    apply(p, a) {
      const L = this.limits(p);
      let type = a && typeof a.type === 'string' ? a.type : 'fold';
      if (!['fold', 'check', 'call', 'raise'].includes(type)) type = 'fold';
      if (type === 'check' && L.toCallFull > 0) type = 'call';
      if (type === 'raise' && (!L.canRaise || !(Number(a.to) > this.maxBet))) type = L.toCallFull > 0 ? 'call' : 'check';

      if (type === 'fold') {
        p.folded = true;
        p.lastAction = a.auto ? 'Авто-пас' : 'Пас';
        this.hooks.sound('fold');
      } else if (type === 'check') {
        p.lastAction = a.auto ? 'Авто-чек' : 'Чек';
        this.hooks.sound('check');
      } else if (type === 'call') {
        const pay = L.toCall;
        this.pay(p, pay);
        p.lastAction = p.allIn ? `Ва-банк ${fmt(p.bet)}` : `Колл ${fmt(pay)}`;
        this.hooks.sound('chip');
      } else {
        const to = Math.max(L.minTo, Math.min(L.maxTo, Math.round(Number(a.to))));
        const opened = this.maxBet === 0;
        const increase = to - this.maxBet;
        this.pay(p, to - p.bet);
        if (increase >= this.minRaise) {
          this.minRaise = increase;
          this.players.forEach((o) => { if (o !== p) o.acted = false; });
        }
        this.maxBet = Math.max(this.maxBet, to);
        p.lastAction = p.allIn ? `Ва-банк ${fmt(to)}` : `${opened ? 'Ставка' : 'Рейз до'} ${fmt(to)}`;
        this.hooks.sound('chip');
      }
      p.acted = true;
      const reason = a.auto ? ' (время вышло)' : '';
      this.log(`${p.name}: ${p.lastAction.toLowerCase()}${reason}`);
    }

    pay(p, amount) {
      const pay = Math.min(amount, p.chips);
      p.chips -= pay;
      p.bet += pay;
      p.total += pay;
      if (p.chips === 0) p.allIn = true;
    }

    collect() {
      for (const p of this.players) {
        this.pot += p.bet;
        p.bet = 0;
        p.acted = false;
        if (!p.folded && !p.allIn && !p.out) p.lastAction = '';
      }
      this.maxBet = 0;
      this.minRaise = this.bb;
    }

    buildPots(live) {
      const levels = [...new Set(live.map((p) => p.total))].sort((a, b) => a - b);
      const pots = [];
      let prev = 0;
      for (const lv of levels) {
        let amount = 0;
        for (const p of this.players) amount += Math.max(0, Math.min(p.total, lv) - prev);
        pots.push({ amount, elig: live.filter((p) => p.total >= lv) });
        prev = lv;
      }
      const counted = pots.reduce((s, x) => s + x.amount, 0);
      if (pots.length && counted < this.pot) pots[pots.length - 1].amount += this.pot - counted;
      return pots;
    }

    // Порядок по часовой стрелке от дилера — для лишней фишки при делёжке.
    clockwise(list) {
      const n = this.players.length;
      const seat = (p) => (this.players.indexOf(p) - this.dealer + n) % n;
      return list.slice().sort((a, b) => seat(a) - seat(b));
    }

    resolve() {
      const live = this.players.filter((p) => !p.folded && !p.out);
      this.toAct = -1;

      if (live.length === 1) {
        const w = live[0];
        w.chips += this.pot;
        w.won = this.pot;
        w.winner = true;
        this.log(`${w.name} забирает ${fmt(this.pot)}`, 'win');
        this.pot = 0;
        this.hooks.sound('win');
        this.emit();
        this.hooks.onHandEnd({ type: 'fold', winners: [w] });
        return;
      }

      this.showdown = true;
      for (const p of live) {
        p.score = C.bestScore(this.mode, p.hole, this.board);
        p.handName = C.handName(p.score, this.mode);
        this.log(`${p.name}: ${C.cardsText(p.hole)} — ${p.handName}`, 'street');
      }
      for (const pot of this.buildPots(live)) {
        const top = Math.max(...pot.elig.map((p) => p.score));
        const winners = this.clockwise(pot.elig.filter((p) => p.score === top));
        const share = Math.floor(pot.amount / winners.length);
        let rest = pot.amount - share * winners.length;
        for (const w of winners) {
          const extra = rest > 0 ? 1 : 0;
          rest -= extra;
          w.chips += share + extra;
          w.won += share + extra;
          w.winner = true;
        }
      }
      this.pot = 0;
      const winners = live.filter((p) => p.winner);
      winners.forEach((w) => this.log(`${w.name} выигрывает ${fmt(w.won)} — ${w.handName}`, 'win'));
      this.hooks.sound('win');
      this.emit();
      this.hooks.onHandEnd({ type: 'showdown', winners });
    }
  }

  P.Game = Game;
  P.LEVELS = LEVELS;
  P.TURN_MS = TURN_MS;
  P.MAX_SEATS = MAX_SEATS;
})(window.Poker = window.Poker || {});
