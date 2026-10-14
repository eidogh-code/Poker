// Лобби сетевой игры: список открытых столов, вход по коду, создание стола, очередь на турнир, комната ожидания, чат.
// Деньги: взнос списывается, только когда сервер подтвердил место; при уходе возвращаем то, что сообщил сервер.
// Турнир: взнос списывается при старте турнира, приз зачисляется один раз (отметки по коду комнаты в хранилище).
(function (P) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Number(n).toLocaleString('ru-RU');
  const esc = (s) => P.Menu.escapeHTML(s);
  const LIST_REFRESH_MS = 5000;
  const CHAT_KEEP = 100;
  const MODE_NAME = { holdem: 'Холдем', omaha: 'Омаха', joker: 'С джокерами', short: 'Шорт-дек', aof: 'AoF Холдем', aofomaha: 'AoF Омаха' };
  const MODES = Object.keys(MODE_NAME);
  const TOURNEY_SEATS = 6;
  const TOURNEY_WAIT_S = 30;          // столько сервер ждёт неполную очередь (от двух игроков)
  const TOURNEY_STORE = 'poker.tourneys';
  const TOURNEY_KEEP = 20;            // последние отметки «взнос списан / зачтено»; старые турниры давно закрыты
  const CODE_RE = /^[A-Z0-9]{6}$/;
  const TICK_MS = 1000;
  const USUAL_BUY_IN = 1000;          // взнос по умолчанию, если он по карману
  const STATUS_TEXT = {
    online: 'В сети', connecting: 'Подключаемся…', reconnecting: 'Связь потеряна, переподключаемся…',
    off: 'Не подключено', error: 'Не удалось подключиться', unconfigured: 'Сервер не настроен',
  };
  const OFFLINE_NOTE = 'Нет связи с сервером. Дождитесь переподключения и попробуйте ещё раз.';
  const LEFT_NOTES = {
    self: (c) => `Вы вышли из-за стола. ${fmt(c)} вернулись на баланс.`,
    afk: (c) => `Вас долго не было — место освободилось. ${fmt(c)} вернулись на баланс.`,
    bankrupt: () => 'Фишки кончились, вы вышли из-за стола.',
    disconnected: (c) => `Связь пропала надолго — место освободилось. ${fmt(c)} вернулись на баланс.`,
    idle: (c) => `Стол долго простаивал и закрылся. ${fmt(c)} вернулись на баланс.`,
    lost: (c) => `Стол на сервере больше не существует (сервер перезапускался). ${fmt(c)} вернулись на баланс.`,
    local: (c) => `Вы вышли без связи с сервером. ${fmt(c)} вернулись на баланс.`,
  };

  // paid — взнос списан с баланса; resumePay — место «досталось» после перезапуска приложения, стек спишем по снимку.
  // queue — что сервер сказал об очереди; queueWanted — куда мы просились (после обрыва связи встаём снова).
  // result — итог турнира, пришедший от сервера (показываем один раз).
  const state = {
    room: null, rooms: [], roomsJson: '', chat: [], unread: 0, pending: null,
    paid: false, resumePay: false, awaitRebuy: false, remote: null, listTimer: 0,
    queue: null, queueWanted: null, queueDeadline: 0, queueTimer: 0, queues: [], result: null, roomBoot: null,
  };
  const isTourney = (room) => Boolean(room && room.format === 'tournament');

  /* ---------- экраны ---------- */

  function open() {
    $('#menu').hidden = true;
    $('#lobby').hidden = false;
    note('');
    $('#server-url').value = P.Net.serverUrl();
    showView(state.room ? 'room' : 'list');
    P.Net.connect();
    renderStatus(P.Net.status);
  }

  function backToMenu() {
    if (state.room) { leaveRoom(); return; }
    clearInterval(state.listTimer);
    setQueue(null);
    state.queueWanted = null;
    P.Net.disconnect();
    $('#lobby').hidden = true;
    $('#menu').hidden = false;
    P.Menu.refresh();
  }

  function showView(view) {
    $('#lobby-main').hidden = view !== 'list';
    $('#room-view').hidden = view !== 'room';
    clearInterval(state.listTimer);
    if (view === 'list') {
      renderTourney();
      requestList();
      state.listTimer = setInterval(requestList, LIST_REFRESH_MS);
    }
  }

  function note(text) {
    $('#lobby-note').textContent = text;
    $('#lobby-note').hidden = !text;
  }

  // Отправка с обратной связью: без соединения игрок видит причину, а не молчащую кнопку.
  function send(msg) {
    if (P.Net.send(msg)) return true;
    say(OFFLINE_NOTE);
    return false;
  }

  // Сообщение игроку там, где он сейчас: в лобби — заметкой, за столом — в журнал.
  function say(text) {
    if ($('#table-screen').hidden) note(text); else P.UI.onLog(text, 'sys');
  }

  function renderStatus(status) {
    const el = $('#net-status');
    el.textContent = STATUS_TEXT[status] || status;
    el.dataset.status = status;
    $('#lobby-server').hidden = !(status === 'unconfigured' || status === 'error' || status === 'reconnecting' || status === 'off');
    if (status === 'unconfigured') $('#server-hint').textContent = 'Укажите адрес сервера игры — его даёт тот, кто развернул сервер (см. README).';
  }

  /* ---------- список столов ---------- */

  function requestList() { if (P.Net.status === 'online') P.Net.send({ t: 'list' }); }

  // Перерисовываем только при изменениях — иначе фокус клавиатуры слетал бы каждые 5 секунд.
  function renderRooms() {
    const json = JSON.stringify(state.rooms);
    if (json === state.roomsJson) return;
    state.roomsJson = json;
    const list = $('#room-list');
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.join : null;
    if (!state.rooms.length) {
      list.innerHTML = '<li class="room-empty">Открытых столов пока нет. Создайте свой — и позовите друзей по коду.</li>';
      return;
    }
    list.innerHTML = state.rooms.map((r) => `
      <li class="room-row">
        <div class="room-row-main">
          <b>${esc(r.name)}</b>
          <span>${MODE_NAME[r.mode] || ''} · блайнды ${fmt(r.blinds[0])}/${fmt(r.blinds[1])} · взнос ${fmt(r.buyIn)}${r.bots ? ' · с ботами' : ''}</span>
        </div>
        <span class="room-seats">${r.humans}/${r.seats}${r.started ? ' · идёт игра' : ''}</span>
        <button class="btn btn-call" type="button" data-join="${esc(r.code)}" ${r.humans >= r.seats ? 'disabled' : ''}>Сесть</button>
      </li>`).join('');
    if (focused) {
      const again = list.querySelector(`[data-join="${CSS.escape(focused)}"]`);
      if (again) again.focus();
    }
  }

  /* ---------- вход и создание ---------- */

  function join(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(clean)) { note('Код комнаты — 6 букв и цифр, например K7QX2M.'); return; }
    note('');
    if (send({ t: 'join', code: clean })) state.pending = { kind: 'join' };
  }

  function openCreate() {
    $('#create-hint').textContent = '';
    $('#cr-name').value = `Стол ${P.Profile.get().nick}`;
    renderCreateBuyIns();
    $('#dlg-create').showModal();
  }

  // Радиокнопки сегмента: items — [значение, подпись]; дороже баланса и т. п. — disabled(value).
  function fillSeg(box, name, items, pick, disabled) {
    box.replaceChildren(...items.map(([value, text]) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      Object.assign(input, { type: 'radio', name, value: String(value), checked: value === pick, disabled: disabled(value) });
      const span = document.createElement('span');
      span.textContent = text;
      label.append(input, span);
      return label;
    }));
  }

  // Взносы — лестница движка для выбранной игры; блайнды — сотая часть взноса. Дороже баланса — недоступны.
  function renderCreateBuyIns() {
    const fd = new FormData($('#create-form'));
    const mode = fd.get('mode') || 'holdem';
    const balance = P.Profile.get().balance;
    const prev = Number(fd.get('buyIn'));
    const stakes = P.stakesFor(mode);
    const usual = stakes.includes(USUAL_BUY_IN) && USUAL_BUY_IN <= balance ? USUAL_BUY_IN : P.pickStake(mode, balance);
    const pick = stakes.includes(prev) && prev <= balance ? prev : (usual || stakes[0]);
    const items = stakes.map((v) => {
      const [sb, bb] = P.blindsFor(v);
      return [v, `${fmt(v)} · ${fmt(sb)}/${fmt(bb)}`];
    });
    fillSeg($('#cr-buyins'), 'buyIn', items, pick, (v) => v > balance);
  }

  function onCreateSubmit(e) {
    if (!e.submitter || e.submitter.value !== 'create') return;
    const fd = new FormData($('#create-form'));
    const settings = {
      name: fd.get('name'), visibility: fd.get('visibility'), mode: fd.get('mode'),
      buyIn: Number(fd.get('buyIn')), bots: fd.get('bots') === '1',
    };
    if (!settings.buyIn || P.Profile.get().balance < settings.buyIn) {
      e.preventDefault();
      $('#create-hint').textContent = 'На такой взнос не хватает фишек на балансе. Выберите меньше или заберите бонус.';
      return;
    }
    if (P.Net.status !== 'online') {
      e.preventDefault();
      $('#create-hint').textContent = OFFLINE_NOTE;
      return;
    }
    if (send({ t: 'create', settings })) state.pending = { kind: 'create' };
  }

  // Новое место за столом (вход по нашей просьбе): списываем взнос. Не хватает — сразу выходим.
  function payForSeat(room) {
    if (state.paid) return;
    const seat = P.Profile.buyIn(P.Profile.get(), room.buyIn);
    if (!seat.ok) {
      note(`Взнос за этот стол — ${fmt(room.buyIn)}, на балансе меньше. Заберите бонус или выберите другой стол.`);
      P.Net.send({ t: 'leave' });
      return;
    }
    P.Profile.update(() => seat.state);
    state.paid = true;
  }

  // Место «вернулось» после перезапуска: стол при запуске уже вернул фишки на баланс — забираем фактический стек обратно.
  function payForResumedSeat(chips) {
    const take = Math.max(0, Math.min(chips, P.Profile.get().balance));
    P.Profile.update((p) => P.Profile.setTableChips({ ...p, balance: p.balance - take }, chips));
    state.paid = true;
    state.resumePay = false;
  }

  // Выйти можно и без связи: возвращаем последний известный стек, а запоздалый ответ сервера уже не учитываем.
  function leaveRoom() {
    if (P.Net.send({ t: 'leave' })) return;
    onLeft('local', P.Profile.get().table || 0);
  }

  /* ---------- турнир: очередь ---------- */

  const checkedValue = (name) => {
    const input = document.querySelector(`input[name="${name}"]:checked`);
    return input ? input.value : null;
  };

  function tourneyChoice() {
    const mode = checkedValue('tqmode');
    return { mode: MODE_NAME[mode] ? mode : 'holdem', buyIn: Number(checkedValue('tqbuy')) || 0 };
  }

  // Выбор игры и взноса; взносы дороже баланса недоступны. Прежний выбор сохраняем, если он ещё по карману.
  function renderTourney() {
    const balance = P.Profile.get().balance;
    const prev = tourneyChoice();
    const buyIns = P.TOURNEY.buyIns;
    const affordable = buyIns.filter((v) => v <= balance);
    const usual = affordable.includes(USUAL_BUY_IN) ? USUAL_BUY_IN : affordable[affordable.length - 1];
    const buyIn = affordable.includes(prev.buyIn) ? prev.buyIn : (usual || 0);
    fillSeg($('#tq-modes'), 'tqmode', MODES.map((m) => [m, MODE_NAME[m]]), prev.mode, () => false);
    fillSeg($('#tq-buyins'), 'tqbuy', buyIns.map((v) => [v, fmt(v)]), buyIn, (v) => v > balance);
    $('#tq-rules').textContent = `Sit & Go на ${TOURNEY_SEATS} мест: у всех по ${fmt(P.TOURNEY.stack)} фишек, `
      + `блайнды растут каждые ${P.TOURNEY.handsPerLevel} раздач. Все взносы забирает победитель. `
      + `Старт — когда соберутся шестеро или через ${TOURNEY_WAIT_S} секунд, если в очереди хотя бы двое.`;
    renderQueue();
  }

  function renderQueue() {
    const q = state.queue;
    $('#tq-setup').hidden = Boolean(q);
    $('#tq-status').hidden = !q;
    if (q) {
      $('#tq-count').textContent = `В очереди: ${q.count} из ${q.max}`;
      const left = state.queueDeadline ? Math.max(0, Math.ceil((state.queueDeadline - Date.now()) / 1000)) : null;
      const when = left === null
        ? `Ждём второго игрока — дальше старт через ${TOURNEY_WAIT_S} секунд.`
        : `Старт через ${left} с, если раньше не соберутся все шестеро.`;
      $('#tq-when').textContent = ` · ${MODE_NAME[q.mode]}, взнос ${fmt(q.buyIn)}. ${when}`;
      return;
    }
    const { mode, buyIn } = tourneyChoice();
    const waiting = state.queues.find((x) => x.mode === mode && x.buyIn === buyIn);
    $('#tq-hint').textContent = buyIn
      ? `Призовой фонд — взнос × число игроков, до ${fmt(buyIn * TOURNEY_SEATS)}.${waiting ? ` Сейчас в этой очереди: ${waiting.count}.` : ''}`
      : 'Самый дешёвый турнир дороже баланса. Заберите ежедневный бонус.';
    $('#tq-join').disabled = !buyIn;
  }

  // Сервер сообщает очередь целиком; отсчёт до старта ведём сами по его «осталось».
  function setQueue(q) {
    state.queue = q;
    clearInterval(state.queueTimer);
    state.queueDeadline = q && Number.isFinite(q.startsIn) ? Date.now() + q.startsIn : 0;
    if (state.queueDeadline) state.queueTimer = setInterval(renderQueue, TICK_MS);
    renderQueue();
  }

  function joinQueue() {
    const { mode, buyIn } = tourneyChoice();
    if (!buyIn || P.Profile.get().balance < buyIn) { note('На такой взнос не хватает фишек на балансе.'); return; }
    note('');
    if (send({ t: 'queue', mode, buyIn })) state.queueWanted = { mode, buyIn };
  }

  function leaveQueue() {
    state.queueWanted = null;
    P.Net.send({ t: 'unqueue' });
    setQueue(null);
  }

  /* ---------- турнир: деньги ---------- */

  // Отметки турниров по ключу «метка запуска сервера:код» — после перезапуска сервера коды комнат могут повториться.
  // paid/buyIn — взнос списан; done — по турниру всё зачтено (приз, возврат или итог без приза); won — зачтённый приз.
  // Отметка «зачтено» пишется ДО зачисления: не сохранилась — не зачисляем (иначе после перезапуска зачли бы снова).
  const BOOT_RE = /^[0-9a-f]{1,32}$/;
  const MARK_RE = /^(?:[0-9a-f]{1,32}|-):[A-Z0-9]{6}$/;
  const markKey = (boot, code) => `${BOOT_RE.test(boot || '') ? boot : '-'}:${code}`;
  const whole = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
  let marks = null;

  function tourneyMarks() {
    if (marks) return marks;
    marks = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(TOURNEY_STORE) || '[]');
      if (Array.isArray(raw)) {
        raw.forEach((x) => {
          if (x && typeof x.key === 'string' && MARK_RE.test(x.key)) {
            marks.set(x.key, { paid: x.paid === true, buyIn: whole(x.buyIn), done: x.done === true, won: whole(x.won) });
          }
        });
      }
    } catch (e) { /* хранилище недоступно или повреждено — отметки живут до закрытия */ }
    return marks;
  }

  const markOf = (key) => tourneyMarks().get(key) || null;

  // true — отметка сохранена в хранилище, а не только в памяти.
  function markTourney(key, patch) {
    const all = tourneyMarks();
    const next = { paid: false, buyIn: 0, done: false, won: 0, ...all.get(key), ...patch };
    all.delete(key);
    all.set(key, next);
    while (all.size > TOURNEY_KEEP) all.delete(all.keys().next().value);
    try {
      localStorage.setItem(TOURNEY_STORE, JSON.stringify([...all].map(([k, v]) => ({ key: k, ...v }))));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Турнир начался с нами: взнос списываем один раз. Не хватает — сдаём турнир (сервер считает это уходом).
  // Турнирные фишки на баланс и в «фишки на столе» не попадают: это не деньги.
  function payForTourney(room) {
    state.roomBoot = P.Net.boot;
    const key = markKey(state.roomBoot, room.code);
    const mark = markOf(key);
    if (mark && mark.paid) return;
    const entry = P.Profile.payEntry(P.Profile.get(), room.buyIn);
    if (!entry.ok) { P.Net.send({ t: 'leave' }); return; }
    markTourney(key, { paid: true, buyIn: room.buyIn });
    P.Profile.update(() => entry.state);
  }

  // Закрыть турнир для денег — один раз. amount (приз или возврат) зачисляется, только если взнос был списан,
  // сумма не больше всего призового фонда (взнос × 6) и отметка «зачтено» сохранилась. Возвращает зачисленное.
  function settleTourney(key, amount, isPrize) {
    const mark = markOf(key);
    if (!mark || !mark.paid || mark.done) return 0;
    const pay = amount > 0 && amount <= mark.buyIn * TOURNEY_SEATS ? amount : 0;
    const saved = markTourney(key, { done: true, won: isPrize ? pay : 0 });
    if (!pay) return 0;
    if (!saved) {
      markTourney(key, { won: 0 });
      say('Не удалось сохранить итог турнира на устройстве — фишки не зачислены. Освободите место в хранилище браузера.');
      return 0;
    }
    P.Profile.update((p) => P.Profile.award(p, pay));
    return pay;
  }

  // Возврат взноса (турнир распущен сервером или сервер перезапускался) — тоже через отметку, один раз.
  function refundTourney(key) {
    const mark = markOf(key);
    return mark ? settleTourney(key, mark.buyIn, false) : 0;
  }

  const resultText = (r) => `Турнир окончен: ${r.place}-е место из ${r.players}.`
    + (r.prize ? ` Приз ${fmt(r.prize)} зачислен на баланс.` : '');

  // Итог турнира: приз зачисляем один раз, окно итога показываем один раз; по закрытию — выходим в лобби.
  // После переподключения сервер присылает итог снова — показываем уже зачтённый приз из отметки.
  function onTourneyResult(m) {
    if (!CODE_RE.test(m.code) || !Number.isInteger(m.place) || m.place < 1) return;
    const key = markKey(typeof m.boot === 'string' ? m.boot : P.Net.boot, m.code);
    settleTourney(key, whole(m.prize), true);
    if (state.result && state.result.code === m.code) return;
    const mark = markOf(key);
    const result = { place: m.place, prize: mark ? mark.won : 0, players: whole(m.players), buyIn: whole(m.buyIn) };
    state.result = { code: m.code, ...result };
    const here = state.room && state.room.code === m.code;
    if (here && state.remote && P.UI.onTournamentResult) {
      P.UI.onTournamentResult(result, () => { if (state.room && state.room.code === m.code) leaveRoom(); });
    } else if (here) {
      leaveRoom();
    } else {
      note(resultText(result));
    }
  }

  function tourneyLeftNote(reason, key, room, result, refunded) {
    if (result) return resultText(result);
    if (refunded) {
      return reason === 'aborted'
        ? `Турнир прервался из-за сбоя на сервере. Взнос ${fmt(refunded)} вернулся на баланс.`
        : `Турнир пропал с сервера (сервер перезапускался). Взнос ${fmt(refunded)} вернулся на баланс.`;
    }
    const mark = markOf(key);
    if (!mark || !mark.paid) return `На взнос за турнир (${fmt(room.buyIn)}) не хватило фишек — турнир прошёл без вас.`;
    if (reason === 'self' || reason === 'local') return 'Вы покинули турнир. Взнос не возвращается.';
    if (reason === 'lost' || reason === 'aborted') return 'Турнир прервался.';
    return 'Турнир закончился.';
  }

  // Карты «что пришло бы на стол» показываем, только если это действительно карты: не больше пяти,
  // ранг 2–14 и масть 0–3 (или джокер). Иначе — ничего: данные сервера тоже не принимаем на веру.
  const isCard = (c) => Boolean(c) && typeof c.id === 'string' && c.id.length <= 8
    && (c.j === true || (Number.isInteger(c.r) && c.r >= 2 && c.r <= 14 && Number.isInteger(c.s) && c.s >= 0 && c.s <= 3));
  const restCards = (rest) => (Array.isArray(rest) && rest.length <= 5 && rest.every(isCard)
    ? rest.map((c) => (c.j === true ? { j: true, id: c.id } : { r: c.r, s: c.s, id: c.id }))
    : []);

  /* ---------- комната ---------- */

  function renderRoom() {
    const r = state.room;
    if (!r) return;
    $('#room-name').textContent = r.name;
    $('#room-vis').textContent = r.visibility === 'closed' ? 'Закрытый — только по коду' : 'Открытый — виден в лобби';
    $('#room-code').textContent = r.code;
    $('#room-meta').textContent = `${MODE_NAME[r.mode]} · блайнды ${fmt(r.blinds[0])}/${fmt(r.blinds[1])} · взнос ${fmt(r.buyIn)}${r.bots ? ' · боты на свободных местах' : ''}`;
    $('#member-list').innerHTML = r.members.map((m) => `
      <li class="member${m.connected ? '' : ' offline'}">
        ${P.Menu.avatarMarkup(P.Profile.normalize({ avatar: m.avatar }).avatar)}
        <span class="member-nick">${esc(m.nick)}${m.id === P.Net.id ? ' (вы)' : ''}</span>
        ${m.id === r.hostId ? '<span class="member-tag">создатель</span>' : ''}
        ${m.connected ? '' : '<span class="member-tag">нет связи</span>'}
      </li>`).join('');
    const isHost = r.hostId === P.Net.id;
    const canStart = isHost && (r.members.length >= 2 || r.bots);
    $('#btn-start').hidden = !isHost;
    $('#btn-start').disabled = !canStart;
    $('#room-hint').textContent = isHost
      ? (canStart ? 'Можно начинать. Новые игроки смогут подсесть и во время игры.' : 'Дождитесь второго игрока — отправьте ему код комнаты.')
      : 'Ждём, когда создатель начнёт игру.';
  }

  async function copyCode() {
    const code = state.room && state.room.code;
    if (!code) return;
    const btn = $('#copy-code');
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = 'Скопировано';
    } catch (e) {
      btn.textContent = 'Выделите код';
    }
    setTimeout(() => { btn.textContent = 'Скопировать'; }, 2000);
  }

  /* ---------- чат ---------- */

  function chatNode(m) {
    const li = document.createElement('li');
    if (!m.from) {
      li.className = 'chat-sys';
      li.textContent = m.text;
      return li;
    }
    li.className = `chat-msg${m.from === P.Net.id ? ' mine' : ''}`;
    const nick = document.createElement('span');
    nick.className = 'chat-nick';
    nick.textContent = m.nick;
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = m.text;
    const time = document.createElement('time');
    time.textContent = new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    li.append(nick, text, time);
    return li;
  }

  const CHAT_LISTS = ['#room-chat-list', '#table-chat-list'];

  // Полная перерисовка — только для истории; новые сообщения добавляются по одному (скринридер читает лишь новое).
  function renderChat() {
    CHAT_LISTS.forEach((sel) => {
      const list = $(sel);
      list.replaceChildren(...state.chat.map(chatNode));
      list.scrollTop = list.scrollHeight;
    });
    renderBadge();
  }

  function appendChat(m) {
    CHAT_LISTS.forEach((sel) => {
      const list = $(sel);
      list.appendChild(chatNode(m));
      while (list.children.length > CHAT_KEEP) list.removeChild(list.firstChild);
      list.scrollTop = list.scrollHeight;
    });
    renderBadge();
  }

  function renderBadge() {
    const badge = $('#chat-badge');
    badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    badge.hidden = !state.unread;
  }

  function chatVisible() {
    const atTable = !$('#table-screen').hidden;
    return atTable ? !$('#chat').hidden : !$('#room-view').hidden;
  }

  function onChatSubmit(e) {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    if (send({ t: 'chat', text })) input.value = '';
  }

  /* ---------- рейтинг ---------- */

  const RATING_GAP_MS = 1100; // сервер отвечает на запрос рейтинга не чаще раза в секунду
  let lastRatingAt = 0;
  let ratingTimer = 0;
  const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));
  const winRate = (r) => (r.hands ? `${Math.round((r.wins / r.hands) * 100)}%` : '—');
  const handsWord = (n) => {
    const d = n % 10;
    const dd = n % 100;
    if (d === 1 && dd !== 11) return 'раздача';
    if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'раздачи';
    return 'раздач';
  };

  function openRating() {
    $('#dlg-rating').showModal();
    requestRating();
  }

  function requestRating() {
    const status = $('#rating-status');
    if (P.Net.status !== 'online') { status.textContent = OFFLINE_NOTE; return; }
    const btn = $('#rating-refresh');
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, RATING_GAP_MS);
    status.textContent = 'Загружаем…';
    // Слишком частый запрос сервер молча пропускает — отправляем, когда окно в секунду истечёт.
    const wait = Math.max(0, lastRatingAt + RATING_GAP_MS - Date.now());
    clearTimeout(ratingTimer);
    ratingTimer = setTimeout(() => {
      lastRatingAt = Date.now();
      P.Net.send({ t: 'rating' });
    }, wait);
  }

  function ratingRow(r) {
    const tr = document.createElement('tr');
    if (r.me) tr.className = 'mine';
    const cell = (tag, text, cls) => {
      const el = document.createElement(tag);
      el.textContent = text;
      if (cls) el.className = cls;
      if (tag === 'th') el.scope = 'row';
      tr.appendChild(el);
    };
    cell('td', r.place, 'place');
    cell('th', r.nick, 'nick');
    cell('td', signed(r.profit), r.profit >= 0 ? 'plus' : 'minus');
    cell('td', fmt(r.hands));
    cell('td', winRate(r));
    return tr;
  }

  function renderRating(m) {
    $('#rating-rows').replaceChildren(...m.top.map(ratingRow));
    $('#rating-table').hidden = !m.top.length;
    $('#rating-status').textContent = m.top.length
      ? `Игроков в рейтинге: ${fmt(m.total)}`
      : 'В рейтинге пока никого — сыграйте с друзьями по сети.';
    const me = $('#rating-me');
    me.hidden = false;
    if (!m.me) {
      me.textContent = `Вы ещё не играли по сети с живыми соперниками. В рейтинг попадают после ${m.minHands} ${handsWord(m.minHands)}.`;
    } else if (m.me.place) {
      me.textContent = `Ваше место — ${m.me.place}. Выигрыш ${signed(m.me.profit)} за ${fmt(m.me.hands)} ${handsWord(m.me.hands)}.`;
    } else {
      me.textContent = `Ваш выигрыш ${signed(m.me.profit)}. До рейтинга осталось ${m.me.needHands} ${handsWord(m.me.needHands)}.`;
    }
  }

  /* ---------- сообщения сервера ---------- */

  function onRoom(m) {
    const first = !state.room;
    state.room = m.room;
    if (state.remote) state.remote.setRoom(m.room);
    if (first) {
      clearInterval(state.listTimer);
      if (isTourney(m.room)) {                         // турнир стартовал (или мы вернулись в идущий)
        state.queueWanted = null;
        setQueue(null);
        payForTourney(m.room);
      } else if (state.pending) payForSeat(m.room);   // вход по нашей просьбе
      else if (!m.room.started) payForSeat(m.room);   // переподключение к ожиданию: сервер вернёт взнос при уходе
      else state.resumePay = true;                    // переподключение к игре: спишем фактический стек из снимка
      state.pending = null;
    }
    if (!m.room.started && $('#table-screen').hidden) { showView('room'); renderRoom(); }
  }

  function onState(m) {
    if (!state.room) return;
    if (!state.remote) {
      state.remote = new P.Net.RemoteGame(state.room);
      state.remote.apply(m.s);
      P.UI.attachSession(state.remote, { mode: state.room.mode });
      $('#lobby').hidden = true;
    } else {
      state.remote.apply(m.s);
    }
    if (state.resumePay && state.remote.me) payForResumedSeat(state.remote.me.chips);
    P.UI.render();
  }

  // Пополнение: деньги списываются, когда сервер подтвердил новый стек (сообщение chips после банкротства).
  function onBankrupt(m) {
    if (!state.remote) return;
    P.UI.onBankrupt(m.remaining).then((amount) => {
      if (amount > 0 && send({ t: 'rebuy', accept: true })) state.awaitRebuy = true;
      else P.Net.send({ t: 'rebuy', accept: false });
    });
  }

  function onChips(m) {
    if (isTourney(state.room)) return; // турнирные фишки — не деньги: «фишки на столе» в профиле остаются нулём
    if (state.awaitRebuy && m.chips > 0) {
      state.awaitRebuy = false;
      const buyIn = state.room ? state.room.buyIn : 0;
      P.Profile.update((p) => ({ ...p, balance: Math.max(0, p.balance - buyIn) }));
    }
    P.Profile.update((p) => P.Profile.setTableChips(p, m.chips));
  }

  // Сервер не знает о нашей комнате (перезапуск или нас выписали без связи): возвращаем последний известный стек.
  // Из очереди сервер выписывает при обрыве связи — встаём в неё снова.
  function onWelcome(m) {
    if (state.room && m.room !== state.room.code) onLeft('lost', P.Profile.get().table || 0);
    else if (!state.room && !m.room && state.queueWanted) P.Net.send({ t: 'queue', ...state.queueWanted });
  }

  function bindNet() {
    const N = P.Net;
    N.on('status', (s) => {
      renderStatus(s);
      if (s === 'online' && !state.room) requestList();
      if (s === 'online' && $('#dlg-rating').open) requestRating();
    });
    N.on('welcome', onWelcome);
    N.on('rooms', (m) => {
      state.rooms = m.rooms;
      state.queues = Array.isArray(m.queues) ? m.queues : [];
      renderRooms();
      renderQueue();
    });
    N.on('queue', (m) => {
      const q = m.queue && MODE_NAME[m.queue.mode] ? m.queue : null;
      if (!q) state.queueWanted = null;
      setQueue(q);
    });
    N.on('tourneyResult', onTourneyResult);
    N.on('rating', renderRating);
    N.on('room', onRoom);
    N.on('state', onState);
    N.on('turn', (m) => { if (state.remote && m.remaining > 0) P.UI.onHumanTurn(m.limits, Date.now() + m.remaining); });
    N.on('handEnd', (m) => {
      if (!state.remote) return;
      const winners = m.summary.winners.map((w) => ({ ...w, human: w.id === N.id }));
      const rest = restCards(m.summary.rest); // все спасовали — несыгранные карты стола
      P.UI.onHandEnd({ type: m.summary.type, winners, rest });
    });
    N.on('newHand', () => { if (state.remote) P.UI.onNewHand(); });
    N.on('log', (m) => { if (state.remote) P.UI.onLog(m.text, m.kind); });
    N.on('sound', (m) => { if (state.remote) P.Sound.play(m.kind); });
    N.on('chips', onChips);
    N.on('bankrupt', onBankrupt);
    N.on('sitout', (m) => { if (state.remote) P.UI.onSitOut(m.remaining); });
    N.on('left', (m) => {
      // Турнир распущен, пока приложение было закрыто: комнаты в памяти нет — возвращаем взнос по отметке.
      if (!state.room && m.reason === 'aborted' && typeof m.code === 'string' && CODE_RE.test(m.code)) {
        const back = refundTourney(markKey(m.boot, m.code));
        if (back) note(`Турнир прервался из-за сбоя на сервере. Взнос ${fmt(back)} вернулся на баланс.`);
      }
      onLeft(m.reason, m.chips);
    });
    N.on('chat', (m) => {
      state.chat.push(m.msg);
      if (state.chat.length > CHAT_KEEP) state.chat.shift();
      if (!chatVisible() && m.msg.from && m.msg.from !== N.id) state.unread++;
      appendChat(m.msg);
    });
    N.on('chatHistory', (m) => { state.chat = m.messages.slice(-CHAT_KEEP); renderChat(); });
    N.on('error', (m) => {
      state.pending = null;
      say(m.msg);
    });
    N.on('replaced', () => note('Вы зашли в игру с другого устройства — здесь соединение закрыто.'));
  }

  // Ушли из комнаты: возвращаем фишки (только если взнос был списан) и показываем лобби.
  // Турнир: фишки не возвращаются (это не деньги). Взнос возвращается, только если турнир распущен из-за сбоя
  // или сервер перезапускался (сменилась метка запуска). «Пропал» при той же метке — нас выписали, возврата нет.
  function onLeft(reason, chips) {
    if (!state.room && reason !== 'lost') return; // повторное или запоздалое сообщение
    const wasPaid = state.paid;
    const tourney = isTourney(state.room) ? state.room : null;
    const key = tourney ? markKey(state.roomBoot, tourney.code) : null;
    const result = state.result;
    if (wasPaid) P.Profile.update((p) => P.Profile.cashOut(p, chips));
    const restarted = reason === 'lost' && Boolean(state.roomBoot) && Boolean(P.Net.boot) && P.Net.boot !== state.roomBoot;
    const refunded = tourney && (reason === 'aborted' || restarted) ? refundTourney(key) : 0;
    Object.assign(state, {
      paid: false, resumePay: false, awaitRebuy: false, room: null, remote: null, chat: [], unread: 0, pending: null,
      result: null, roomBoot: null,
    });
    renderChat();
    P.UI.closeTable();
    $('#lobby').hidden = false;
    showView('list');
    if (reason === 'switch') return;
    if (tourney) { note(tourneyLeftNote(reason, key, tourney, result, refunded)); return; }
    note(wasPaid && LEFT_NOTES[reason] ? LEFT_NOTES[reason](chips) : (reason === 'bankrupt' ? LEFT_NOTES.bankrupt() : ''));
  }

  // Кнопка «Назад» в Android: из комнаты — выйти, из лобби — в меню.
  function onBack() {
    if ($('#lobby').hidden) return false;
    backToMenu();
    return true;
  }

  function init() {
    bindNet();
    $('#btn-online').addEventListener('click', open);
    $('#lobby-back').addEventListener('click', backToMenu);
    $('#server-save').addEventListener('click', () => {
      const url = P.Net.normalizeUrl($('#server-url').value);
      if (!url) { $('#server-hint').textContent = 'Похоже, это не адрес. Пример: poker-server.onrender.com'; return; }
      P.Net.setServerUrl(url);
      P.Net.disconnect();
      P.Net.connect();
    });
    $('#btn-create').addEventListener('click', openCreate);
    $('#btn-rating').addEventListener('click', openRating);
    $('#rating-refresh').addEventListener('click', requestRating);
    $('#create-form').addEventListener('submit', onCreateSubmit);
    $('#create-form').addEventListener('change', (e) => { if (e.target.name === 'mode') renderCreateBuyIns(); });
    $('#tq-setup').addEventListener('change', renderQueue);
    $('#tq-join').addEventListener('click', joinQueue);
    $('#tq-leave').addEventListener('click', leaveQueue);
    // Баланс изменился (бонус, итог стола) — взносы дороже баланса гаснут, доступные загораются.
    P.Profile.subscribe(() => { if (!$('#lobby').hidden && !state.room) renderTourney(); });
    $('#join-form').addEventListener('submit', (e) => { e.preventDefault(); join($('#join-code').value); });
    $('#room-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-join]');
      if (btn) join(btn.dataset.join);
    });
    $('#btn-start').addEventListener('click', () => send({ t: 'start' }));
    $('#btn-leave-room').addEventListener('click', leaveRoom);
    $('#copy-code').addEventListener('click', copyCode);
    document.querySelectorAll('[data-chat-form]').forEach((f) => f.addEventListener('submit', onChatSubmit));
  }

  P.Lobby = {
    init, open, onBack, renderChat,
    markChatRead() { state.unread = 0; renderBadge(); },
    get inRoom() { return Boolean(state.room); },
  };
})(window.Poker = window.Poker || {});
