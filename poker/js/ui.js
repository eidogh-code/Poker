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
  const MODE_NAME = { holdem: 'Холдем', omaha: 'Омаха', joker: 'Холдем с джокерами', short: 'Шорт-дек', aof: 'AoF Холдем', aofomaha: 'AoF Омаха' };
  const MODE_MARK = { holdem: 'Холдем', omaha: 'Омаха', joker: 'Джокер', short: 'Шорт-дек', aof: 'All-in or Fold', aofomaha: 'AoF Омаха' };
  const ODDS_ITERS = { holdem: 700, omaha: 260, joker: 420, short: 700, aof: 700, aofomaha: 260 };
  const DEFAULTS = { mode: 'holdem', opponents: 5, speed: 'normal', format: 'cash', tbuy: 1000 };
  const SIT_OUT_MS = 3 * 60 * 1000;   // сколько держим место за отошедшим игроком
  const BANKRUPT_MS = 60 * 1000;      // сколько ждём пополнения, когда фишки кончились
  const AFTER_HAND_MS = 2500;         // пауза, чтобы досмотреть вскрытие, прежде чем спрашивать о докупке или итогах
  const PEEK_MS = 5000;               // сколько лежат «несыгранные» карты рубашкой вверх
  const NEXT_MS = { fold: 3000, showdown: 5000, peek: 6500, peeked: 3500 }; // через сколько следующая раздача
  const RUSH_NEXT_MS = { fold: 1500, showdown: 3500, peek: 4500, peeked: 2500 };
  const TURN_WARN_MS = 10 * 1000;     // когда таймер хода краснеет
  const TOAST_MS = 2600;
  const SWIPE_MIN_PX = 60;            // свайп двумя пальцами короче — не жест смены стола
  const SWIPE_MAX_MS = 1200;
  const CHIP_FLIGHT = { count: 7, ms: 700, stagger: 55 };
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
  let bankruptShowTimer = 0;
  let resultTimer = 0;
  let switchTimer = 0;
  let toastTimer = 0;
  let setup = null;        // настройки офлайн-стола — с ними пересаживаемся за другой стол
  let peek = null;         // { cards, revealed, timer } — карты, которые легли бы на стол
  let handOver = false;    // раздача закончилась, следующая ещё не началась
  let pendingStake = 0;    // стол, за который пересядем после текущей раздачи
  let switchTarget = 0;    // раздача кончилась, пересадка на этот стол уже запланирована
  let lastSwitchAt = 0;    // защита от двойного нажатия и зажатой клавиши
  let tourneyOver = false; // итог турнира уже решён — «Меню» больше не спрашивает о выходе

  /* ---------- карты ---------- */

  function cardHTML(c, o) {
    const fresh = (o && o.fresh ? ' fresh' : '') + (o && o.ghost ? ' ghost' : '');
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
    const rest = peek ? peek.cards : [];
    for (let k = g.board.length; k < 5; k++) {
      const c = rest[k - g.board.length];
      if (!c) board += '<div class="slot"></div>';
      else if (peek.revealed) board += cardHTML(c, { ghost: true });
      else board += '<button class="card back peek-card" type="button" data-peek aria-label="Показать, какие карты легли бы на стол"></button>';
    }
    $('#board').innerHTML = board;

    const potAll = g.pot + g.players.reduce((s, p) => s + p.bet, 0);
    $('#pot').innerHTML = potAll ? `<i class="chip"></i><span>Банк ${fmt(potAll)}</span>` : '';
    $('#pot').hidden = !potAll;

    $('#m-mode').textContent = MODE_NAME[g.mode];
    $('#m-blinds').textContent = `${fmt(g.sb || 0)} / ${fmt(g.bb || 0)}`;
    $('#m-hand').textContent = String(g.handNo);
    const left = g.handsLeftAtLevel();
    const level = $('#m-level');
    if (!g.tournament) level.textContent = `стол ${fmt(g.cfg.stack)}${pendingStake ? ` → ${fmt(pendingStake)}` : ''}`;
    else if (left === null) level.textContent = 'последний уровень';
    else level.textContent = left === 1 ? 'растут после этой раздачи' : `рост через ${left} ${plural(left, ['раздачу', 'раздачи', 'раздач'])}`;
    level.classList.toggle('soon', left !== null && left <= 2);
    renderStakeNav();
    // AoF: в панели только «Фолд» и «Олл-ин» — и в свой ход, и в ожидании.
    $('#dock').classList.toggle('aof', Boolean(g.aof));
    if (!limits) $('#a-fold-t').textContent = g.aof ? 'Фолд' : 'Пас';
    // Ход мог закончиться без нажатия кнопки (авто-чек или авто-пас по таймеру) — гасим панель.
    if (limits && g.toAct !== 0) setDockActive(false);
    if (g.rush && !limits) $('#a-fold').disabled = !canFastFold();
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
    else if (game.holeN === 4 && game.board.length < 3) text = 'Ждём флоп';
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

    // AoF: две кнопки — «Фолд» и «Олл-ин»; ползунка и рейзов нет.
    const aof = Boolean(L.aof);
    $('#dock').classList.toggle('aof', aof);
    $('#a-fold-t').textContent = aof ? 'Фолд' : 'Пас';
    let callText = 'Чек';
    if (aof && L.canRaise) callText = `Олл-ин ${fmt(L.stackTo)}`;
    else if (L.toCallFull > 0) callText = L.toCallFull >= me.chips ? `${aof ? 'Олл-ин' : 'Ва-банк'} ${fmt(me.chips)}` : `Колл ${fmt(L.toCallFull)}`;
    $('#a-call-t').textContent = callText;
    if (aof) {
      startTurnTimer(deadline);
      computeOdds();
      return;
    }

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
  // Rush & Cash: «Пас» в любой момент раздачи — и сразу за новый стол.
  const canFastFold = () => Boolean(game && game.rush && !game.network && !handOver
    && game.me && game.me.hole.length && !game.me.folded && !game.me.out && !game.me.allIn && game.me.chips > 0);

  function rushMove() {
    if (!game || !game.rush || !setup) return false;
    if (pendingStake) { const target = pendingStake; pendingStake = 0; return doSwitch(target); }
    const chips = game.me ? game.me.chips : 0;
    if (chips <= 0) return false; // без фишек — сначала докупка
    P.Profile.update((p) => P.Profile.setTableChips(p, chips));
    startGame({ ...setup, myChips: chips });
    return true;
  }

  function act(type) {
    // Не удалось пересесть (не хватило на назначенный стол) — обычный пас за этим столом.
    if (type === 'fold' && canFastFold() && rushMove()) return;
    if (!limits) return;
    let action = { type };
    if (limits.aof) {
      // AoF: «играю» — это всегда весь стек; сервер и движок принимают обычные рейз и колл.
      if (type !== 'fold') action = limits.canRaise ? { type: 'raise', to: limits.stackTo } : { type: limits.toCallFull > 0 ? 'call' : 'check' };
    } else if (type === 'raise') {
      if (!limits.canRaise) return;
      action.to = Number($('#a-range').value);
    }
    if (action.type === 'call' && limits.toCallFull === 0) action.type = 'check';
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

  /* ---------- конец раздачи: фишки к победителю, «несыгранные» карты, автопродолжение ---------- */

  // Кто выиграл и почему, видно на самом столе: открытые карты, комбинация на месте игрока
  // и фишки, которые летят из центра к победителю. Отдельного сообщения нет.
  function onHandEnd(summary) {
    setDockActive(false);
    handOver = true;
    flyChips(summary.winners);
    const rest = summary.type === 'fold' && summary.rest && summary.rest.length ? summary.rest : null;
    if (rest) showPeek(rest);
    // В сети следующую раздачу начинает сервер; офлайн — мы, с кнопкой «Дальше» на случай, если ждать не хочется.
    const pace = game.rush ? RUSH_NEXT_MS : NEXT_MS; // в Rush & Cash темп быстрее
    if (!game.network) showNext(rest ? pace.peek : pace[summary.type] || pace.fold);
    if (pendingStake) {
      switchTarget = pendingStake;
      pendingStake = 0;
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => doSwitch(switchTarget), AFTER_HAND_MS);
    }
  }

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Фишки летят из центра стола к табличке победителя; при дележе банка — к каждому.
  // Полёт показывает, кто забрал банк, поэтому он есть всегда; с «уменьшением движения» в системе — короче и скромнее.
  function flyChips(winners) {
    const layer = $('#chip-layer');
    if (!game || typeof layer.animate !== 'function') return;
    const calm = reducedMotion();
    const count = calm ? 3 : CHIP_FLIGHT.count;
    const base = layer.getBoundingClientRect();
    const center = $('#board').getBoundingClientRect();
    const fx = center.left + center.width / 2 - base.left;
    const fy = center.top + center.height / 2 - base.top;
    const seats = document.querySelectorAll('#seats .seat');
    const jitter = () => (Math.random() - 0.5) * 22;
    winners.forEach((w, wi) => {
      const seat = seats[game.players.findIndex((p) => p.id === w.id)];
      const plate = seat && seat.querySelector('.plate');
      if (!plate) return;
      const r = plate.getBoundingClientRect();
      const dx = r.left + r.width / 2 - base.left - fx;
      const dy = r.top + r.height / 2 - base.top - fy;
      for (let k = 0; k < count; k++) {
        const chip = document.createElement('i');
        chip.className = 'chip flying';
        chip.style.left = `${fx}px`;
        chip.style.top = `${fy}px`;
        layer.appendChild(chip);
        const sx = jitter();
        const sy = jitter();
        const anim = chip.animate([
          { transform: `translate(-50%, -50%) translate(${sx}px, ${sy}px) scale(1)`, opacity: 0 },
          { transform: `translate(-50%, -50%) translate(${sx}px, ${sy}px) scale(1)`, opacity: 1, offset: 0.12 },
          { transform: `translate(-50%, -50%) translate(${dx + jitter() / 2}px, ${dy + jitter() / 2}px) scale(.9)`, opacity: 1, offset: 0.88 },
          { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(.55)`, opacity: 0 },
        ], { duration: CHIP_FLIGHT.ms, delay: wi * 180 + k * CHIP_FLIGHT.stagger, easing: 'cubic-bezier(.35,.75,.35,1)', fill: 'both' });
        const done = () => chip.remove();
        anim.onfinish = done;
        anim.oncancel = done;
      }
    });
  }

  // Все сбросили до вскрытия: несыгранные карты лежат рубашкой вверх, касание переворачивает их.
  function showPeek(cards) {
    clearPeek();
    peek = { cards, revealed: false, timer: setTimeout(() => { peek = null; render(); }, PEEK_MS) };
    render();
  }

  function revealPeek() {
    if (!peek || peek.revealed) return;
    clearTimeout(peek.timer);
    peek.revealed = true; // перевёрнутые карты остаются до следующей раздачи
    render();
    P.Sound.play('card');
    // Дать рассмотреть: следующая раздача не раньше чем через пару секунд.
    if (!game.network && !$('#banner').hidden && nextDeadline - Date.now() < NEXT_MS.peeked) showNext(NEXT_MS.peeked);
  }

  function clearPeek() {
    if (peek) clearTimeout(peek.timer);
    peek = null;
  }

  // Следующая раздача начинается сама — стол не ждёт, если игрок отвлёкся.
  let nextDeadline = 0;

  function showNext(ms) {
    const banner = $('#banner');
    if (banner.hidden) {
      banner.innerHTML = '<button class="btn btn-raise next-btn" id="btn-next" type="button"><span id="btn-next-t">Дальше</span> <kbd>Пробел</kbd></button>';
      $('#btn-next').addEventListener('click', nextHand);
      banner.hidden = false;
    }
    clearInterval(nextTicker);
    nextDeadline = Date.now() + ms;
    const tick = () => {
      const left = nextDeadline - Date.now();
      if (left <= 0) { nextHand(); return; }
      const label = $('#btn-next-t');
      if (label) label.textContent = `Дальше · ${Math.ceil(left / 1000)}`;
    };
    tick();
    nextTicker = setInterval(tick, TICK_MS);
  }

  function nextHand() {
    clearInterval(nextTicker);
    $('#banner').hidden = true;
    // Пересадка уже назначена — пересаживаемся сразу, а не после блайндов новой раздачи.
    if (switchTarget) {
      const target = switchTarget;
      switchTarget = 0;
      clearTimeout(switchTimer);
      if (doSwitch(target)) return;
    }
    // Rush & Cash: каждая раздача — за новым столом с новыми соперниками.
    // Отошедший игрок остаётся за столом: там идёт его отсчёт до выхода, пересадка его бы сбросила.
    if (game && game.rush && !(game.me && game.me.sittingOut) && rushMove()) return;
    if (game) game.nextHand();
  }

  /* ---------- «отошёл от стола» ---------- */

  let sitOutDeadline = 0;

  // remainingMs — от сервера (в сети), иначе своё время.
  function onSitOut(remainingMs) {
    clearInterval(sitOutTicker);
    // В турнире место не теряется: раздачи идут, карты сбрасываются сами, блайнды списываются.
    if (game && game.tournament) {
      $('#sitout-left').textContent = 'Карты сбрасываются автоматически, блайнды списываются.';
      renderSitOut();
      P.Sound.play('fold');
      return;
    }
    sitOutDeadline = Date.now() + (remainingMs > 0 ? remainingMs : SIT_OUT_MS);
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

  /* ---------- банкротство: минута на докупку ---------- */

  // Докупка — ровно на взнос этого стола (100 больших блайндов), не больше и не меньше.
  // Не хватает — офлайн можно пересесть за стол дешевле.
  function rebuyOptions(profile) {
    const stake = game.cfg.stack;
    const bonus = P.Profile.bonusAvailable(profile, new Date());
    const lower = game.network ? 0 : P.pickStake(game.mode, profile.balance);
    return {
      stake,
      canRebuy: profile.balance >= stake,
      bonusRebuy: bonus && profile.balance + P.Profile.DAILY_BONUS >= stake,
      lower: lower && lower < stake ? lower : 0,
    };
  }

  // Одна панель на одно банкротство: повторный вызов (после переподключения) возвращает тот же ответ.
  // В сети деньги списывает лобби, когда сервер подтвердит пополнение.
  let bankruptPromise = null;

  function onBankrupt(remainingMs) {
    if (bankruptPromise) return bankruptPromise;
    clearInterval(nextTicker); // пока решается вопрос с докупкой, раздача не начинается
    $('#banner').hidden = true;
    bankruptPromise = new Promise((resolve) => {
      const deadline = Date.now() + (remainingMs > 0 ? remainingMs : BANKRUPT_MS);
      let settled = false;
      const finish = (amount, after) => {
        if (settled) return;
        settled = true;
        clearInterval(bankruptTicker);
        clearTimeout(bankruptShowTimer);
        hideRebuy();
        bankruptPromise = null;
        resolve(amount);
        if (after) after();
        else if (!amount) leaveTable('bankrupt');
      };
      const rebuy = () => {
        const { stake, canRebuy } = rebuyOptions(P.Profile.get());
        if (!canRebuy) return;
        if (!game.network) P.Profile.update((p) => P.Profile.buyIn(p, stake).state);
        finish(stake);
      };
      const tick = () => {
        const left = deadline - Date.now();
        if (left <= 0) { finish(0); return; }
        $('#rebuy-text').textContent = `На балансе ${fmt(P.Profile.get().balance)}. Через ${clock(left)} вы выйдете из-за стола.`;
      };
      const show = () => {
        const profile = P.Profile.get();
        const o = rebuyOptions(profile);
        const acts = [];
        if (o.canRebuy) acts.push({ label: `Докупить ${fmt(o.stake)}`, cls: 'btn-raise', run: rebuy });
        else if (o.bonusRebuy) acts.push({ label: `Бонус +${fmt(P.Profile.DAILY_BONUS)} и докупить`, cls: 'btn-raise', run: () => { P.Menu.claimBonus(); rebuy(); } });
        if (o.lower) {
          const [sb, bb] = P.blindsFor(o.lower);
          acts.push({ label: `Стол ${fmt(sb)}/${fmt(bb)} · ${fmt(o.lower)}`, cls: 'btn-call', run: () => finish(0, () => doSwitch(o.lower)) });
        }
        acts.push({ label: 'Выйти', cls: 'btn-ghost', run: () => finish(0) });
        showRebuy(acts);
        tick();
        bankruptTicker = setInterval(tick, 500);
      };
      // Сначала даём досмотреть вскрытие и полёт фишек — кто выиграл и чем, — потом спрашиваем.
      clearInterval(bankruptTicker);
      clearTimeout(bankruptShowTimer);
      bankruptShowTimer = setTimeout(show, AFTER_HAND_MS);
    });
    return bankruptPromise;
  }

  function showRebuy(acts) {
    const box = $('#rebuy-acts');
    box.replaceChildren(...acts.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn ${a.cls}`;
      b.textContent = a.label;
      b.addEventListener('click', a.run);
      return b;
    }));
    $('#rebuy').hidden = false;
    $('#dock').classList.add('broke');
    box.firstChild.focus();
  }

  function hideRebuy() {
    $('#rebuy').hidden = true;
    $('#dock').classList.remove('broke');
  }

  /* ---------- турнир: итог ---------- */

  // Место в турнире показываем, когда досмотрели последнюю раздачу. onClose — «Готово».
  function onTournamentResult({ place, prize, players, buyIn }, onClose) {
    tourneyOver = true;
    clearTimeout(resultTimer);
    clearInterval(nextTicker);
    $('#banner').hidden = true;
    resultTimer = setTimeout(() => {
      const win = place === 1;
      const rivals = players - 1;
      const beaten = rivals === 1 ? 'Вы обыграли соперника' : `Вы обыграли всех ${rivals} соперников`;
      const text = win
        ? `${beaten}. Призовой фонд ${fmt(prize)} — на вашем балансе.`
        : `Вы выбыли на ${place}-м месте из ${players}. Взнос ${fmt(buyIn)} остался в призовом фонде.`;
      openModal({
        kind: 'result',
        title: win ? 'Победа в турнире!' : `${place}-е место`,
        text,
        primary: { label: game && game.network ? 'В лобби' : 'В меню', run: onClose },
      });
      if (win) P.Sound.play('win');
    }, AFTER_HAND_MS);
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
      text: `Внутренняя ошибка: ${err && err.message ? err.message : err}. `
        + (game && game.tournament ? 'Турнир прерван.' : 'Фишки со стола вернутся на баланс.'),
      primary: { label: 'В меню', run: () => leaveTable('error') },
    });
  }

  function confirmLeave() {
    if (!game) { toMenu(); return; }
    if (tourneyOver) return; // итог турнира уже на подходе или на экране — выход из него через «Готово»
    const chips = game.me ? game.me.chips : 0;
    openModal({
      title: game.tournament ? 'Выйти из турнира?' : 'Выйти из-за стола?',
      text: game.tournament
        ? 'Вы выбудете из турнира. Взнос не возвращается — он остаётся в призовом фонде.'
        : `${fmt(chips)} ${plural(chips, ['фишка вернётся', 'фишки вернутся', 'фишек вернутся'])} на баланс. Ставки текущей раздачи пропадут.`,
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
      speed: fd.get('speed'),
      format: ['tournament', 'rush'].includes(fd.get('format')) ? fd.get('format') : 'cash',
      tbuy: Number(fd.get('tbuy')) || P.TOURNEY.buyIns[0],
    };
  }

  function applySetup(form, cfg) {
    Object.keys(cfg).forEach((k) => {
      const el = form.querySelector(`input[name="${k}"][value="${String(cfg[k])}"]`);
      if (el) el.checked = true;
    });
  }

  function noMoneyNote(min) {
    const bonus = P.Profile.bonusAvailable(P.Profile.get(), new Date());
    P.Menu.showNote(bonus
      ? `На балансе меньше ${fmt(min)}. Заберите ежедневный бонус, чтобы сесть за стол.`
      : `На балансе меньше ${fmt(min)}. Новый бонус будет завтра.`);
  }

  // Кэш: садимся за самый дорогой стол по балансу, со 100 большими блайндами.
  // Турнир: взнос уходит в призовой фонд, у всех одинаковый турнирный стек.
  function trySit(cfg) {
    const profile = P.Profile.get();
    if (cfg.format === 'tournament') {
      const paid = P.Profile.payEntry(profile, cfg.tbuy);
      if (!paid.ok) { noMoneyNote(cfg.tbuy); return; }
      P.Profile.update(() => paid.state);
      P.Menu.showNote('');
      startGame({ ...cfg, buyIn: cfg.tbuy });
      return;
    }
    const stake = P.pickStake(cfg.mode, profile.balance);
    if (!stake) { noMoneyNote(P.stakesFor(cfg.mode)[0]); return; }
    const seat = P.Profile.buyIn(profile, stake);
    if (!seat.ok) { noMoneyNote(stake); return; }
    P.Profile.update(() => seat.state);
    P.Menu.showNote('');
    startGame({ ...cfg, stack: stake });
  }

  function startGame(cfg) {
    if (game) game.stop();
    store.set('poker.setup', { mode: cfg.mode, opponents: cfg.opponents, speed: cfg.speed, format: cfg.format, tbuy: cfg.tbuy });
    setup = cfg;
    const tournament = cfg.format === 'tournament';
    const players = cfg.opponents + 1;
    const profile = P.Profile.get();
    resetTableUi();
    $('#menu').hidden = true;
    $('#table-screen').hidden = false;
    $('#felt-mark').textContent = tournament ? `Турнир · фонд ${fmt(cfg.buyIn * players)}`
      : cfg.format === 'rush' ? 'Rush & Cash' : MODE_MARK[cfg.mode];
    document.body.dataset.mode = cfg.mode;
    game = new P.Game({ ...cfg, nick: profile.nick, avatar: profile.avatar }, {
      onChange: render,
      onNewHand,
      onHumanTurn: (p, L, deadline) => onHumanTurn(L, deadline),
      onHandEnd,
      // Турнирные фишки — не деньги: на баланс их не записываем.
      onHandSettled: (p, chips) => { if (!tournament) P.Profile.update((pr) => P.Profile.setTableChips(pr, chips)); },
      onCashDrop: (amount) => { toast(`Cash Drop! В банке бонус ${fmt(amount)}`); P.Sound.play('chip'); },
      onBankrupt: () => onBankrupt(),
      onSitOut: () => onSitOut(),
      onEliminated: (p, place) => {
        if (!p.human) return;
        onTournamentResult({ place, prize: 0, players, buyIn: cfg.buyIn }, () => finishTournament(place, 0));
      },
      onTournamentEnd: (r) => {
        if (!r.winner || !r.winner.human) return;
        const prize = cfg.buyIn * players;
        P.Profile.update((p) => P.Profile.award(p, prize)); // сразу: приз не пропадёт, даже если закрыть приложение
        onTournamentResult({ place: 1, prize, players, buyIn: cfg.buyIn }, () => finishTournament(1, prize));
      },
      onError,
      onLog,
      sound: P.Sound.play,
    });
    game.start();
  }

  function finishTournament(place, prize) {
    toMenu();
    P.Menu.showNote(place === 1 ? `Победа в турнире! +${fmt(prize)} на балансе.` : `Турнир окончен: ${place}-е место.`);
  }

  // Общий сброс экрана стола — при посадке за новый стол, офлайн или в сети.
  function resetTableUi() {
    [nextTicker, sitOutTicker, bankruptTicker].forEach(clearInterval);
    [bankruptShowTimer, resultTimer, switchTimer].forEach(clearTimeout);
    bankruptPromise = null;
    pendingStake = 0;
    switchTarget = 0;
    tourneyOver = false;
    handOver = false;
    clearPeek();
    closeModal(false);
    toggleDrawer(null);
    hideRebuy();
    $('#banner').hidden = true;
    $('#sitout').hidden = true;
    $('#chip-layer').replaceChildren();
    $('#log-list').innerHTML = '';
    setDockActive(false);
  }

  function onNewHand() {
    seen = new Set();
    handOver = false;
    clearTimeout(switchTimer);
    switchTarget = 0;
    clearPeek();
    // Анимация во вкладке, свёрнутой посреди полёта, может не доиграть — фишки прошлой раздачи убираем.
    $('#chip-layer').replaceChildren();
    clearInterval(nextTicker);
    $('#banner').hidden = true;
  }

  /* ---------- смена стола: свайп двумя пальцами, ▲▼ в шапке, PageUp/PageDown ---------- */

  // Лестница столов для текущей игры; null — менять стол нельзя (сеть, турнир).
  function stakeInfo() {
    if (!game || game.network || game.tournament || !setup) return null;
    const ladder = P.stakesFor(game.mode);
    const i = ladder.indexOf(game.cfg.stack);
    const money = P.Profile.get().balance + (game.me ? game.me.chips : 0);
    return { ladder, i, money, up: ladder[i + 1] || 0, down: i > 0 ? ladder[i - 1] : 0 };
  }

  function renderStakeNav() {
    const s = stakeInfo();
    $('#stake-nav').hidden = !s;
    if (!s) return;
    $('#stake-up').disabled = !s.up || s.up > s.money;
    $('#stake-down').disabled = !s.down || s.down > s.money;
  }

  const stakeLabel = (stake) => { const [sb, bb] = P.blindsFor(stake); return `${fmt(sb)}/${fmt(bb)}`; };

  const SWITCH_COOLDOWN_MS = 900;

  function switchStake(dir) {
    if (!game) return;
    // Двойной тап по ▲ или зажатая клавиша не должны проскакивать несколько столов подряд.
    if (Date.now() - lastSwitchAt < SWITCH_COOLDOWN_MS) return;
    if (game.network) { toast('В сетевой игре стол выбирается в лобби'); return; }
    if (game.tournament) { toast('В турнире стол не меняется'); return; }
    const s = stakeInfo();
    if (!s) return;
    const target = dir > 0 ? s.up : s.down;
    if (!target) { toast(dir > 0 ? 'Это самый дорогой стол' : 'Это самый дешёвый стол'); return; }
    if (target > s.money) { toast(`За стол ${stakeLabel(target)} садятся с ${fmt(target)}, у вас ${fmt(s.money)}`); return; }
    // В раздаче (и пока раздают карты — блайнд уже на столе) пересаживаемся только после неё.
    lastSwitchAt = Date.now();
    const me = game.me;
    if (me && !handOver && game.handNo > 0 && !me.folded && !me.out) {
      pendingStake = target;
      toast(`Пересядете за стол ${stakeLabel(target)} после этой раздачи`);
      render();
      return;
    }
    doSwitch(target);
  }

  // Пересадка: фишки со стола — на баланс, со стола нового уровня садимся со 100 большими блайндами.
  // true — пересели; false — остались за прежним столом.
  function doSwitch(target) {
    if (!game || game.network || !setup) return false;
    const chips = game.me ? game.me.chips : 0;
    if (P.Profile.get().balance + chips < target) { toast('Не хватает денег на этот стол'); return false; }
    P.Profile.update((p) => P.Profile.cashOut(p, chips));
    P.Profile.update((p) => P.Profile.buyIn(p, target).state);
    startGame({ ...setup, stack: target, myChips: 0 }); // за новым уровнем — ровно 100 больших блайндов
    toast(`Новый стол: блайнды ${stakeLabel(target)}, с собой ${fmt(target)}`);
    return true;
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, TOAST_MS);
  }

  // Свайп двумя пальцами: вверх — стол дороже, вниз — дешевле.
  function initSwipe() {
    const area = $('#table-screen');
    const avgY = (touches) => (touches[0].clientY + touches[1].clientY) / 2;
    let gesture = null;
    area.addEventListener('touchstart', (e) => {
      const skip = e.target.closest && e.target.closest('.drawer, input, .modal');
      gesture = e.touches.length === 2 && !skip ? { y0: avgY(e.touches), y: avgY(e.touches), t0: Date.now() } : null;
    }, { passive: true });
    area.addEventListener('touchmove', (e) => {
      if (gesture && e.touches.length === 2) gesture.y = avgY(e.touches);
    }, { passive: true });
    area.addEventListener('touchend', () => {
      if (!gesture) return;
      const dy = gesture.y - gesture.y0;
      const quick = Date.now() - gesture.t0 <= SWIPE_MAX_MS;
      gesture = null; // второй отпущенный палец — уже не жест
      if (quick && Math.abs(dy) >= SWIPE_MIN_PX) switchStake(dy < 0 ? 1 : -1);
    });
    area.addEventListener('touchcancel', () => { gesture = null; });
  }

  // Сетевая игра подключается к тем же экранам: RemoteGame ведёт себя как Game, а сервер вызывает эти функции.
  function attachSession(session, cfg) {
    if (game) game.stop();
    setup = null;
    resetTableUi();
    $('#menu').hidden = true;
    $('#lobby').hidden = true;
    $('#table-screen').hidden = false;
    $('#felt-mark').textContent = MODE_MARK[cfg.mode];
    document.body.dataset.mode = cfg.mode;
    document.body.classList.toggle('online', Boolean(session.network));
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
    // Из турнира уходят без денег: взнос остаётся в призовом фонде, турнирные фишки не деньги.
    if (game && game.tournament) {
      toMenu();
      P.Menu.showNote('Вы покинули турнир — взнос остался в призовом фонде.');
      return;
    }
    const chips = game && game.me ? game.me.chips : 0;
    P.Profile.update((p) => P.Profile.cashOut(p, chips));
    toMenu();
    P.Menu.showNote(LEAVE_NOTES[reason] ? LEAVE_NOTES[reason](chips) : '');
  }

  function toMenu() {
    if (game) game.stop();
    game = null;
    setup = null;
    clearInterval(turnTicker);
    resetTableUi();
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
    // PageUp/PageDown прокручивают открытый журнал — стол меняют, только когда панели закрыты.
    if ((e.code === 'PageUp' || e.code === 'PageDown') && !openDrawer() && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      switchStake(e.code === 'PageUp' ? 1 : -1);
      return;
    }
    if (e.code === 'KeyF' && !limits && !e.repeat && canFastFold()) { act('fold'); return; }
    if (!limits) return;
    if (inNumber) {
      if (e.code === 'Enter') { setRaise(e.target.value); act('raise'); }
      return;
    }
    const step = Math.max(1, game.bb);
    switch (e.code) {
      case 'KeyF': act('fold'); break; // в свой ход; быстрый пас Rush & Cash — выше, до проверки хода
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
    P.Menu.init(); // сначала меню: оно рисует варианты турнирного взноса, которые восстанавливает applySetup
    applySetup(form, Object.assign({}, DEFAULTS, store.get('poker.setup', {})));
    P.Menu.syncBuyIns();
    form.addEventListener('submit', (e) => { e.preventDefault(); trySit(readSetup(form)); });
    initSwipe();
    $('#stake-up').addEventListener('click', () => switchStake(1));
    $('#stake-down').addEventListener('click', () => switchStake(-1));
    $('#board').addEventListener('click', (e) => { if (e.target.closest('[data-peek]')) revealPeek(); });

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
    clearInterval(turnTicker);
    resetTableUi();
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

  P.UI = { attachSession, closeTable, render: () => render(), onHumanTurn, onHandEnd, onNewHand, onLog, onBankrupt, onSitOut, onTournamentResult };

  document.addEventListener('DOMContentLoaded', () => {
    init();
    initMusic();
    $('#btn-chat').addEventListener('click', () => toggleDrawer('chat'));
    if (P.Lobby) P.Lobby.init();
  });
})(window.Poker = window.Poker || {});
