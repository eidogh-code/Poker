// Кэш-стол: блайнды, улицы, торговля, побочные банки, вскрытие, таймер хода, «отошёл», пересадка ботов.
(function (P) {
  'use strict';

  const C = P.Cards;
  const LEVELS = [[5, 10], [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [500, 1000], [1000, 2000]];
  const HANDS_PER_LEVEL = 10;
  const TURN_MS = 60 * 1000;      // время на ход
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

  class Game {
    constructor(cfg, hooks) {
      this.cfg = cfg;
      this.hooks = hooks;
      this.gen = 0;
      this.pending = null;
      this.returnWaiter = null;
      this.turnDeadline = 0;
      this.players = [];
    }

    get speed() { return SPEED[this.cfg.speed] || SPEED.normal; }
    get me() { return this.players[0]; }

    start() {
      this.stop();
      const cfg = this.cfg;
      this.mode = cfg.mode;
      this.holeN = cfg.mode === 'omaha' ? 4 : 2;
      this.potLimit = cfg.mode === 'omaha';
      const human = { name: cfg.nick, avatar: cfg.avatar, human: true };
      const bots = ROSTER.slice(0, cfg.opponents).map((b) => ({ name: b.name, persona: b.persona }));
      this.players = [human].concat(bots).map((p, i) => Object.assign(p, {
        id: i, tone: i, chips: cfg.stack, hole: [], bet: 0, total: 0,
        folded: false, allIn: false, acted: false, out: false,
        sittingOut: false, owesBB: false, newcomer: false,
        lastAction: '', handName: '', winner: false, won: 0,
      }));
      this.dealer = C.randInt(this.players.length);
      this.handNo = 0;
      this.level = cfg.level;
      this.board = [];
      this.pot = 0;
      this.maxBet = 0;
      this.toAct = -1;
      this.showdown = false;
      this.street = 'preflop';
      this.loop(this.gen);
    }

    stop() {
      this.gen++;
      this.resolvePending(null);
      this.wakeReturnWaiter();
    }

    // kind — чего именно ждёт игра: 'action' (ход игрока) или 'next' (следующая раздача).
    // Сигнал не того вида игнорируется, чтобы запоздалое «дальше» не засчиталось как ход.
    resolvePending(value, kind) {
      if (!this.pending || (kind && kind !== this.pendingKind)) return;
      const r = this.pending;
      this.pending = null;
      this.pendingKind = null;
      r(value);
    }

    wakeReturnWaiter() {
      if (!this.returnWaiter) return;
      const r = this.returnWaiter;
      this.returnWaiter = null;
      r();
    }

    humanAct(action) { this.resolvePending(action, 'action'); }
    nextHand() { this.resolvePending(true, 'next'); }

    // Игрок вернулся после «отошёл»: со следующей раздачи снова в игре, пропущенный ББ доплатит.
    returnToTable() {
      if (!this.me || !this.me.sittingOut) return;
      this.me.sittingOut = false;
      this.log(`${this.me.name} возвращается за стол`, 'sys');
      this.emit();
      this.wakeReturnWaiter();
    }

    async loop(gen) {
      try {
        for (;;) {
          await this.waitForPlayers(gen);
          await this.playHand(gen);
          this.hooks.onHandSettled(this.me.chips);
          const wasBroke = this.me.chips <= 0;
          if (!(await this.settleBankruptcy(gen))) return;
          // После пополнения игрок уже нажал кнопку — следующая раздача начинается сразу.
          if (!wasBroke) await this.waitPending(gen, 'next');
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

    async waitPending(gen, kind) {
      const value = await new Promise((r) => { this.pending = r; this.pendingKind = kind; });
      this.guard(gen);
      return value;
    }

    emit() { this.hooks.onChange(); }
    log(text, kind) { this.hooks.onLog(text, kind || ''); }

    // Играть можно, когда за столом хотя бы двое с фишками и не «отошедшие».
    activeCount() { return this.players.filter((p) => p.chips > 0 && !p.sittingOut).length; }

    async waitForPlayers(gen) {
      while (this.activeCount() < 2) {
        this.emit();
        await new Promise((r) => { this.returnWaiter = r; });
        this.guard(gen);
      }
    }

    // Фишки кончились: интерфейс даёт минуту на пополнение. 0 — игрок ушёл из-за стола.
    async settleBankruptcy(gen) {
      if (this.me.chips > 0) return true;
      const amount = await this.hooks.onBankrupt();
      this.guard(gen);
      if (!amount) return false;
      this.me.chips = amount;
      this.log(`${this.me.name} пополняет стек на ${fmt(amount)}`, 'sys');
      this.hooks.onHandSettled(this.me.chips);
      this.emit();
      return true;
    }

    // Разорившийся бот уходит, на его место садится новый — стол не пустеет.
    replaceBrokeBots() {
      const seated = new Set(this.players.map((p) => p.name));
      for (const p of this.players) {
        if (p.human || p.chips > 0) continue;
        const free = ROSTER.filter((b) => !seated.has(b.name));
        const pick = free.length ? free[C.randInt(free.length)] : ROSTER[C.randInt(ROSTER.length)];
        this.log(`${p.name} уходит без фишек. За стол садится ${pick.name}`, 'sys');
        seated.delete(p.name);
        seated.add(pick.name);
        Object.assign(p, { name: pick.name, persona: pick.persona, chips: this.cfg.stack, newcomer: true });
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
        p.out = p.chips <= 0 || p.sittingOut;
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
      if (this.me.sittingOut) this.me.owesBB = true;
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
      this.payMissedBlind(sbIdx, bbIdx);
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
    payMissedBlind(sbIdx, bbIdx) {
      const me = this.me;
      if (!me.owesBB || me.out) return;
      if (me.id !== sbIdx && me.id !== bbIdx) this.post(me.id, this.bb, 'Доплата ББ');
      me.owesBB = false;
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
      const n = this.players.length;
      let idx = first;
      for (let guard = 0; guard < 400; guard++) {
        if (this.liveCount() <= 1 || this.roundDone()) return;
        const p = this.players[idx];
        if (this.needsAction(p)) {
          this.toAct = idx;
          this.emit();
          const action = (p.human ? await this.askHuman(p, gen) : await this.askBot(p, gen)) || { type: 'fold' };
          this.apply(p, action);
          this.toAct = -1;
          if (action.auto && action.type === 'fold') this.sitOut(p);
          this.emit();
        }
        idx = (idx + 1) % n;
      }
    }

    sitOut(p) {
      p.sittingOut = true;
      this.log(`${p.name} отошёл от стола`, 'sys');
      this.hooks.onSitOut();
    }

    // Время хода считается по часам, а не по таймерам: свернули приложение — время всё равно идёт.
    async askHuman(p, gen) {
      const L = this.limits(p);
      this.turnDeadline = Date.now() + TURN_MS;
      this.hooks.onHumanTurn(L, this.turnDeadline);
      const auto = L.toCallFull > 0 ? { type: 'fold', auto: true } : { type: 'check', auto: true };
      const timer = setInterval(() => {
        if (Date.now() >= this.turnDeadline) this.resolvePending(auto, 'action');
      }, TURN_CHECK_MS);
      try {
        return await this.waitPending(gen, 'action');
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
      let type = a.type;
      if (type === 'check' && L.toCallFull > 0) type = 'call';
      if (type === 'raise' && (!L.canRaise || !(a.to > this.maxBet))) type = L.toCallFull > 0 ? 'call' : 'check';

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
        const to = Math.max(L.minTo, Math.min(L.maxTo, Math.round(a.to)));
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
      return list.slice().sort((a, b) => ((a.id - this.dealer + n) % n) - ((b.id - this.dealer + n) % n));
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
})(window.Poker = window.Poker || {});
