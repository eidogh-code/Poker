// Отрисовка стола, панель действий, меню, журнал, клавиатура.
(function (P) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Number(n).toLocaleString('ru-RU');
  const plural = (n, forms) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
    return forms[2];
  };
  const MODE_NAME = { holdem: 'Холдем', omaha: 'Омаха', joker: 'Холдем с джокерами' };
  const MODE_MARK = { holdem: 'Холдем', omaha: 'Омаха', joker: 'Джокер' };
  const ODDS_ITERS = { holdem: 700, omaha: 260, joker: 420 };
  const DEFAULTS = { mode: 'holdem', opponents: 5, stack: 1000, level: 1, blindUp: true, speed: 'normal' };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* хранилище недоступно — настройки просто не запомнятся */ } },
  };

  let game = null;
  let limits = null;
  let seen = new Set();
  let oddsOn = store.get('poker.odds', true);
  let oddsTimer = 0;

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

  function seatGeometry(i, n, human) {
    const a = ((90 + (i * 360) / n) * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return {
      x: 50 + 47 * cos,
      y: human ? 100 : 50 + 47 * sin,
      bx: human ? 35 : 50 + 30 * cos,
      by: human ? 82 : 50 + 29 * sin,
      dx: human ? 64 : 50 + 37 * cos + 4 * Math.sign(cos || 1),
      dy: human ? 82 : 50 + 36 * sin,
      upper: sin < -0.3,
    };
  }

  function seatHTML(p, i, n) {
    const g = game;
    const pos = seatGeometry(i, n, p.human);
    const reveal = p.human || (g.showdown && !p.folded);
    const cls = ['seat', p.human ? 'me' : '', pos.upper ? 'upper' : '', g.toAct === i ? 'active' : '',
      p.folded && !p.out ? 'folded' : '', p.out ? 'out' : '', p.winner ? 'winner' : ''].join(' ');
    const cards = p.out ? '' : p.hole.map((c) => cardHTML(c, { hidden: !reveal, fresh: isFresh(c) })).join('');
    const label = g.showdown && p.handName && !p.folded ? `<span class="hand-label">${p.handName}</span>` : '';
    const won = p.winner && p.won ? `<span class="won">+${fmt(p.won)}</span>` : '';
    const tag = p.lastAction && !won ? `<span class="tag">${p.lastAction}</span>` : '';
    let html = `<div class="${cls}" style="left:${pos.x}%;top:${pos.y}%" role="listitem" aria-label="${seatSummary(p, i)}">
      <div class="hole${g.holeN === 4 ? ' four' : ''}">${cards}</div>
      <div class="plate tone-${p.tone}" aria-hidden="true">
        <span class="avatar">${p.human ? '♠' : p.name[0]}</span>
        <span class="who"><span class="pname">${p.name}</span><span class="pchips">${fmt(p.chips)}</span></span>
      </div>
      <span aria-hidden="true">${won}${tag}${label}</span>
    </div>`;
    if (p.bet > 0) html += `<div class="bet" style="left:${pos.bx}%;top:${pos.by}%" aria-hidden="true"><i class="chip"></i>${fmt(p.bet)}</div>`;
    if (i === g.dealer) html += `<div class="dealer" style="left:${pos.dx}%;top:${pos.dy}%" title="Дилер" aria-hidden="true">D</div>`;
    return html;
  }

  // Текст для скринридера: всё, что зрячий игрок видит на месте игрока.
  function seatSummary(p, i) {
    const parts = [p.human ? 'Вы' : p.name, `${fmt(p.chips)} ${plural(p.chips, ['фишка', 'фишки', 'фишек'])}`];
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
    $('#m-blinds').textContent = `${fmt(g.sb)} / ${fmt(g.bb)}`;
    $('#m-hand').textContent = String(g.handNo);
    const left = g.handsLeftAtLevel();
    const level = $('#m-level');
    level.textContent = left === null ? 'без роста'
      : left === 1 ? 'растут после этой раздачи' : `рост через ${left} ${plural(left, ['раздачу', 'раздачи', 'раздач'])}`;
    level.classList.toggle('soon', left !== null && left <= 2);
    renderMine();
    renderTurnNote();
  }

  function renderMine() {
    const me = game.players[0];
    let text = '';
    if (me.out) text = 'Вы выбыли';
    else if (!me.hole.length) text = 'Раздаём карты';
    else if (game.mode === 'omaha' && game.board.length < 3) text = 'Ждём флоп';
    else text = P.Cards.handName(P.Cards.bestScore(game.mode, me.hole, game.board));
    $('#mine-hand').textContent = text;
  }

  function renderTurnNote() {
    const g = game;
    const p = g.players[g.toAct];
    let note = '';
    if (p && !p.human) note = `Ходит ${p.name}`;
    else if (p && p.human) note = 'Ваш ход';
    $('#turn-note').textContent = note;
  }

  /* ---------- панель действий ---------- */

  function setDockActive(on) {
    $('#dock').classList.toggle('my-turn', on);
    ['#a-fold', '#a-call', '#a-raise'].forEach((s) => { $(s).disabled = !on; });
    if (!on) {
      limits = null;
      clearTimeout(oddsTimer);
      $('#mine-odds').textContent = '';
      $('#a-call-t').textContent = 'Чек';
      $('#a-raise-t').textContent = 'Рейз';
      $('#a-range').disabled = true;
      $('#a-amt').disabled = true;
      document.querySelectorAll('.presets button').forEach((b) => { b.disabled = true; });
    }
  }

  function onHumanTurn(L) {
    limits = L;
    const me = game.players[0];
    setDockActive(true);
    P.Sound.play('turn');

    let callText = 'Чек';
    if (L.toCallFull > 0) callText = L.toCallFull >= me.chips ? `Ва-банк ${fmt(me.chips)}` : `Колл ${fmt(L.toCallFull)}`;
    $('#a-call-t').textContent = callText;
    // Пасовать, когда чек бесплатный, — почти всегда случайность.
    $('#a-fold').disabled = L.toCallFull === 0;
    $('#a-fold').title = L.toCallFull === 0 ? 'Чек ничего не стоит — пас не нужен' : '';

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

  function act(type) {
    if (!limits) return;
    if (type === 'fold' && limits.toCallFull === 0) return;
    const action = { type };
    if (type === 'raise') {
      if (!limits.canRaise) return;
      action.to = Number($('#a-range').value);
    }
    if (type === 'call' && limits.toCallFull === 0) action.type = 'check';
    setDockActive(false);
    game.humanAct(action);
  }

  function computeOdds() {
    clearTimeout(oddsTimer);
    const el = $('#mine-odds');
    if (!oddsOn) { el.textContent = ''; return; }
    const me = game.players[0];
    const opps = game.players.filter((p) => p !== me && !p.folded && !p.out).length;
    if (!me.hole.length || !opps) { el.textContent = ''; return; }
    el.textContent = 'Считаем шансы…';
    oddsTimer = setTimeout(() => {
      const eq = P.Cards.equity(game.mode, me.hole, game.board, opps, ODDS_ITERS[game.mode]);
      const who = opps === 1 ? 'одного соперника' : `${opps} соперников`;
      el.textContent = `Шанс выиграть ≈ ${Math.round(eq * 100)}% против ${who}`;
    }, 30);
  }

  /* ---------- конец раздачи и игры ---------- */

  function onHandEnd(summary) {
    setDockActive(false);
    $('#mine-odds').textContent = '';
    const lines = summary.winners.map((w) => {
      const who = w.human ? 'Вы выигрываете' : `${w.name} выигрывает`;
      const hand = summary.type === 'showdown' ? `<span class="b-hand">${w.handName}</span>` : '';
      return `<div class="${w.human ? 'me' : ''}"><b>${who} ${fmt(w.won)}</b>${hand}</div>`;
    }).join('');
    const banner = $('#banner');
    banner.innerHTML = `<div class="lines">${lines}</div>
      <button class="btn btn-raise" id="btn-next" type="button">Следующая раздача <kbd>Пробел</kbd></button>`;
    banner.hidden = false;
    $('#btn-next').addEventListener('click', nextHand);
  }

  function nextHand() {
    $('#banner').hidden = true;
    if (game) game.nextHand();
  }

  /* ---------- диалог ---------- */

  let modalState = null;

  // Один диалог на все случаи: конец игры, ошибка, подтверждение выхода.
  function openModal({ title, text, primary, secondary, dismissable }) {
    modalState = { secondary, dismissable, returnFocus: document.activeElement };
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-primary').textContent = primary.label;
    $('#modal-secondary').textContent = secondary.label;
    $('#modal-primary').onclick = () => { closeModal(false); primary.run(); };
    $('#modal-secondary').onclick = () => { closeModal(false); secondary.run(); };
    $('#modal').hidden = false;
    $('#modal-primary').focus();
  }

  function closeModal(restoreFocus) {
    const state = modalState;
    modalState = null;
    $('#modal').hidden = true;
    if (restoreFocus && state && state.returnFocus && state.returnFocus.focus) state.returnFocus.focus();
  }

  const restart = () => startGame(store.get('poker.setup', DEFAULTS));

  function onGameOver(result) {
    $('#banner').hidden = true;
    const win = result.type === 'win';
    const hands = `${result.hand} ${plural(result.hand, ['раздачу', 'раздачи', 'раздач'])}`;
    openModal({
      title: win ? 'Стол ваш' : 'Фишки закончились',
      text: win ? `Вы обыграли всех соперников за ${hands}.` : `Вы продержались ${hands}. Сядьте заново — стек восстановится.`,
      primary: { label: 'Сыграть снова', run: restart },
      secondary: { label: 'В меню', run: toMenu },
    });
  }

  function onError(err) {
    openModal({
      title: 'Игра остановилась',
      text: `Внутренняя ошибка: ${err && err.message ? err.message : err}. Начните игру заново.`,
      primary: { label: 'Начать заново', run: restart },
      secondary: { label: 'В меню', run: toMenu },
    });
  }

  function confirmLeave() {
    if (!game || game.checkEnd()) { toMenu(); return; }
    openModal({
      title: 'Выйти из-за стола?',
      text: 'Текущая игра закончится, фишки не сохранятся.',
      primary: { label: 'Остаться', run: () => {} },
      secondary: { label: 'Выйти в меню', run: toMenu },
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

  const DRAWERS = { log: '#btn-log', hands: '#btn-hands' };

  function toggleDrawer(id, open) {
    Object.keys(DRAWERS).forEach((key) => {
      const show = key === id ? (open === undefined ? $('#' + key).hidden : open) : false;
      $('#' + key).hidden = !show;
      $(DRAWERS[key]).setAttribute('aria-expanded', String(show));
    });
  }

  function openDrawer() {
    return Object.keys(DRAWERS).find((key) => !$('#' + key).hidden) || null;
  }

  /* ---------- экраны ---------- */

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

  function startGame(cfg) {
    if (game) game.stop();
    store.set('poker.setup', cfg);
    $('#menu').hidden = true;
    $('#table-screen').hidden = false;
    closeModal(false);
    toggleDrawer(null);
    $('#banner').hidden = true;
    $('#log-list').innerHTML = '';
    $('#felt-mark').textContent = MODE_MARK[cfg.mode];
    document.body.dataset.mode = cfg.mode;
    setDockActive(false);
    game = new P.Game(cfg, {
      onChange: render,
      onNewHand: () => { seen = new Set(); $('#banner').hidden = true; },
      onHumanTurn,
      onHandEnd,
      onGameOver,
      onError,
      onLog,
      sound: P.Sound.play,
    });
    game.start();
  }

  function toMenu() {
    if (game) game.stop();
    game = null;
    closeModal(false);
    toggleDrawer(null);
    $('#table-screen').hidden = true;
    $('#menu').hidden = false;
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

  // Мост к окну Windows-приложения (WebView2). В обычном браузере его нет.
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;

  function initHost() {
    if (!host) return;
    document.body.classList.add('app-shell');
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
    if (!game || !$('#modal').hidden || $('#table-screen').hidden) return;
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
    form.addEventListener('submit', (e) => { e.preventDefault(); startGame(readSetup(form)); });

    P.Sound.enabled = store.get('poker.sound', true);
    updateSoundButton();
    updateOddsButton();

    $('#btn-menu').addEventListener('click', confirmLeave);
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
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.Poker = window.Poker || {});
