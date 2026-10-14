// Турниры по сети: очередь, старт после ожидания, вылет и приз, без подсадки. Запуск: npm test
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connectClient, autoPlay, roomMsg } = require('./helpers');
const { P } = require('../src/engine');

const WAIT_MS = 300;
let srv;
let port;

before(async () => {
  ({ srv, port } = await startServer({ tourneyWaitMs: WAIT_MS, autoNextMs: 200 }));
});

after(() => srv.close());

const client = (nick, key) => connectClient(port, nick, key);
const queueMsg = (m) => m.t === 'queue';
const startedRoom = (m) => roomMsg(m) && m.room.format === 'tournament';

// Двое встают в одну очередь и получают турнирную комнату.
async function startPair(mode, buyIn, names) {
  const a = await client(names[0]);
  const b = await client(names[1]);
  a.send({ t: 'queue', mode, buyIn });
  const one = (await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 1)).queue;
  assert.equal(one.startsIn, null, 'одному ждать нечего — таймера нет');
  b.send({ t: 'queue', mode, buyIn });
  const two = (await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 2)).queue;
  assert.equal(two.max, 6);
  assert.ok(two.startsIn > 0 && two.startsIn <= WAIT_MS, 'с двумя игроками пошёл отсчёт до старта');
  const room = (await a.next(startedRoom, 5000)).room;
  await b.next(startedRoom, 5000);
  assert.equal((await a.next(queueMsg)).queue, null, 'очередь закончилась стартом');
  return { a, b, room };
}

test('неверный запрос в очередь отклоняется, из очереди можно выйти', async () => {
  const a = await client('Рита');
  a.send({ t: 'queue', mode: 'holdem', buyIn: 777 });
  assert.match((await a.next((m) => m.t === 'error')).msg, /турнира нет/);
  a.send({ t: 'queue', mode: 'omaha', buyIn: 2000 });
  await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 1);

  const watcher = await client('Сеня');
  watcher.send({ t: 'list' });
  const { queues } = await watcher.next((m) => m.t === 'rooms');
  assert.ok(queues.some((q) => q.mode === 'omaha' && q.buyIn === 2000 && q.count === 1), 'очередь видна в лобби');

  a.send({ t: 'unqueue' });
  assert.equal((await a.next(queueMsg)).queue, null);
  watcher.send({ t: 'list' });
  const again = await watcher.next((m) => m.t === 'rooms');
  assert.ok(!again.queues.some((q) => q.mode === 'omaha' && q.buyIn === 2000), 'пустая очередь исчезла');
  await Promise.all([a.close(), watcher.close()]);
});

test('отключившийся выбывает из очереди', async () => {
  const a = await client('Юля');
  const b = await client('Яна');
  a.send({ t: 'queue', mode: 'joker', buyIn: 5000 });
  await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 1);
  b.send({ t: 'queue', mode: 'joker', buyIn: 5000 });
  await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 2);
  await b.close();
  const back = (await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 1)).queue;
  assert.equal(back.startsIn, null, 'отсчёт остановлен');
  await new Promise((r) => setTimeout(r, WAIT_MS * 2));
  assert.ok(!a.inbox.some(startedRoom), 'в одиночку турнир не начался');
  await a.close();
});

test('очередь из двоих стартует после ожидания; подсесть в идущий турнир нельзя', async () => {
  const { a, b, room } = await startPair('holdem', 1000, ['Таня', 'Уля']);
  assert.equal(room.format, 'tournament');
  assert.equal(room.buyIn, 1000);
  assert.equal(room.prize, 2000);
  assert.equal(room.players, 2);
  assert.deepEqual(room.blinds, [10, 20]);
  assert.equal(room.members.length, 2);

  const st = await a.next((m) => m.t === 'state' && m.s.handNo >= 1);
  assert.equal(st.s.players.length, 2, 'ботов нет');
  assert.equal(st.s.players.reduce((s, p) => s + p.chips + p.bet, 0) + st.s.pot, 3000, 'у каждого турнирный стек 1500');
  assert.equal(typeof st.s.handsLeft, 'number', 'до роста блайндов считаются раздачи');

  const late = await client('Федя');
  late.send({ t: 'join', code: room.code });
  assert.match((await late.next((m) => m.t === 'error')).msg, /турнир/i);
  late.send({ t: 'list' });
  const { rooms } = await late.next((m) => m.t === 'rooms');
  assert.ok(!rooms.some((r) => r.code === room.code), 'турнир не виден в списке столов');

  // Пока сидишь в турнире, в очередь не встать.
  a.send({ t: 'queue', mode: 'holdem', buyIn: 1000 });
  assert.match((await a.next((m) => m.t === 'error')).msg, /выйдите/);
  await Promise.all([a.close(), b.close(), late.close()]);
});

test('ушедший сдаёт турнир (0 фишек), оставшийся получает приз; итог повторяется после переподключения', async () => {
  const { a, b, room } = await startPair('short', 500, ['Харитон', 'Цезарь']);
  await a.next((m) => m.t === 'state');
  b.send({ t: 'leave' });
  const left = await b.next((m) => m.t === 'left');
  assert.equal(left.chips, 0, 'турнирные фишки не деньги');
  const win = await a.next((m) => m.t === 'tourneyResult', 20000);
  assert.match(a.boot, /^[0-9a-f]{12}$/, 'в welcome — метка запуска сервера');
  assert.deepEqual(win, { t: 'tourneyResult', code: room.code, boot: a.boot, place: 1, prize: 1000, players: 2, buyIn: 500 });
  assert.equal(left.code, room.code);
  assert.equal(left.boot, a.boot);
  assert.ok(!a.inbox.some((m) => m.t === 'chips'), 'фишки турнира на баланс не сообщаются');
  const fin = await a.next((m) => roomMsg(m) && m.room.finished === true);
  assert.equal(fin.room.prize, 1000);

  // Клиент зачтёт приз один раз по коду комнаты, даже если итог придёт снова.
  await a.close();
  const again = await client('Харитон', a.key);
  assert.equal(again.id, a.id, 'тот же игрок по ключу устройства');
  const repeat = await again.next((m) => m.t === 'tourneyResult');
  assert.equal(repeat.prize, 1000);
  again.send({ t: 'leave' });
  assert.equal((await again.next((m) => m.t === 'left')).chips, 0);
  await Promise.all([again.close(), b.close()]);
});

test('AoF-турнир доигрывается: вылетевший — 2-е место без приза, победитель — весь призовой фонд', async () => {
  const { a, b, room } = await startPair('aof', 2000, ['Чук', 'Гек']);
  assert.equal(room.prize, 4000);
  const stops = [a, b].map((c) => autoPlay(c, () => ({ type: 'allin' })));
  const [ra, rb] = await Promise.all([
    a.next((m) => m.t === 'tourneyResult', 120000),
    b.next((m) => m.t === 'tourneyResult', 120000),
  ]);
  const [first, second] = ra.place === 1 ? [ra, rb] : [rb, ra];
  assert.equal(first.place, 1);
  assert.equal(first.prize, 4000);
  assert.equal(second.place, 2);
  assert.equal(second.prize, 0);
  assert.equal(first.players, 2);
  // Выбывший молчит в чате стола, победитель — нет.
  const loser = second === ra ? a : b;
  const winner = loser === a ? b : a;
  loser.send({ t: 'chat', text: 'подсказка' });
  assert.match((await loser.next((m) => m.t === 'error')).msg, /Выбывшие/);
  winner.send({ t: 'chat', text: 'gg' });
  await loser.next((m) => m.t === 'chat' && m.msg.text === 'gg');
  stops.forEach((s) => s());
  await Promise.all([a.close(), b.close()]);
});

test('ошибка движка в турнире распускает стол: всем «aborted» с кодом для возврата взноса', async () => {
  const { a, b, room } = await startPair('holdem', 2000, ['Эля', 'Ян']);
  await a.next((m) => m.t === 'state');
  const live = srv.lobby.rooms.get(room.code);
  const quiet = console.error;
  console.error = () => {};
  try {
    live.game.hooks.onError(new Error('сбой для теста'));
  } finally {
    console.error = quiet;
  }
  const [la, lb] = await Promise.all([a.next((m) => m.t === 'left'), b.next((m) => m.t === 'left')]);
  for (const l of [la, lb]) {
    assert.equal(l.reason, 'aborted');
    assert.equal(l.code, room.code);
    assert.equal(l.boot, a.boot);
    assert.equal(l.chips, 0);
  }
  assert.ok(!srv.lobby.rooms.has(room.code), 'комната удалена');
  await Promise.all([a.close(), b.close()]);
});

test('сбой при старте турнира откатывается: игроки свободны и получают ошибку', async () => {
  const original = P.Game;
  P.Game = class { constructor() { throw new Error('движок не создаётся'); } };
  const quiet = console.error;
  console.error = () => {};
  const a = await client('Вася');
  const b = await client('Гриша');
  try {
    a.send({ t: 'queue', mode: 'omaha', buyIn: 10000 });
    b.send({ t: 'queue', mode: 'omaha', buyIn: 10000 });
    const err = await a.next((m) => m.t === 'error', 5000);
    assert.match(err.msg, /не удалось начать/);
    await b.next((m) => m.t === 'error', 5000);
  } finally {
    P.Game = original;
    console.error = quiet;
  }
  assert.ok(!a.inbox.some(startedRoom), 'комнату не прислали');
  // Игроки не застряли: можно снова встать в очередь.
  a.send({ t: 'queue', mode: 'omaha', buyIn: 10000 });
  await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 1);
  a.send({ t: 'unqueue' });
  await Promise.all([a.close(), b.close()]);
});

test('сервер полон — старт турнира откладывается, очередь сохраняется', async () => {
  const a = await client('Дина');
  const b = await client('Ева');
  a.send({ t: 'queue', mode: 'short', buyIn: 10000 });
  await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 1);
  b.send({ t: 'queue', mode: 'short', buyIn: 10000 });
  await a.next((m) => queueMsg(m) && m.queue && m.queue.count === 2);
  // Места кончились, пока шёл отсчёт (в очередь при полном сервере не пускают).
  Object.defineProperty(srv.lobby.rooms, 'size', { get: () => 10000, configurable: true });
  try {
    await new Promise((r) => setTimeout(r, WAIT_MS * 3));
    assert.ok(!a.inbox.some(startedRoom), 'пока мест нет — не стартуем');
  } finally {
    delete srv.lobby.rooms.size;
  }
  const room = (await a.next(startedRoom, 5000)).room;
  assert.equal(room.players, 2);
  await Promise.all([a.close(), b.close()]);
});
