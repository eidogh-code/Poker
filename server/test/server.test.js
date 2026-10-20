// Сквозные тесты сервера: настоящие WebSocket-клиенты против локального сервера. Запуск: npm test
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connectClient, autoPlay, roomMsg } = require('./helpers');
const WebSocket = require('ws');
const { ipOf } = require('../src/index');
const { Lobby } = require('../src/rooms');

let srv;
let port;

before(async () => {
  ({ srv, port } = await startServer({ autoNextMs: 500 }));
});

after(() => srv.close());

const client = (nick, key) => connectClient(port, nick, key);

test('открытая комната видна в лобби, закрытая — нет', async () => {
  const a = await client('Аня');
  a.send({ t: 'create', settings: { name: 'Открытый', visibility: 'open', mode: 'holdem', buyIn: 1000 } });
  const open = (await a.next(roomMsg)).room;
  const b = await client('Боря');
  b.send({ t: 'create', settings: { name: 'Секрет', visibility: 'closed' } });
  const closed = (await b.next(roomMsg)).room;

  const c = await client('Вика');
  c.send({ t: 'list' });
  const { rooms } = await c.next((m) => m.t === 'rooms');
  assert.ok(rooms.some((r) => r.code === open.code), 'открытая в списке');
  assert.ok(!rooms.some((r) => r.code === closed.code), 'закрытой в списке нет');
  assert.match(closed.code, /^[A-Z0-9]{6}$/);
  [a, b, c].forEach((x) => x.close());
});

test('вход по коду, ошибка на неверный код, чат с очисткой текста', async () => {
  const host = await client('Хозяин');
  host.send({ t: 'create', settings: { visibility: 'closed' } });
  const { code } = (await host.next(roomMsg)).room;

  const guest = await client('Гость');
  guest.send({ t: 'join', code: 'ZZZZZZ' });
  assert.match((await guest.next((m) => m.t === 'error')).msg, /нет/);

  guest.send({ t: 'join', code: code.toLowerCase() });
  const room = (await guest.next((m) => roomMsg(m) && m.room.members.length === 2)).room;
  assert.equal(room.code, code);

  guest.send({ t: 'chat', text: `  Привет\u0000,‮   стол!  ${'x'.repeat(300)}` });
  const { msg } = await host.next((m) => m.t === 'chat' && m.msg.from === guest.id);
  assert.ok(msg.text.startsWith('Привет, стол!'), 'управляющие символы и лишние пробелы убраны');
  assert.equal(Array.from(msg.text).length, 200, 'длина ограничена');
  assert.equal(msg.nick, 'Гость');
  host.close(); guest.close();
});

test('раздача на двоих: свои карты видны, чужие скрыты, фишки сходятся', async () => {
  const a = await client('Алиса');
  a.send({ t: 'create', settings: { visibility: 'closed', buyIn: 500 } });
  const { code } = (await a.next(roomMsg)).room;
  const b = await client('Борис');
  b.send({ t: 'join', code });
  await a.next((m) => roomMsg(m) && m.room.members.length === 2);

  b.send({ t: 'start' });
  assert.match((await b.next((m) => m.t === 'error')).msg, /создатель/);
  a.send({ t: 'start' });

  // Каждый на свой ход коллирует или чекает — до конца раздачи.
  const callOrCheck = (L) => ({ type: L.toCallFull > 0 ? 'call' : 'check' });
  const stopA = autoPlay(a, callOrCheck);
  const stopB = autoPlay(b, callOrCheck);

  const dealt = await a.next((m) => m.t === 'state' && m.s.players.every((p) => p.hole.length === 2));
  const mine = dealt.s.players.find((p) => p.id === a.id);
  const theirs = dealt.s.players.find((p) => p.id === b.id);
  assert.ok(mine.hole.every((c) => c && c.r), 'свои карты видны');
  assert.ok(theirs.hole.every((c) => c === null), 'чужие карты скрыты');

  const end = await a.next((m) => m.t === 'handEnd', 30000);
  assert.ok(end.summary.winners.length >= 1);
  const after = await a.next((m) => m.t === 'state' && m.s.pot === 0 && m.s.players.every((p) => p.bet === 0));
  const total = after.s.players.reduce((s, p) => s + p.chips, 0);
  assert.equal(total, 1000, 'фишки не теряются и не появляются');

  // Раздача попала в рейтинг обоим, итоги взаимно гасятся; до таблицы — ещё несколько раздач.
  a.send({ t: 'rating' });
  b.send({ t: 'rating' });
  const ra = await a.next((m) => m.t === 'rating');
  const rb = await b.next((m) => m.t === 'rating');
  assert.equal(ra.me.hands, 1);
  assert.equal(ra.me.profit + rb.me.profit, 0);
  assert.equal(ra.me.place, null);
  assert.ok(ra.me.needHands > 0);
  assert.ok(!JSON.stringify(ra).includes(a.key), 'ключ устройства не утекает');
  stopA(); stopB();
  a.close(); b.close();
});

test('соперник ушёл во время чужого хода — оставшийся сразу забирает банк', async () => {
  const a = await client('Гена');
  a.send({ t: 'create', settings: { visibility: 'closed', buyIn: 500 } });
  const { code } = (await a.next(roomMsg)).room;
  const b = await client('Даша');
  b.send({ t: 'join', code });
  await a.next((m) => roomMsg(m) && m.room.members.length === 2);
  a.send({ t: 'start' });

  const isTurn = (m) => m.t === 'turn';
  const first = await Promise.race([a.next(isTurn, 15000).then(() => a), b.next(isTurn, 15000).then(() => b)]);
  const quitter = first === a ? b : a;
  quitter.send({ t: 'leave' });
  const left = await quitter.next((m) => m.t === 'left');

  const end = await first.next((m) => m.t === 'handEnd', 5000); // без ожидания 30-секундного таймера
  assert.equal(end.summary.type, 'fold');
  assert.equal(end.summary.rest.length, 5, 'все пасовали на префлопе — показываем все пять несыгранных карт');
  assert.ok(end.summary.rest.every((c) => c && c.id), 'карты в том же виде, что и на столе');
  const after = await first.next((m) => m.t === 'state' && m.s.pot === 0 && m.s.players.length === 1, 10000);
  assert.equal(after.s.players[0].chips + left.chips, 1000, 'банк достался оставшемуся, фишки сошлись');
  a.close(); b.close();
});

test('переподключение с тем же ключом возвращает на то же место', async () => {
  const a = await client('Вера');
  a.send({ t: 'create', settings: { visibility: 'closed', bots: true } });
  const { code } = (await a.next(roomMsg)).room;
  a.send({ t: 'start' });
  await a.next((m) => m.t === 'state');
  const key = a.key;
  const oldId = a.id;
  a.close();

  const again = await client('Вера', key);
  assert.equal(again.id, oldId, 'тот же игрок');
  const room = (await again.next(roomMsg)).room;
  assert.equal(room.code, code);
  const state = await again.next((m) => m.t === 'state');
  assert.ok(state.s.players.some((p) => p.id === oldId), 'место за столом сохранилось');
  again.send({ t: 'leave' });
  const left = await again.next((m) => m.t === 'left');
  assert.equal(left.reason, 'self');
  again.close();
});

test('взнос задаёт блайнды (1000 → 5/10) без роста; взнос — только из лестницы режима', async () => {
  const a = await client('Ира');
  a.send({ t: 'create', settings: { visibility: 'closed', mode: 'holdem', buyIn: 1000, bots: true, level: 3, blindUp: true } });
  const room = (await a.next(roomMsg)).room;
  assert.deepEqual(room.blinds, [5, 10]);
  assert.equal(room.format, 'cash');
  assert.ok(!('level' in room) && !('blindUp' in room), 'старых настроек уровня больше нет');

  const b = await client('Кира');
  b.send({ t: 'create', settings: { visibility: 'closed', mode: 'aof', buyIn: 7000 } });
  const aof = (await b.next(roomMsg)).room;
  assert.equal(aof.mode, 'aof');
  assert.equal(aof.buyIn, 1000, 'AoF: взноса 7 000 нет в лестнице — взят взнос по умолчанию');

  const c = await client('Лена');
  c.send({ t: 'create', settings: { visibility: 'closed', mode: 'omaha', buyIn: 500000 } });
  const high = (await c.next(roomMsg)).room;
  assert.equal(high.buyIn, 500000);
  assert.deepEqual(high.blinds, [2500, 5000]);

  a.send({ t: 'start' });
  const st = await a.next((m) => m.t === 'state' && m.s.handNo >= 1);
  assert.equal(st.s.sb, 5);
  assert.equal(st.s.bb, 10);
  assert.equal(st.s.handsLeft, null, 'за кэш-столом блайнды не растут');
  await Promise.all([a, b, c].map((x) => x.close()));
});

test('AoF: одна торговля, любое «играю» — олл-ин на весь стек', async () => {
  const a = await client('Олег');
  a.send({ t: 'create', settings: { visibility: 'closed', mode: 'aof', buyIn: 1000 } });
  const { code } = (await a.next(roomMsg)).room;
  const b = await client('Петя');
  b.send({ t: 'join', code });
  await a.next((m) => roomMsg(m) && m.room.members.length === 2);

  const seen = [];
  const pick = (type) => (L) => { seen.push(L); return type === 'raise' ? { type, to: 40 } : { type }; };
  const stopA = autoPlay(a, pick('raise')); // попытка маленького рейза всё равно становится олл-ином
  const stopB = autoPlay(b, pick('allin'));
  a.send({ t: 'start' });

  const end = await a.next((m) => m.t === 'handEnd', 30000);
  assert.equal(end.summary.type, 'showdown', 'оба пошли ва-банк — вскрытие');
  assert.ok(seen.length >= 2);
  for (const L of seen) {
    assert.equal(L.aof, true);
    assert.equal(L.minTo, L.maxTo);
    assert.equal(L.maxTo, L.stackTo);
  }
  const allIn = a.inbox.filter((m) => m.t === 'state').some((m) => m.s.players.every((p) => p.allIn));
  assert.ok(allIn, 'в снимках оба игрока ва-банк');
  const after = await a.next((m) => m.t === 'state' && m.s.handNo === 1 && m.s.pot === 0 && m.s.players.every((p) => p.bet === 0));
  assert.equal(after.s.players.reduce((s, p) => s + p.chips, 0), 2000, 'фишки сходятся');
  stopA(); stopB();
  await Promise.all([a.close(), b.close()]);
});

test('адрес клиента — последняя запись X-Forwarded-For: подделка первых записей не обходит лимит', async () => {
  assert.equal(ipOf({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, socket: {} }), '203.0.113.9');
  assert.equal(ipOf({ headers: {}, socket: { remoteAddress: '10.1.1.1' } }), '10.1.1.1');

  const open = (i) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.7` } });
    ws.on('open', () => resolve({ ws, rejected: false }));
    ws.on('close', (code) => resolve({ ws, rejected: code === 1013 }));
    ws.on('error', () => {});
  });
  const socks = [];
  for (let i = 0; i < 9; i++) socks.push(await open(i));
  const last = await new Promise((r) => {
    if (socks[8].ws.readyState === WebSocket.CLOSED) { r(true); return; }
    socks[8].ws.once('close', (code) => r(code === 1013));
  });
  assert.ok(socks.slice(0, 8).every((s) => !s.rejected), 'восемь соединений с адреса разрешены');
  assert.ok(last, 'девятое отклонено, хотя первые записи заголовка разные');
  await Promise.all(socks.map((s) => new Promise((r) => {
    if (s.ws.readyState === WebSocket.CLOSED) { r(); return; }
    s.ws.once('close', r);
    s.ws.close();
  })));
});

test('уборка не удаляет сессию с недоставленным итогом турнира или уходом', () => {
  const lobby = new Lobby(null);
  const keep = lobby.session('sweep-keep-key-0123456789');
  const drop = lobby.session('sweep-drop-key-0123456789');
  const old = Date.now() - 60 * 60 * 1000;
  keep.lastSeen = old;
  keep.pendingResult = { t: 'tourneyResult', code: 'ABCDEF', place: 1, prize: 1000 };
  drop.lastSeen = old;
  lobby.sweep(10 * 60 * 1000);
  assert.ok(lobby.sessions.has(keep.key), 'итог дождётся игрока');
  assert.ok(!lobby.sessions.has(drop.key), 'пустая забытая сессия удалена');
  keep.lastSeen = Date.now() - 25 * 60 * 60 * 1000;
  lobby.sweep(10 * 60 * 1000);
  assert.ok(!lobby.sessions.has(keep.key), 'но не дольше суток');
});

test('счётчик онлайна: только число игроков на связи, доступен приложению с другого адреса', async () => {
  const get = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/online`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    return (await res.json()).online;
  };
  const before = await get();
  const a = await client('Онлайн');
  assert.equal(await get(), before + 1);
  a.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await get(), before, 'отключившийся не считается');
});
