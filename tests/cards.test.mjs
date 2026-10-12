// Тесты оценки комбинаций и шансов: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../poker/js/cards.js', import.meta.url), 'utf8');
const context = { window: { crypto: webcrypto }, Math, Set, Array, Uint32Array };
vm.runInNewContext(source, context);
const C = context.window.Poker.Cards;

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
let jokerId = 0;
const card = (s) => (s === 'X'
  ? { j: true, id: `J${++jokerId}` }
  : { r: RANKS.indexOf(s[0]) + 2, s: SUITS.indexOf(s[1]), id: `${RANKS.indexOf(s[0]) + 2}-${SUITS.indexOf(s[1])}` });
const cards = (str) => str.split(' ').map(card);
const holdem = (hole, board, mode = 'holdem') => C.bestScore(mode, cards(hole), cards(board));
const name = (hole, board, mode) => C.handName(holdem(hole, board, mode), mode);

test('называет каждую категорию комбинации', () => {
  assert.equal(name('As Ks', 'Qs Js Ts 2d 3c'), 'Роял-флеш');
  assert.equal(name('9h 8h', '7h 6h 5h Ac Ad'), 'Стрит-флеш до девятки');
  assert.equal(name('9h 9d', '9c 9s 2d 3c 4h'), 'Каре девяток');
  assert.equal(name('Ah Ad', 'Ac Kd Ks 2c 3c'), 'Фулл-хаус: тузы и короли');
  assert.equal(name('2h 7h', 'Th Jh Kh 2c 2d'), 'Флеш до короля');
  assert.equal(name('Th 9d', '8c 7s 6h 2d 2c'), 'Стрит до десятки');
  assert.equal(name('7h 7d', '7c Ks 2h 4d 9c'), 'Тройка семёрок');
  assert.equal(name('Jh Jd', '4c 4s Ah 8d 9c'), 'Две пары: валеты и четвёрки');
  assert.equal(name('Th Td', 'Kc 6s 3h 8d 2c'), 'Пара десяток');
  assert.equal(name('Ah Jd', '8c 5s 2h 9d 3c'), 'Старшая карта A');
});

test('туз бывает младшим в стрите A-2-3-4-5', () => {
  assert.equal(name('5h 4d', '3c 2s Ah Kd Kc'), 'Стрит до пятёрки');
});

test('старшинство категорий строго по правилам', () => {
  const ladder = [
    ['Ah Jd', '8c 5s 2h 9d 3c'], ['Th Td', 'Kc 6s 3h 8d 2c'], ['Jh Jd', '4c 4s Ah 8d 9c'],
    ['7h 7d', '7c Ks 2h 4d 9c'], ['Th 9d', '8c 7s 6h 2d 2c'], ['2h 7h', 'Th Jh Kh 2c 3d'],
    ['Ah Ad', 'Ac Kd Ks 2c 3c'], ['9h 9d', '9c 9s 2d 3c 4h'], ['9h 8h', '7h 6h 5h Ac Ad'],
  ].map(([h, b]) => holdem(h, b));
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] > ladder[i - 1], `шаг ${i}`);
});

test('кикер решает при равной паре', () => {
  assert.ok(holdem('Ah As', 'Kd 7c 4h 2s 9d') > holdem('Ac Ad', 'Qd 7c 4h 2s 9d'));
});

test('Омаха: ровно две карты с руки', () => {
  // Одна червовая на руке + четыре на столе — флеша в Омахе нет.
  assert.equal(name('Ah 2c 3d 4s', 'Kh Qh Jh 9h 8h', 'omaha'), 'Старшая карта A');
  // Четыре туза нельзя сыграть все сразу — только тройка.
  assert.equal(name('Ah Ad Kc Qs', 'Ac 7d 2h 9s 3c', 'omaha'), 'Тройка тузов');
});

test('джокер заменяет любую карту', () => {
  assert.equal(name('X Ad', 'Ac Ah As 2c 3d', 'joker'), 'Покер: пять тузов');
  assert.equal(name('X 2h', '3h 4h 5h Kd Kc', 'joker'), 'Стрит-флеш до шестёрки');
  assert.equal(name('X X', 'Kd 2c 7h 9s 4d', 'joker'), 'Тройка королей');
  assert.ok(holdem('X Ad', 'Ac Ah As 2c 3d', 'joker') > holdem('As Ks', 'Qs Js Ts 2d 3c'));
});

test('колода: 52 карты, с джокерами 54, в шорт-деке 36 — без повторов', () => {
  assert.equal(new Set(C.makeDeck('holdem').map((c) => c.id)).size, 52);
  assert.equal(new Set(C.makeDeck('omaha').map((c) => c.id)).size, 52);
  assert.equal(new Set(C.makeDeck('joker').map((c) => c.id)).size, 54);
  assert.equal(new Set(C.shuffle(C.makeDeck('joker')).map((c) => c.id)).size, 54);
  const short = C.makeDeck('short');
  assert.equal(new Set(short.map((c) => c.id)).size, 36);
  assert.ok(short.every((c) => c.r >= 6), 'в шорт-деке нет двоек—пятёрок');
});

test('шорт-дек: младший стрит A-6-7-8-9', () => {
  assert.equal(name('Ah 6d', '7c 8s 9h Kd Qc', 'short'), 'Стрит до девятки');
  // В обычном Холдеме та же рука — просто старшая карта.
  assert.equal(name('Ah 6d', '7c 8s 9h Kd Qc'), 'Старшая карта A');
});

test('шорт-дек: флеш старше фулл-хауса, тройка старше стрита', () => {
  const flush = holdem('Ah 8h', 'Jh 7h 6h Kd Qc', 'short');
  const fullHouse = holdem('Kh Kd', 'Kc Qs Qh 7d 6c', 'short');
  assert.ok(flush > fullHouse, 'флеш бьёт фулл-хаус');
  const trips = holdem('7h 7d', '7c Ks Jh 9d 6c', 'short');
  const straight = holdem('Th 9d', '8c 7s 6h Kd Qc', 'short');
  assert.ok(trips > straight, 'тройка бьёт стрит');
  assert.equal(C.handName(flush, 'short'), 'Флеш до туза');
  assert.equal(C.handName(trips, 'short'), 'Тройка семёрок');
  // В обычном Холдеме порядок прежний.
  assert.ok(holdem('Kh Kd', 'Kc Qs Qh 7d 6c') > holdem('Ah 8h', 'Jh 7h 6h Kd Qc'));
});

test('шорт-дек: шансы считаются по колоде из 36 карт', () => {
  const eq = C.equity('short', cards('Ah Ad'), [], 1, 3000);
  assert.ok(eq > 0.7 && eq < 0.9, `получилось ${eq}`);
});

test('шансы: пара тузов против случайной руки ≈ 85%', () => {
  const eq = C.equity('holdem', cards('Ah Ad'), [], 1, 4000);
  assert.ok(eq > 0.81 && eq < 0.89, `получилось ${eq}`);
});

test('шансы: собранный роял-флеш на ривере не проигрывает', () => {
  assert.equal(C.equity('holdem', cards('As Ks'), cards('Qs Js Ts 2d 3c'), 3, 200), 1);
});
