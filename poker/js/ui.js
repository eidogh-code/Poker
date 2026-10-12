// Отрисовка стола, панель действий, таймер хода, «отошёл», банкротство, журнал, клавиатура.
(function (P) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Number(n).toLocaleString('ru-RU');
  const esc = (s) => P.Menu.escapeHTML(s);
  const plural = (n, forms) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
    return forms[2];
  };
  const clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const MODE_NAME = { holdem: 'Холдем', omaha: 'Омаха', joker: 'Холдем с джокерами', short: 'Шорт-дек' };
  const MODE_MARK = { holdem: 'Холдем', omaha: 'Омаха', joker: 'Джокер', short: 'Шорт-дек' };
  const ODDS_ITERS = { holdem: 700, omaha: 260, joker: 420, short: 700 };
  const DEFAULTS = { mode: 'holdem', opponents: 5, stack: 1000, level: 1, blindUp: true, speed: 'normal' };
  const BUY_INS = [500, 1000, 2000, 5000];
  const SIT_OUT_MS = 3 * 60 * 1000;   // сколько держим место за отошедшим игроком
  const BANKRUPT_MS = 60 * 1000;      // сколько ждём пополнения, когда фишки кончились
  const AUTO_NEXT_MS = 6 * 1000;      // через сколько начинается следующая раздача
  const TURN_WARN_MS = 10 * 1000;     // когда таймер хода краснеет
  const TICK_MS = 200;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* хранилище недоступно — настройки просто не запомнятся */ } },
  };

  let game = null;
  let limits = null;
  let seen = new Set();
  let oddsOn = store.get('poker.odds', true);
  let oddsTimer = 0;
  let turnTicker = 0;
  let nextTicker = 0;
  let sitOutTicker = 0;
  let bankruptTicker = 0;

  /* ---------- карты ---------- */

  function cardHTML(c, o) {
    const fresh = o && o.fresh ? ' fresh' : '';
    if (o && o.hidden) return `<div class="card back${fresh}" role="img" aria-label="Закрытая карта"></div>`;
    if (c.j) return `<div class="card joker${fresh}" role="img" aria-label="Джокер"><span class="jt" aria-hidden="true">JOKER</span><span class="jk" aria-hidden="true">★</span></div>`;
    const red = c.s === 1 || c.s === 2 ? ' red' : '';
    const r = P.Cards.rankLabel(c.r);
    const s = P.Cards.suitGlyph(c.s);
    return `<div class="card${red}${fresh}" role="img" aria-label="${P.Cards.cardText(c)}"><span class="cr" aria-hidden="true">${r}</span><span class="cs" aria-hidden="true">${s}</span><span class="cc" aria-hidden="true">${s}</span></div>`;
  }

  function isFresh(c) {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  }

  /* ---------- стол ---------- */

  // Места за столом: альбом, низкий альбом (телефон) и портрет — в layout.js.
  const seatGeometry = (i, n, human) => P.Layout.seatGeometry(i, n, human);

  function seatHTML(p, i, n) {
    const g = game;
    const pos = seatGeometry(i, n, p.human);
    const reveal = p.human || (g.showdown && !p.folded);
    const cls = ['seat', p.human ? 'me' : '', pos.upper ? 'upper' : '', g.toAct === i ? 'active' : '',
      p.folded && !p.out ? 'folded' : '', p.out ? 'out' : '', p.winner ? 'winner' : ''].join(' ');
    // В сети чужие карты приходят пустыми (null), пока сервер их не откроет.
    const cards = p.out ? '' : p.hole.map((c, k) => cardHTML(c, { hidden: !reveal || !c, fresh: c ? isFresh(c) : false, key: k })).join('');
    const label = g.showdown && p.handName && !p.folded ? `<span class="hand-label">${esc(p.handName)}</span>` : '';
    const won = p.winner && p.won ? `<span class="won">+${fmt(p.won)}</span>` : '';
    const action = p.connected === false ? 'Нет связи' : p.lastAction;
    const tag = action && !won ? `<span class="tag">${esc(action)}</span>` : '';
    const avatar = p.avatar ? P.Menu.avatarMarkup(p.avatar) : `<span class="avatar">${esc(Array.from(p.name)[0] || '?')}</span>`;
    let html = `<div class="${cls}" style="left:${pos.x}%;top:${pos.y}%" role="listitem" aria-label="${esc(seatSummary(p, i))}">
      <div class="hole${g.holeN === 4 ? ' four' : ''}">${cards}</div>
      <div class="plate tone-${p.tone}" aria-hidden="true">
        ${avatar}
        <span class="who"><span class="pname">${esc(p.name)}</span><span class="pchips">${fmt(p.chips)}</span></span>
      </div>
      <span aria-hidden="true">${won}${tag}${label}</span>
    </div>`;
    if (p.bet > 0) html += `<div class="bet" style="left:${pos.bx}%;top:${pos.by}%" aria-hidden="true"><i class="chip"></i>${fmt(p.bet)}</div>`;
    if (i === g.dealer) html += `<div class="dealer" style="left:${pos.dx}%;top:${pos.dy}%" title="Дилер" aria-hidden="true">D</div>`;
    return html;
  }

  // Текст для скринридера: всё, что зрячий игрок видит на месте игрока.
  function seatSummary(p, i) {
    const parts = [p.human ? `Вы, ${p.name}` : p.name, `${fmt(p.chips)} ${plural(p.chips, ['фишка', 'фишки', 'фишек'])}`];
    if (i === game.dealer) parts.push('дилер');
    if (p.bet > 0) parts.push(`ставка ${fmt(p.bet)}`);
    if (p.lastAction) parts.push(p.lastAction.toLowerCase());
    if (game.showdown && p.handName && !p.folded) parts.push(p.handName.toLowerCase());
    if (p.winner && p.won) parts.push(`выигрыш ${fmt(p.won)}`);
    return parts.join(', ');
  }

  function render() {
    const g = game;
    if (!g || !g.players.length) return;
    const n = g.players.length;
    $('#seats').innerHTML = g.players.map((p, i) => seatHTML(p, i, n)).join('');

    let board = g.board.map((c) => cardHTML(c, { fresh: isFresh(c) })).join('');
    for (let k = g.board.length; k < 5; k++) board += '<div class="slot"></div>';
    $('#board').innerHTML = board;

    const potAll = g.pot + g.players.reduce((s, p) => s + p.bet, 0);
    $('#pot').innerHTML = potAll ? `<i class="chip"></i><span>Банк ${fmt(potAll)}</span>` : '';
    $('#pot').hidden = !potAll;

    $('#m-mode').textContent = MODE_NAME[g.mode];
    $('#m-blinds').textContent = `${fmt(g.sb || 0)} / ${fmt(g.bb || 0)}`;
    $('#m-hand').textContent = String(g.handNo);
    const left = g.handsLeftAtLevel();
    const level = $('#m-level');
    level.textContent = left === null ? 'без роста'
      : left === 1 ? 'растут после этой раздачи' : `рост через ${left} ${plural(left, ['раздачу', 'раздачи', 'раздач'])}`;
    level.classList.toggle('soon', left !== null && left <= 2);
    // Ход мог закончиться без нажатия кнопки (авто-чек или авто-пас по таймеру) — гасим панель.
    if (limits && g.toAct !== 0) setDockActive(false);
    renderMine();
    renderTurnNote();
    renderSitOut();
  }

  function renderMine() {
    const me = game.me;
    let text = '';
    if (!me) text = 'Ждём свободного места — сядете со следующей раздачи';
    else if (me.sittingOut) text = 'Вы отошли';
    else if (me.out) text = 'Ждём раздачу';
    else if (!me.hole.length) text = 'Раздаём карты';
    else if (game.mode === 'omaha' && game.board.length < 3) text = 'Ждём флоп';
    else text = P.Cards.handName(P.Cards.bestScore(game.mode, me.hole, game.board), game.mode);
    $('#mine-hand').textContent = text;
  }

  function renderTurnNote() {
    const p = game.players[game.toAct];
    if (p && p.human) return; // во время своего хода строку ведёт таймер
    $('#turn-note').textContent = p ? `Ходит ${p.name}` : '';
  }

  /* ---------- панель действий и таймер хода ---------- */

  function setDockActive(on) {
    $('#dock').classList.toggle('my-turn', on);
    ['#a-fold', '#a-call', '#a-raise'].forEach((s) => { $(s).disabled = !on; });
    if (!on) {
      limits = null;
      clearTimeout(oddsTimer);
      stopTurnTimer();
      $('#mine-odds').textContent = '';
      $('#a-call-t').textContent = 'Чек';
      $('#a-raise-t').textContent = 'Рейз';
      $('#a-range').disabled = true;
      $('#a-amt').disabled = true;
      document.querySelectorAll('.presets button').forEach((b) => { b.disabled = true; });
    }
  }

  function startTurnTimer(deadline) {
    stopTurnTimer();
    const timer = $('#turn-timer');
    const bar = $('#turn-timer-bar');
    let warned = false;
    timer.hidden = false;
    const tick = () => {
      const left = deadline - Date.now();
      bar.style.width = `${Math.max(0, (left / P.TURN_MS) * 100)}%`;
      timer.classList.toggle('urgent', left <= TURN_WARN_MS);
      $('#turn-note').textContent = `Ваш ход — ${Math.max(0, Math.ceil(left / 1000))} с`;
      if (!warned && left <= TURN_WARN_MS) { warned = true; P.Sound.play('turn'); }
    };
    tick();
    turnTicker = setInterval(tick, TICK_MS);
  }

  function stopTurnTimer() {
    clearInterval(turnTicker);
    $('#turn-timer').hidden = true;
  }

  function onHumanTurn(L, deadline) {
    limits = L;
    const me = game.me;
    setDockActive(true);
    P.Sound.play('turn');

    let callText = 'Чек';
    if (L.toCallFull > 0) callText = L.toCallFull >= me.chips ? `Ва-банк ${fmt(me.chips)}` : `Колл ${fmt(L.toCallFull)}`;
    $('#a-call-t').textContent = callText;

    const canRaise = L.canRaise;
    $('#a-raise').disabled = !canRaise;
    $('#a-range').disabled = !canRaise;
    $('#a-amt').disabled = !canRaise;
    document.querySelectorAll('.presets button').forEach((b) => { b.disabled = !canRaise; });
    $('#preset-max').textContent = game.potLimit ? 'Макс' : 'Ва-банк';
    if (canRaise) {
      const r = $('#a-range');
      r.min = L.minTo; r.max = L.maxTo; r.step = 1;
      setRaise(L.minTo);
    } else {
      $('#a-raise-t').textContent = 'Рейз';
    }
    startTurnTimer(deadline);
    computeOdds();
  }

  function setRaise(value) {
    if (!limits) return;
    const v = Math.max(limits.minTo, Math.min(limits.maxTo, Math.round(Number(value) || 0)));
    $('#a-range').value = v;
    $('#a-amt').value = v;
    const allIn = v >= limits.stackTo;
    const word = allIn ? 'Ва-банк' : game.maxBet === 0 ? 'Ставка' : 'Рейз до';
    $('#a-raise-t').textContent = `${word} ${fmt(v)}`;
    const pct = limits.maxTo > limits.minTo ? ((v - limits.minTo) / (limits.maxTo - limits.minTo)) * 100 : 100;
    $('#a-range').style.setProperty('--fill', pct + '%');
  }

  function presetValue(kind) {
    const L = limits;
    const base = L.potAll + L.toCallFull;
    switch (kind) {
      case 'half': return game.maxBet + base / 2;
      case 'pot': return game.maxBet + base;
      case 'max': return L.maxTo;
      default: return L.minTo;
    }
  }

  // Пас доступен всегда, даже когда можно бесплатно чекнуть: так быстрее выйти из раздачи.
  function act(type) {
    if (!limits) return;
    const action = { type };
    if (type === 'raise') {
      if (!limits.canRaise) return;
      action.to = Number($('#a-range').value);
    }
    if (type === 'call' && limits.toCallFull === 0) action.type = 'check';
    setDockActive(false);
    game.humanAct(action, game.me.id);
  }

  function computeOdds() {
    clearTimeout(oddsTimer);
    const el = $('#mine-odds');
    if (!oddsOn) { el.textContent = ''; return; }
    const me = game.me;
    const opps = game.players.filter((p) => p !== me && !p.folded && !p.out).length;
    if (!me.hole.length || !opps) { el.textContent = ''; return; }
    el.textContent = 'Считаем шансы…';
    oddsTimer = setTimeout(() => {
      const eq = P.Cards.equity(game.mode, me.hole, game.board, opps, ODDS_ITERS[game.mode]);
      const who = opps === 1 ? 'одного соперника' : `${opps} соперников`;
      el.textContent = `Шанс выиграть ≈ ${Math.round(eq * 100)}% против ${who}`;
    }, 30);
  }

  /* ---------- конец раздачи: баннер и автопродолжение ---------- */

  function onHandEnd(summary) {
    setDockActive(false);
    const lines = summary.winners.map((w) => {
      const who = w.human ? 'Вы выигрываете' : `${esc(w.name)} выигрывает`;
      const hand = summary.type === 'showdown' ? `<span class="b-hand">${esc(w.handName || '')}</span>` : '';
      return `<div class="${w.human ? 'me' : ''}"><b>${who} ${fmt(w.won)}</b>${hand}</div>`;
    }).join('');
    const banner = $('#banner');
    banner.innerHTML = `<div class="lines">${lines}</div>
      <button class="btn btn-raise" id="btn-next" type="button"><span id="btn-next-t">Следующая раздача</span> <kbd>Пробел</kbd></button>`;
    banner.hidden = false;
    $('#btn-next').addEventListener('click', nextHand);
    startAutoNext();
  }

  // Следующая раздача начинается сама — стол не ждёт, если игрок отвлёкся.
  function startAutoNext() {
    clearInterval(nextTicker);
    const deadline = Date.now() + AUTO_NEXT_MS;
    const tick = () => {
      const left = deadline - Date.now();
      if (left <= 0) { nextHand(); return; }
      const label = $('#btn-next-t');
      if (label) label.textContent = `Следующая раздача (${Math.ceil(left / 1000)})`;
    };
    tick();
    nextTicker = setInterval(tick, TICK_MS);
  }

  function nextHand() {
    clearInterval(nextTicker);
    $('#banner').hidden = true;
    if (game) game.nextHand();
  }

  /* ---------- «отошёл от стола» ---------- */

  let sitOutDeadline = 0;

  // remainingMs — от сервера (в сети), иначе своё время.
  function onSitOut(remainingMs) {
    sitOutDeadline = Date.now() + (remainingMs > 0 ? remainingMs : SIT_OUT_MS);
    clearInterval(sitOutTicker);
    const tick = () => {
      const left = sitOutDeadline - Date.now();
      if (left <= 0) { leaveTable('afk'); return; }
      $('#sitout-left').textContent = `Раздачи идут без вас. Место держится ещё ${clock(left)}.`;
    };
    tick();
    sitOutTicker = setInterval(tick, TICK_MS);
    renderSitOut();
    P.Sound.play('fold');
  }

  function renderSitOut() {
    const away = Boolean(game && game.me && game.me.sittingOut);
    // Отсчёт не гасим по снимку: в сети «отошёл» приходит раньше состояния. Гасит его возврат или уход.
    $('#sitout').hidden = !away;
    $('#dock').classList.toggle('away', away);
  }

  function returnToTable() {
    clearInterval(sitOutTicker);
    if (game && game.me) game.returnToTable(game.me.id);
    renderSitOut();
  }

  /* ---------- банкротство: минута на пополнение ---------- */

  // Сумма пополнения: выбранный взнос, а если на него не хватает — самый крупный доступный.
  function rebuyAmount(balance) {
    const wanted = game ? game.cfg.stack : BUY_INS[0];
    if (balance >= wanted) return wanted;
    if (game && game.network) return 0; // в сети пополнение — ровно на взнос стола
    const fits = BUY_INS.filter((v) => v <= balance);
    return fits.length ? fits[fits.length - 1] : 0;
  }

  // Один диалог на одно банкротство: повторный вызов (после переподключения) возвращает тот же ответ.
  // В сети деньги списывает лобби, когда сервер подтвердит пополнение.
  let bankruptPromise = null;

  function onBankrupt(remainingMs) {
    if (bankruptPromise) return bankruptPromise;
    clearInterval(nextTicker); // пока решается вопрос с пополнением, раздача не начинается
    bankruptPromise = new Promise((resolve) => {
      const deadline = Date.now() + (remainingMs > 0 ? remainingMs : BANKRUPT_MS);
      let settled = false;
      const finish = (amount) => {
        if (settled) return;
        settled = true;
        clearInterval(bankruptTicker);
        bankruptPromise = null;
        resolve(amount);
        if (!amount) leaveTable('bankrupt');
      };
      const rebuy = () => {
        const amount = rebuyAmount(P.Profile.get().balance);
        if (!amount) return;
        if (!(game && game.network)) P.Profile.update((p) => P.Profile.buyIn(p, amount).state);
        finish(amount);
      };
      const claimAndRebuy = () => { P.Menu.claimBonus(); rebuy(); };
      const show = () => {
        const left = deadline - Date.now();
        if (left <= 0) { closeModal(false); finish(0); return; }
        const profile = P.Profile.get();
        const amount = rebuyAmount(profile.balance);
        const bonus = P.Profile.bonusAvailable(profile, new Date());
        let primary = { label: 'Выйти из-за стола', run: () => finish(0) };
        if (amount) primary = { label: `Пополнить на ${fmt(amount)}`, run: rebuy };
        else if (bonus) primary = { label: `Забрать бонус ${fmt(P.Profile.DAILY_BONUS)} и пополнить`, run: claimAndRebuy };
        const secondary = amount || bonus ? { label: 'Выйти из-за стола', run: () => finish(0) } : null;
        const text = `Фишки на столе кончились. На балансе ${fmt(profile.balance)}. `
          + `Через ${clock(left)} вы выйдете из-за стола.`;
        if (modalState && modalState.kind === 'bankrupt') { $('#modal-text').textContent = text; return; }
        openModal({ kind: 'bankrupt', title: 'Пополнить стек?', text, primary, secondary });
      };
      show();
      clearInterval(bankruptTicker);
      bankruptTicker = setInterval(show, 500);
    });
    return bankruptPromise;
  }

  /* ---------- диалог ---------- */

  let modalState = null;

  // Один диалог на все случаи: банкротство, ошибка, подтверждение выхода. secondary может не быть.
  function openModal({ kind, title, text, primary, secondary, dismissable }) {
    modalState = { kind, dismissable, returnFocus: document.activeElement };
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-primary').textContent = primary.label;
    $('#modal-primary').onclick = () => { closeModal(false); primary.run(); };
    $('#modal-secondary').hidden = !secondary;
    if (secondary) {
      $('#modal-secondary').textContent = secondary.label;
      $('#modal-secondary').onclick = () => { closeModal(false); secondary.run(); };
    }
    $('#modal').hidden = false;
    $('#modal-primary').focus();
  }

  function closeModal(restoreFocus) {
    const state = modalState;
    modalState = null;
    $('#modal').hidden = true;
    if (restoreFocus && state && state.returnFocus && state.returnFocus.focus) state.returnFocus.focus();
  }

  function onError(err) {
    openModal({
      title: 'Игра остановилась',
      text: `Внутренняя ошибка: ${err && err.message ? err.message : err}. Фишки со стола вернутся на баланс.`,
      primary: { label: 'В меню', run: () => leaveTable('error') },
    });
  }

  function confirmLeave() {
    if (!game) { toMenu(); return; }
    const chips = game.me ? game.me.chips : 0;
    openModal({
      title: 'Выйти из-за стола?',
      text: `${fmt(chips)} ${plural(chips, ['фишка вернётся', 'фишки вернутся', 'фишек вернутся'])} на баланс. Ставки текущей раздачи пропадут.`,
      primary: { label: 'Остаться', run: () => {} },
      secondary: { label: 'Выйти в меню', run: () => leaveTable('self') },
      dismissable: true,
    });
  }

  /* ---------- журнал и панели ---------- */

  function onLog(text, kind) {
    const li = document.createElement('li');
    li.textContent = text;
    if (kind) li.className = kind;
    const list = $('#log-list');
    list.appendChild(li);
    while (list.children.length > 400) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    if (kind !== 'street') $('#announcer').textContent = text;
  }

  const DRAWERS = { log: '#btn-log', hands: '#btn-hands', chat: '#btn-chat' };

  function toggleDrawer(id, open) {
    Object.keys(DRAWERS).forEach((key) => {
      const show = key === id ? (open === undefined ? $('#' + key).hidden : open) : false;
      $('#' + key).hidden = !show;
      $(DRAWERS[key]).setAttribute('aria-expanded', String(show));
    });
    if (id === 'chat' && !$('#chat').hidden && P.Lobby) {
      P.Lobby.markChatRead();
      const input = $('#chat input');
      if (input) input.focus();
    }
  }

  function openDrawer() {
    return Object.keys(DRAWERS).find((key) => !$('#' + key).hidden) || null;
  }

  /* ---------- вход за стол и уход ---------- */

  function readSetup(form) {
    const fd = new FormData(form);
    return {
      mode: fd.get('mode'),
      opponents: Number(fd.get('opponents')),
      stack: Number(fd.get('stack')),
      level: Number(fd.get('level')),
      blindUp: fd.get('blindUp') === '1',
      speed: fd.get('speed'),
    };
  }

  function applySetup(form, cfg) {
    Object.keys(cfg).forEach((k) => {
      const val = k === 'blindUp' ? (cfg[k] ? '1' : '0') : String(cfg[k]);
      const el = form.querySelector(`input[name="${k}"][value="${val}"]`);
      if (el) el.checked = true;
    });
  }

  function trySit(cfg) {
    if (!cfg.stack) {
      const bonus = P.Profile.bonusAvailable(P.Profile.get(), new Date());
      P.Menu.showNote(bonus
        ? `На балансе меньше ${fmt(BUY_INS[0])}. Заберите ежедневный бонус, чтобы сесть за стол.`
        : `На балансе меньше ${fmt(BUY_INS[0])}. Новый бонус будет завтра.`);
      return;
    }
    const seat = P.Profile.buyIn(P.Profile.get(), cfg.stack);
    if (!seat.ok) { P.Menu.showNote('На такой взнос не хватает фишек. Выберите сумму поменьше.'); return; }
    P.Profile.update(() => seat.state);
    P.Menu.showNote('');
    startGame(cfg);
  }

  function startGame(cfg) {
    if (game) game.stop();
    store.set('poker.setup', cfg);
    const profile = P.Profile.get();
    $('#menu').hidden = true;
    $('#table-screen').hidden = false;
    closeModal(false);
    toggleDrawer(null);
    $('#banner').hidden = true;
    $('#log-list').innerHTML = '';
    $('#felt-mark').textContent = MODE_MARK[cfg.mode];
    document.body.dataset.mode = cfg.mode;
    setDockActive(false);
    game = new P.Game({ ...cfg, nick: profile.nick, avatar: profile.avatar }, {
      onChange: render,
      onNewHand,
      onHumanTurn: (p, L, deadline) => onHumanTurn(L, deadline),
      onHandEnd,
      onHandSettled: (p, chips) => P.Profile.update((pr) => P.Profile.setTableChips(pr, chips)),
      onBankrupt: () => onBankrupt(),
      onSitOut: () => onSitOut(),
      onError,
      onLog,
      sound: P.Sound.play,
    });
    game.start();
  }

  function onNewHand() {
    seen = new Set();
    clearInterval(nextTicker);
    $('#banner').hidden = true;
  }

  // Сетевая игра подключается к тем же экранам: RemoteGame ведёт себя как Game, а сервер вызывает эти функции.
  function attachSession(session, cfg) {
    if (game) game.stop();
    $('#menu').hidden = true;
    $('#lobby').hidden = true;
    $('#table-screen').hidden = false;
    closeModal(false);
    toggleDrawer(null);
    $('#banner').hidden = true;
    $('#log-list').innerHTML = '';
    $('#felt-mark').textContent = MODE_MARK[cfg.mode];
    document.body.dataset.mode = cfg.mode;
    document.body.classList.toggle('online', Boolean(session.network));
    setDockActive(false);
    game = session;
    render();
  }

  const LEAVE_NOTES = {
    self: (chips) => `Вы встали из-за стола. ${fmt(chips)} на балансе.`,
    afk: (chips) => `Вас долго не было — место за столом освободилось. ${fmt(chips)} вернулись на баланс.`,
    bankrupt: () => 'Фишки кончились, вы вышли из-за стола.',
    error: (chips) => `Игра прервалась. ${fmt(chips)} вернулись на баланс.`,
  };

  // Уход из-за стола любым путём: остаток фишек возвращается в кошелёк.
  function leaveTable(reason) {
    // В сети уходим через сервер: он пришлёт «left» с фишками, лобби вернёт их на баланс.
    if (game && game.network) { game.leave(); return; }
    const chips = game && game.me ? game.me.chips : 0;
    P.Profile.update((p) => P.Profile.cashOut(p, chips));
    toMenu();
    P.Menu.showNote(LEAVE_NOTES[reason] ? LEAVE_NOTES[reason](chips) : '');
  }

  function toMenu() {
    if (game) game.stop();
    game = null;
    [turnTicker, nextTicker, sitOutTicker, bankruptTicker].forEach(clearInterval);
    closeModal(false);
    toggleDrawer(null);
    $('#sitout').hidden = true;
    $('#table-screen').hidden = true;
    $('#menu').hidden = false;
    P.Menu.refresh();
    $('.start').focus();
  }

  function updateSoundButton() {
    const b = $('#btn-sound');
    b.setAttribute('aria-pressed', String(P.Sound.enabled));
    b.textContent = P.Sound.enabled ? 'Звук включён' : 'Звук выключен';
  }

  function updateOddsButton() {
    const b = $('#btn-odds');
    b.setAttribute('aria-pressed', String(oddsOn));
    b.textContent = oddsOn ? 'Скрыть шансы' : 'Показать шансы';
  }

  // Мост к оболочке приложения: WebView2 в Windows или PokerHost в Android. В браузере его нет.
  const host = window.chrome && window.chrome.webview ? window.chrome.webview
    : window.PokerHost ? { postMessage: (message) => window.PokerHost.postMessage(message) }
      : null;

  // Кнопка «Назад» в Android: true — обработали сами, false — пусть приложение закроется.
  P.onBack = () => {
    const sheet = document.querySelector('dialog[open]');
    if (sheet) { sheet.close('cancel'); return true; }
    if (modalState && modalState.dismissable) { closeModal(true); return true; }
    if (openDrawer()) { toggleDrawer(null); return true; }
    if ($('#table-screen').hidden) return P.Lobby ? P.Lobby.onBack() : false;
    if (!$('#modal').hidden) return true; // банкротство и ошибки закрываются только кнопками
    confirmLeave();
    return true;
  };

  function initHost() {
    if (!host) return;
    document.body.classList.add('app-shell');
    if (window.PokerHost) document.body.classList.add('android');
    $('#btn-quit').hidden = false;
    $('#btn-quit').addEventListener('click', () => host.postMessage('quit'));
    document.addEventListener('keydown', (e) => {
      if (e.code === 'F11') { e.preventDefault(); host.postMessage('fullscreen'); }
      if (e.code === 'Escape') host.postMessage('escape');
    });
    document.addEventListener('contextmenu', (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
  }

  function onKey(e) {
    if (e.code === 'Escape') {
      if (modalState && modalState.dismissable) { closeModal(true); return; }
      if (openDrawer()) { const btn = $(DRAWERS[openDrawer()]); toggleDrawer(null); btn.focus(); return; }
    }
    // Набор текста (чат, ник, код) не должен нажимать игровые клавиши F/C/R и «Пробел».
    const typing = e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    if (typing && e.target.id !== 'a-amt') return;
    if (!game || !$('#modal').hidden || $('#table-screen').hidden || document.querySelector('dialog[open]')) return;
    const inNumber = e.target && e.target.id === 'a-amt';
    if (!$('#banner').hidden && (e.code === 'Space' || e.code === 'Enter')) {
      e.preventDefault();
      nextHand();
      return;
    }
    if (!limits) return;
    if (inNumber) {
      if (e.code === 'Enter') { setRaise(e.target.value); act('raise'); }
      return;
    }
    const step = Math.max(1, game.bb);
    switch (e.code) {
      case 'KeyF': act('fold'); break;
      case 'KeyC': act('call'); break;
      case 'KeyR': if (limits.canRaise) act('raise'); break;
      case 'ArrowUp': e.preventDefault(); setRaise(Number($('#a-range').value) + step); break;
      case 'ArrowDown': e.preventDefault(); setRaise(Number($('#a-range').value) - step); break;
      default: break;
    }
  }

  function init() {
    const form = $('#setup');
    initHost();
    applySetup(form, Object.assign({}, DEFAULTS, store.get('poker.setup', {})));
    P.Menu.init();
    form.addEventListener('submit', (e) => { e.preventDefault(); trySit(readSetup(form)); });

    P.Sound.enabled = store.get('poker.sound', true);
    updateSoundButton();
    updateOddsButton();

    $('#btn-menu').addEventListener('click', confirmLeave);
    $('#btn-return').addEventListener('click', returnToTable);
    $('#btn-sound').addEventListener('click', () => {
      P.Sound.enabled = !P.Sound.enabled;
      store.set('poker.sound', P.Sound.enabled);
      updateSoundButton();
    });
    $('#btn-odds').addEventListener('click', () => {
      oddsOn = !oddsOn;
      store.set('poker.odds', oddsOn);
      updateOddsButton();
      if (limits) computeOdds(); else $('#mine-odds').textContent = '';
    });
    $('#btn-log').addEventListener('click', () => toggleDrawer('log'));
    $('#btn-hands').addEventListener('click', () => toggleDrawer('hands'));
    document.querySelectorAll('.drawer [data-close]').forEach((b) => {
      b.addEventListener('click', () => { const id = b.closest('.drawer').id; toggleDrawer(null); $(DRAWERS[id]).focus(); });
    });

    $('#a-fold').addEventListener('click', () => act('fold'));
    $('#a-call').addEventListener('click', () => act('call'));
    $('#a-raise').addEventListener('click', () => act('raise'));
    $('#a-range').addEventListener('input', (e) => setRaise(e.target.value));
    $('#a-amt').addEventListener('change', (e) => setRaise(e.target.value));
    document.querySelectorAll('.presets button').forEach((b) => {
      b.addEventListener('click', () => { if (limits) setRaise(presetValue(b.dataset.p)); });
    });

    document.addEventListener('keydown', onKey);
    // Поворот телефона или смена высоты окна — места за столом пересчитываются.
    P.Layout.onChange(() => { if (game) render(); });
  }

  // Сетевой стол уходит со сцены: в лобби вернёт lobby.js.
  function closeTable() {
    [turnTicker, nextTicker, sitOutTicker, bankruptTicker].forEach(clearInterval);
    bankruptPromise = null;
    closeModal(false);
    toggleDrawer(null);
    setDockActive(false);
    $('#sitout').hidden = true;
    $('#table-screen').hidden = true;
    document.body.classList.remove('online');
    game = null;
  }

  function updateMusicButtons() {
    const on = P.Music.enabled;
    document.querySelectorAll('[data-music-toggle]').forEach((b) => {
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? 'Музыка включена' : 'Музыка выключена';
    });
  }

  function initMusic() {
    P.Music.setEnabled(store.get('poker.music', true));
    updateMusicButtons();
    // Браузеры разрешают звук только после жеста пользователя — первое касание «будит» музыку.
    const unlock = () => P.Music.unlock();
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    document.querySelectorAll('[data-music-toggle]').forEach((b) => b.addEventListener('click', () => {
      P.Music.setEnabled(!P.Music.enabled);
      store.set('poker.music', P.Music.enabled);
      updateMusicButtons();
    }));
  }

  P.UI = { attachSession, closeTable, render: () => render(), onHumanTurn, onHandEnd, onNewHand, onLog, onBankrupt, onSitOut };

  document.addEventListener('DOMContentLoaded', () => {
    init();
    initMusic();
    $('#btn-chat').addEventListener('click', () => toggleDrawer('chat'));
    if (P.Lobby) P.Lobby.init();
  });
})(window.Poker = window.Poker || {});
