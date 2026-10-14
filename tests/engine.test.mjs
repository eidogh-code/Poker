// Тесты игрового движка: блайнды кэш-стола, турнир, AoF, «несыгранные» карты. Запуск: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Паузы движка (раздача карт, «думает бот») в тестах не нужны: таймеры срабатывают сразу.
const context = vm.createContext({
  window: { crypto: webcrypto },
  setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {}, setInterval, clearInterval,
  Date, Math, JSON, Promise, Error, Set, Map, Array, Object, Number, String, Uint32Array,
});
for (const file of ['cards.js', 'ai.js', 'game.js']) {
  vm.runInContext(readFileSync(new URL(`../poker/js/${file}`, import.meta.url), 'utf8'), context, { filename: file });
}
const P = context.window.Poker;

const quietHooks = (extra) => ({
  onChange() {}, onNewHand() {}, onHumanTurn() {}, onHandEnd() {}, onHandSettled() {},
  onBankrupt: async () => 0, onSitOut() {}, onError(e) { throw e; }, onLog() {}, sound() {},
  ...extra,
});

// Стол только из ботов (сетевой формат без людей) — играет сам.
const botTable = (cfg, hooks) => new P.Game({ players: [], bots: true, opponents: 3, speed: 'fast', autoNextMs: 1, ...cfg }, quietHooks(hooks));

const humans = (n, chips = 1000) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, name: `Игрок ${i}`, chips }));

test('блайнды кэш-стола — сотая часть взноса', () => {
  assert.deepEqual([...P.blindsFor(1000)], [5, 10]);
  assert.deepEqual([...P.blindsFor(5000)], [25, 50]);
  assert.deepEqual([...P.blindsFor(500)], [2, 5]);
  assert.ok(P.CASH_STAKES.every((s) => P.blindsFor(s)[1] * 100 === s), 'на каждом столе ровно 100 ББ');
  assert.deepEqual([...P.stakesFor('aof')], [...P.AOF_STAKES]);
});

test('за кэш-столом блайнды не растут', async () => {
  const blinds = [];
  await new Promise((done) => {
    const g = botTable({ mode: 'holdem', stack: 1000 }, {
      onNewHand() {
        if (g.handNo > 1) blinds.push(`${g.sb}/${g.bb}`);
        if (g.handNo > 25) { g.stop(); done(); }
      },
    });
    g.start();
  });
  assert.ok(blinds.length > 20);
  assert.ok(blinds.every((b) => b === '5/10'), `блайнды менялись: ${[...new Set(blinds)]}`);
});

test('турнир: блайнды растут, все получают места, победитель забирает все фишки', async () => {
  const result = await new Promise((done) => {
    const levels = new Set();
    const g = botTable({ mode: 'holdem', format: 'tournament', stack: 999 }, {
      onNewHand() { levels.add(g.bb); },
      onTournamentEnd(r) { done({ r, levels, g }); },
    });
    g.start();
  });
  const { r, levels, g } = result;
  const places = [...r.standings.map((s) => s.place)].sort(); // массив из контекста движка — копируем в свой
  assert.deepEqual(places, [1, 2, 3, 4]);
  assert.equal(r.standings[0].id, r.winner.id);
  const winner = g.byId(r.winner.id);
  assert.equal(winner.chips, 4 * P.TOURNEY.stack, 'стартовые стеки турнирные, фишки не теряются');
  assert.ok(levels.size > 1, 'блайнды росли');
  assert.equal(g.addPlayer({ id: 'late', name: 'Опоздавший', chips: 1500 }), false, 'в идущий турнир не садятся');
});

// Два человека, оба на любое предложение отвечают одним действием; первая раздача.
function playOneHand(cfg, answer) {
  return new Promise((done) => {
    const turns = [];
    const g = new P.Game({ players: humans(2), bots: false, opponents: 1, speed: 'fast', autoNextMs: 1, ...cfg }, quietHooks({
      onHumanTurn(p, L) {
        turns.push({ id: p.id, L: { ...L }, board: g.board.length, hole: p.hole.length });
        setImmediate(() => g.humanAct(answer(p, L, turns.length), p.id));
      },
      onHandEnd(summary) {
        const snap = { summary, players: g.players.map((p) => ({ chips: p.chips, hole: p.hole.slice() })), board: g.board.slice() };
        g.stop();
        done({ turns, ...snap });
      },
    }));
    g.start();
  });
}

test('AoF Холдем: ставка только на весь стек, дальше карты без торговли', async () => {
  const { turns, players, board, summary } = await playOneHand({ mode: 'aof', stack: 1000 }, () => ({ type: 'call' }));
  assert.equal(turns.length, 2, 'одна торговля — по одному решению на игрока');
  assert.equal(turns[0].board, 0, 'решение до общих карт');
  assert.equal(turns[0].L.minTo, turns[0].L.maxTo, 'ставка без выбора размера');
  assert.equal(turns[0].L.maxTo, turns[0].L.stackTo);
  assert.equal(board.length, 5);
  assert.equal(summary.type, 'showdown');
  assert.equal(players.reduce((s, p) => s + p.chips, 0), 2000);
});

test('AoF Омаха: четыре карты и флоп до решения', async () => {
  const { turns, summary } = await playOneHand({ mode: 'aofomaha', stack: 1000 }, () => ({ type: 'raise', to: 50 }));
  assert.equal(turns[0].hole, 4);
  assert.equal(turns[0].board, 3, 'флоп открыт до торговли');
  assert.equal(turns.length, 2);
  assert.equal(summary.type, 'showdown');
});

test('все сбросили до флопа — видны пять карт, которые легли бы на стол', async () => {
  const { summary, players } = await playOneHand({ mode: 'holdem', stack: 1000 }, () => ({ type: 'fold' }));
  assert.equal(summary.type, 'fold');
  assert.equal(summary.rest.length, 5);
  const used = new Set(players.flatMap((p) => p.hole.map((c) => c.id)));
  assert.ok(summary.rest.every((c) => !used.has(c.id)), 'карты из колоды, не с рук');
  assert.equal(new Set(summary.rest.map((c) => c.id)).size, 5);
});

test('сбросили после флопа — видны оставшиеся две карты', async () => {
  // Первые два решения — колл и чек (префлоп), третье — пас на флопе.
  const { summary, board } = await playOneHand({ mode: 'holdem', stack: 1000 }, (p, L, n) => (n <= 2 ? { type: 'call' } : { type: 'fold' }));
  assert.equal(summary.type, 'fold');
  assert.equal(board.length, 3);
  assert.equal(summary.rest.length, 2);
});

test('стол «по максимуму»: самый дорогой, на который хватает денег', () => {
  assert.equal(P.pickStake('holdem', 10000), 10000);
  assert.equal(P.pickStake('holdem', 9999), 5000);
  assert.equal(P.pickStake('holdem', 499), 0);
  assert.equal(P.pickStake('aof', 1e9), 5000, 'у AoF своя лестница — до 5 000');
});
