// Сквозные тесты сервера: настоящие WebSocket-клиенты против локального сервера. Запуск: npm test
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../src/index');

let srv;
let port;

before(async () => {
  srv = createServer();
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  port = srv.server.address().port;
});

after(() => srv.close());

let keySeq = 0;
const newKey = () => `test-key-${Date.now()}-${++keySeq}-abcdef`;

// Клиент с почтовым ящиком: next(pred) ждёт первое подходящее сообщение (в том числе уже пришедшее).
async function client(nick, key = newKey()) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = new Set();
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    inbox.push(m);
    for (const w of [...waiters]) w(m);
  });
  await new Promise((r) => ws.on('open', r));
  const c = {
    ws, key, inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    next: (pred, ms = 8000) => new Promise((resolve, reject) => {
      const found = inbox.find(pred);
      if (found) { inbox.splice(inbox.indexOf(found), 1); resolve(found); return; }
      const timer = setTimeout(() => { waiters.delete(w); reject(new Error(`timeout waiting in ${nick}`)); }, ms);
      const w = (m) => {
        if (!pred(m)) return;
        clearTimeout(timer);
        waiters.delete(w);
        inbox.splice(inbox.indexOf(m), 1);
        resolve(m);
      };
      waiters.add(w);
    }),
    close: () => ws.close(),
  };
  c.send({ t: 'hello', key, nick, avatar: { kind: 'glyph', glyph: '♥', tone: 1 } });
  c.id = (await c.next((m) => m.t === 'welcome')).id;
  return c;
}

const roomMsg = (m) => m.t === 'room';

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
  const autoPlay = (c) => {
    const onMsg = (data) => {
      const m = JSON.parse(String(data));
      if (m.t === 'turn') c.send({ t: 'act', action: { type: m.limits.toCallFull > 0 ? 'call' : 'check' } });
    };
    c.ws.on('message', onMsg);
    return () => c.ws.off('message', onMsg);
  };
  const stopA = autoPlay(a);
  const stopB = autoPlay(b);

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

  await first.next((m) => m.t === 'handEnd', 5000); // без ожидания 30-секундного таймера
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
