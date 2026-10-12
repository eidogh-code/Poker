// Лобби сетевой игры: список открытых столов, вход по коду, создание стола, комната ожидания, чат.
// Деньги: взнос списывается, только когда сервер подтвердил место; при уходе возвращаем то, что сообщил сервер.
(function (P) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Number(n).toLocaleString('ru-RU');
  const esc = (s) => P.Menu.escapeHTML(s);
  const LIST_REFRESH_MS = 5000;
  const CHAT_KEEP = 100;
  const MODE_NAME = { holdem: 'Холдем', omaha: 'Омаха', joker: 'С джокерами', short: 'Шорт-дек' };
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
  const state = {
    room: null, rooms: [], roomsJson: '', chat: [], unread: 0, pending: null,
    paid: false, resumePay: false, awaitRebuy: false, remote: null, listTimer: 0,
  };

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
    if ($('#table-screen').hidden) note(OFFLINE_NOTE); else P.UI.onLog(OFFLINE_NOTE, 'sys');
    return false;
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
    $('#dlg-create').showModal();
  }

  function onCreateSubmit(e) {
    if (!e.submitter || e.submitter.value !== 'create') return;
    const fd = new FormData($('#create-form'));
    const settings = {
      name: fd.get('name'), visibility: fd.get('visibility'), mode: fd.get('mode'),
      buyIn: Number(fd.get('buyIn')), level: Number(fd.get('level')), blindUp: true, bots: fd.get('bots') === '1',
    };
    if (P.Profile.get().balance < settings.buyIn) {
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

  /* ---------- сообщения сервера ---------- */

  function onRoom(m) {
    const first = !state.room;
    state.room = m.room;
    if (state.remote) state.remote.setRoom(m.room);
    if (first) {
      clearInterval(state.listTimer);
      if (state.pending) payForSeat(m.room);          // вход по нашей просьбе
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
    if (state.awaitRebuy && m.chips > 0) {
      state.awaitRebuy = false;
      const buyIn = state.room ? state.room.buyIn : 0;
      P.Profile.update((p) => ({ ...p, balance: Math.max(0, p.balance - buyIn) }));
    }
    P.Profile.update((p) => P.Profile.setTableChips(p, m.chips));
  }

  // Сервер не знает о нашей комнате (перезапуск или нас выписали без связи): возвращаем последний известный стек.
  function onWelcome(m) {
    if (state.room && m.room !== state.room.code) onLeft('lost', P.Profile.get().table || 0);
  }

  function bindNet() {
    const N = P.Net;
    N.on('status', (s) => { renderStatus(s); if (s === 'online' && !state.room) requestList(); });
    N.on('welcome', onWelcome);
    N.on('rooms', (m) => { state.rooms = m.rooms; renderRooms(); });
    N.on('room', onRoom);
    N.on('state', onState);
    N.on('turn', (m) => { if (state.remote && m.remaining > 0) P.UI.onHumanTurn(m.limits, Date.now() + m.remaining); });
    N.on('handEnd', (m) => {
      if (!state.remote) return;
      const winners = m.summary.winners.map((w) => ({ ...w, human: w.id === N.id }));
      P.UI.onHandEnd({ type: m.summary.type, winners });
    });
    N.on('newHand', () => { if (state.remote) P.UI.onNewHand(); });
    N.on('log', (m) => { if (state.remote) P.UI.onLog(m.text, m.kind); });
    N.on('sound', (m) => { if (state.remote) P.Sound.play(m.kind); });
    N.on('chips', onChips);
    N.on('bankrupt', onBankrupt);
    N.on('sitout', (m) => { if (state.remote) P.UI.onSitOut(m.remaining); });
    N.on('left', (m) => onLeft(m.reason, m.chips));
    N.on('chat', (m) => {
      state.chat.push(m.msg);
      if (state.chat.length > CHAT_KEEP) state.chat.shift();
      if (!chatVisible() && m.msg.from && m.msg.from !== N.id) state.unread++;
      appendChat(m.msg);
    });
    N.on('chatHistory', (m) => { state.chat = m.messages.slice(-CHAT_KEEP); renderChat(); });
    N.on('error', (m) => {
      state.pending = null;
      if ($('#table-screen').hidden) note(m.msg); else P.UI.onLog(m.msg, 'sys');
    });
    N.on('replaced', () => note('Вы зашли в игру с другого устройства — здесь соединение закрыто.'));
  }

  // Ушли из комнаты: возвращаем фишки (только если взнос был списан) и показываем лобби.
  function onLeft(reason, chips) {
    if (!state.room && reason !== 'lost') return; // повторное или запоздалое сообщение
    const wasPaid = state.paid;
    if (wasPaid) P.Profile.update((p) => P.Profile.cashOut(p, chips));
    Object.assign(state, { paid: false, resumePay: false, awaitRebuy: false, room: null, remote: null, chat: [], unread: 0, pending: null });
    renderChat();
    P.UI.closeTable();
    $('#lobby').hidden = false;
    showView('list');
    if (reason === 'switch') return;
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
    $('#create-form').addEventListener('submit', onCreateSubmit);
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
