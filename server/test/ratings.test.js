// Рейтинг: подсчёт, порядок, защита от «одиночных» раздач, сохранение и слияние с хранилищем.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ratings, FileStore, UpstashStore, storeFromEnv, ratingId, MIN_HANDS } = require('../src/ratings');

const quiet = { log: { log() {}, error() {} } };

const play = (r, a, b, times) => {
  for (let i = 0; i < times; i++) r.recordHand([{ rid: 'a', nick: 'Аня', net: a }, { rid: 'b', nick: 'Боря', net: b }]);
};

test('раздача с одним человеком в рейтинг не идёт', () => {
  const r = new Ratings();
  r.recordHand([{ rid: 'a', nick: 'Аня', net: 500 }]);
  assert.equal(r.board('a').me, null);
});

test('в таблице — сыгравшие минимум раздач, по убыванию выигрыша', () => {
  const r = new Ratings();
  play(r, 30, -30, MIN_HANDS);
  r.recordHand([{ rid: 'c', nick: 'Вика', net: 9000 }, { rid: 'a', nick: 'Аня', net: -9000 }]);

  const board = r.board('b');
  assert.deepEqual(board.top.map((x) => x.nick), ['Боря', 'Аня'], 'Вика сыграла одну раздачу — её нет');
  assert.equal(board.top[0].profit, -30 * MIN_HANDS);
  assert.equal(board.top[1].profit, 30 * MIN_HANDS - 9000);
  assert.equal(board.me.place, 1);
  assert.equal(board.me.me, true);

  const vika = r.board('c').me;
  assert.equal(vika.place, null);
  assert.equal(vika.needHands, MIN_HANDS - 1);
  assert.equal(vika.best, 9000);
  assert.equal(vika.wins, 1);
});

test('ник обновляется, ключ устройства не раскрывается', () => {
  const rid = ratingId('secret-device-key-123456');
  assert.match(rid, /^[0-9a-f]{20}$/);
  assert.ok(!rid.includes('secret'));
  const r = new Ratings();
  r.recordHand([{ rid, nick: 'Старый', net: 10 }, { rid: 'x', nick: 'Икс', net: -10 }]);
  r.recordHand([{ rid, nick: 'Новый', net: 10 }, { rid: 'x', nick: 'Икс', net: -10 }]);
  assert.equal(r.board(rid).me.nick, 'Новый');
});

test('сохранение в файл и слияние с тем, что накопилось до загрузки', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-rating-'));
  const file = path.join(dir, 'ratings.json');
  try {
    const first = new Ratings(new FileStore(file), quiet);
    await first.load();
    play(first, 100, -100, 3);
    await first.flush();
    first.close();

    const second = new Ratings(new FileStore(file), quiet);
    play(second, 50, -50, 2);                    // результаты, пришедшие до загрузки
    await second.load();
    const a = second.entries.get('a');
    assert.equal(a.hands, 5);
    assert.equal(a.profit, 400);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('испорченные записи в хранилище отбрасываются', async () => {
  const store = { describe: () => 'mock', load: async () => ({ ok: { nick: 'Ок', profit: 5, hands: 1 }, bad: { profit: 'x' }, worse: null }), save: async () => {} };
  const r = new Ratings(store, quiet);
  await r.load();
  assert.deepEqual([...r.entries.keys()], ['ok']);
  r.close();
});

test('пока хранилище не прочитано, сохранение не затирает его', async () => {
  let saved = 0;
  const store = { describe: () => 'mock', load: async () => { throw new Error('нет связи'); }, save: async () => { saved++; } };
  const r = new Ratings(store, quiet);
  await r.load();
  play(r, 10, -10, 1);
  await r.flush();
  assert.equal(saved, 0);
  r.close();
});

test('Upstash выбирается по переменным окружения, иначе файл', () => {
  assert.equal(storeFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }).describe(), 'Upstash Redis');
  assert.match(storeFromEnv({}).describe(), /^файл /);
});

test('при переполнении сначала вытесняются игроки вне таблицы, лидеры остаются', () => {
  const r = new Ratings(null, { ...quiet, maxPlayers: 3 });
  play(r, 100, -100, MIN_HANDS);                       // a и b — в таблице
  r.recordHand([{ rid: 's1', nick: 'Спам1', net: 1 }, { rid: 's2', nick: 'Спам2', net: -1 }]);
  r.recordHand([{ rid: 's3', nick: 'Спам3', net: 1 }, { rid: 's4', nick: 'Спам4', net: -1 }]);
  assert.ok(r.entries.has('a') && r.entries.has('b'), 'лидеры на месте');
  assert.equal(r.entries.size, 3);
  assert.ok(r.evicted.size >= 2);
});

test('сохранения идут по очереди и не теряют результаты, пришедшие во время записи', async () => {
  const calls = [];
  let active = 0;
  const store = {
    describe: () => 'mock',
    load: async () => ({}),
    save: async ({ deltas }) => {
      active++;
      assert.equal(active, 1, 'два сохранения одновременно');
      calls.push([...deltas.values()].reduce((s, d) => s + d.hands, 0));
      await new Promise((ok) => setTimeout(ok, 20));
      active--;
    },
  };
  const r = new Ratings(store, quiet);
  await r.load();
  play(r, 5, -5, 1);
  const first = r.flush();
  await new Promise((ok) => setTimeout(ok, 5));         // первая запись уже идёт
  play(r, 5, -5, 1);                                    // пришло во время записи
  await Promise.all([first, r.flush()]);
  assert.deepEqual(calls, [2, 2], 'каждая раздача ушла ровно один раз');
  r.close();
});

test('неудачное сохранение возвращает приращения в очередь', async () => {
  let fail = true;
  const sent = [];
  const store = {
    describe: () => 'mock',
    load: async () => ({}),
    save: async ({ deltas }) => { if (fail) throw new Error('нет связи'); sent.push(deltas.get('a').hands); },
  };
  const r = new Ratings(store, quiet);
  await r.load();
  play(r, 5, -5, 2);
  await r.flush();
  fail = false;
  play(r, 5, -5, 1);
  await r.flush();
  assert.deepEqual(sent, [3]);
  r.close();
});

test('Upstash: приращения через HINCRBY, удаление раньше записи, загрузка из хешей', async () => {
  const requests = [];
  const fake = async (url, opts) => {
    const commands = JSON.parse(opts.body);
    requests.push({ url, commands });
    const hgetall = { 'poker:rating:profit': ['a', '70'], 'poker:rating:hands': ['a', '12'], 'poker:rating:wins': ['a', '4'], 'poker:rating:meta': ['a', '{"nick":"Аня","best":50,"at":1}', 'junk', 'not json'] };
    return { ok: true, json: async () => commands.map((c) => ({ result: c[0] === 'HGETALL' ? hgetall[c[1]] : 1 })) };
  };
  const store = new UpstashStore('https://x.upstash.io/', 'tok', { fetchImpl: fake });
  const data = await store.load();
  assert.deepEqual(Object.keys(data), ['a']);
  assert.equal(requests[0].url, 'https://x.upstash.io/pipeline');

  const r = new Ratings(store, quiet);
  await r.load();
  assert.equal(r.entries.get('a').profit, 70);
  r.evicted.add('old');
  play(r, 30, -30, 1);
  await r.flush();
  const cmds = requests.at(-1).commands;
  assert.equal(cmds[0][0], 'HDEL');
  assert.ok(cmds.some((c) => c[0] === 'HINCRBY' && c[1] === 'poker:rating:profit' && c[2] === 'a' && c[3] === '30'));
  assert.ok(cmds.some((c) => c[0] === 'HSET' && c[2] === 'b'));
  r.close();
});
