// Колода, оценка комбинаций и расчёт шансов (Монте-Карло).
(function (P) {
  'use strict';

  const SUIT_GLYPH = ['♠', '♥', '♦', '♣'];
  const RANK_LABEL = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const BASE = 15;
  const FAKE_SUIT = 4; // масть-заглушка для джокера, не участвующая во флеше

  const GEN_PL = { 2: 'двоек', 3: 'троек', 4: 'четвёрок', 5: 'пятёрок', 6: 'шестёрок', 7: 'семёрок', 8: 'восьмёрок', 9: 'девяток', 10: 'десяток', 11: 'валетов', 12: 'дам', 13: 'королей', 14: 'тузов' };
  const NOM_PL = { 2: 'двойки', 3: 'тройки', 4: 'четвёрки', 5: 'пятёрки', 6: 'шестёрки', 7: 'семёрки', 8: 'восьмёрки', 9: 'девятки', 10: 'десятки', 11: 'валеты', 12: 'дамы', 13: 'короли', 14: 'тузы' };
  const GEN_SG = { 2: 'двойки', 3: 'тройки', 4: 'четвёрки', 5: 'пятёрки', 6: 'шестёрки', 7: 'семёрки', 8: 'восьмёрки', 9: 'девятки', 10: 'десятки', 11: 'валета', 12: 'дамы', 13: 'короля', 14: 'туза' };

  function randInt(n) {
    if (window.crypto && window.crypto.getRandomValues) {
      const a = new Uint32Array(1);
      window.crypto.getRandomValues(a);
      return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  // Колода под режим: в «joker» добавляются два джокера, в «short» (шорт-дек) нет двоек—пятёрок.
  function makeDeck(mode) {
    const lowest = mode === 'short' ? 6 : 2;
    const deck = [];
    for (let s = 0; s < 4; s++) {
      for (let r = lowest; r <= 14; r++) deck.push({ r, s, id: r + '-' + s });
    }
    if (mode === 'joker') deck.push({ j: true, id: 'J1' }, { j: true, id: 'J2' });
    return deck;
  }

  function shuffle(cards) {
    const out = cards.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const k = randInt(i + 1);
      const t = out[i]; out[i] = out[k]; out[k] = t;
    }
    return out;
  }

  function packScore(cat, ks) {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * BASE + (ks[i] || 0);
    return v;
  }

  function decode(score) {
    const ks = [];
    let v = score;
    for (let i = 4; i >= 0; i--) { ks[i] = v % BASE; v = Math.floor(v / BASE); }
    return { cat: v, ks };
  }

  // В шорт-деке младший стрит A-6-7-8-9 (туз встаёт перед шестёркой), в остальных — A-2-3-4-5.
  function straightHigh(present, short) {
    for (let h = 14; h >= (short ? 10 : 5); h--) {
      let ok = true;
      for (let k = 0; k < 5; k++) {
        const r = h - k === 1 ? 14 : h - k;
        if (!present[r]) { ok = false; break; }
      }
      if (ok) return h;
    }
    if (short && present[14] && present[6] && present[7] && present[8] && present[9]) return 9;
    return 0;
  }

  // Шорт-дек меняет старшинство: тройка выше стрита, флеш выше фулл-хауса.
  const SHORT_CAT = { 3: 4, 4: 3, 5: 6, 6: 5 };
  function swapShortCategory(score) {
    const { cat, ks } = decode(score);
    return SHORT_CAT[cat] === undefined ? score : packScore(SHORT_CAT[cat], ks);
  }

  // Лучшая пятёрка из любого набора карт без джокеров.
  function evalPlain(cards, short) {
    const cnt = new Array(15).fill(0);
    const suitRanks = [[], [], [], []];
    for (const c of cards) {
      cnt[c.r]++;
      if (c.s < 4) suitRanks[c.s].push(c.r);
    }
    for (let r = 14; r >= 2; r--) if (cnt[r] >= 5) return packScore(9, [r]);

    let flushSuit = -1;
    for (let s = 0; s < 4; s++) if (suitRanks[s].length >= 5) flushSuit = s;
    if (flushSuit >= 0) {
      const pres = new Array(15).fill(false);
      suitRanks[flushSuit].forEach((r) => { pres[r] = true; });
      const h = straightHigh(pres, short);
      if (h) return packScore(8, [h]);
    }

    const quads = [], trips = [], pairs = [];
    for (let r = 14; r >= 2; r--) {
      if (cnt[r] === 4) quads.push(r);
      else if (cnt[r] === 3) trips.push(r);
      else if (cnt[r] === 2) pairs.push(r);
    }
    const kick = (exclude, n) => {
      const out = [];
      for (let r = 14; r >= 2 && out.length < n; r--) if (cnt[r] > 0 && !exclude.includes(r)) out.push(r);
      return out;
    };

    if (quads.length) return packScore(7, [quads[0], ...kick([quads[0]], 1)]);
    if (trips.length) {
      const second = Math.max(trips[1] || 0, pairs[0] || 0);
      if (second) return packScore(6, [trips[0], second]);
    }
    if (flushSuit >= 0) {
      const top = suitRanks[flushSuit].slice().sort((a, b) => b - a).slice(0, 5);
      return packScore(5, top);
    }
    const sh = straightHigh(cnt.map((n) => n > 0), short);
    if (sh) return packScore(4, [sh]);
    if (trips.length) return packScore(3, [trips[0], ...kick([trips[0]], 2)]);
    if (pairs.length >= 2) return packScore(2, [pairs[0], pairs[1], ...kick([pairs[0], pairs[1]], 1)]);
    if (pairs.length) return packScore(1, [pairs[0], ...kick([pairs[0]], 3)]);
    return packScore(0, kick([], 5));
  }

  // Джокер перебирается как любой ранг в доминирующей масти или вне мастей.
  function evalBest(cards) {
    const real = cards.filter((c) => !c.j);
    const jokers = cards.length - real.length;
    if (!jokers) return evalPlain(cards);

    const sc = [0, 0, 0, 0];
    real.forEach((c) => { sc[c.s]++; });
    let dom = 0;
    for (let s = 1; s < 4; s++) if (sc[s] > sc[dom]) dom = s;
    const subs = [];
    for (let r = 2; r <= 14; r++) subs.push({ r, s: dom }, { r, s: FAKE_SUIT });

    let best = 0;
    if (jokers === 1) {
      for (const a of subs) best = Math.max(best, evalPlain(real.concat([a])));
    } else {
      for (const a of subs) {
        for (const b of subs) best = Math.max(best, evalPlain(real.concat([a, b])));
      }
    }
    return best;
  }

  const COMBO3 = {};
  function combos3(n) {
    if (COMBO3[n]) return COMBO3[n];
    const out = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) out.push([a, b, c]);
    COMBO3[n] = out;
    return out;
  }

  // Омаха: ровно две карты с руки и три со стола.
  function evalOmaha(hole, board) {
    let best = 0;
    const tri = combos3(board.length);
    for (let i = 0; i < hole.length; i++) {
      for (let j = i + 1; j < hole.length; j++) {
        for (const t of tri) {
          const v = evalPlain([hole[i], hole[j], board[t[0]], board[t[1]], board[t[2]]]);
          if (v > best) best = v;
        }
      }
    }
    return best;
  }

  // AoF — те же правила комбинаций, что у базовой игры: AoF Холдем как Холдем, AoF Омаха как Омаха.
  const BASE_MODE = { aof: 'holdem', aofomaha: 'omaha' };
  const baseMode = (mode) => BASE_MODE[mode] || mode;

  function bestScore(mode, hole, board) {
    mode = baseMode(mode);
    if (mode === 'omaha') return board.length >= 3 ? evalOmaha(hole, board) : evalPlain(hole);
    if (mode === 'short') return swapShortCategory(evalPlain(hole.concat(board), true));
    return evalBest(hole.concat(board));
  }

  function handName(score, mode) {
    // Перестановка категорий шорт-дека обратима: та же операция возвращает обычную категорию.
    const { cat, ks } = decode(mode === 'short' ? swapShortCategory(score) : score);
    switch (cat) {
      case 9: return 'Покер: пять ' + GEN_PL[ks[0]];
      case 8: return ks[0] === 14 ? 'Роял-флеш' : 'Стрит-флеш до ' + GEN_SG[ks[0]];
      case 7: return 'Каре ' + GEN_PL[ks[0]];
      case 6: return 'Фулл-хаус: ' + NOM_PL[ks[0]] + ' и ' + NOM_PL[ks[1]];
      case 5: return 'Флеш до ' + GEN_SG[ks[0]];
      case 4: return 'Стрит до ' + GEN_SG[ks[0]];
      case 3: return 'Тройка ' + GEN_PL[ks[0]];
      case 2: return 'Две пары: ' + NOM_PL[ks[0]] + ' и ' + NOM_PL[ks[1]];
      case 1: return 'Пара ' + GEN_PL[ks[0]];
      default: return 'Старшая карта ' + RANK_LABEL[ks[0]];
    }
  }

  function equity(mode, hole, board, nOpp, iters) {
    mode = baseMode(mode);
    if (nOpp <= 0) return 1;
    const known = new Set(hole.concat(board).map((c) => c.id));
    const deck = makeDeck(mode).filter((c) => !known.has(c.id));
    const hN = hole.length;
    const needBoard = 5 - board.length;
    const need = nOpp * hN + needBoard;
    if (need > deck.length) return 1 / (nOpp + 1);

    let total = 0;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < need; i++) {
        const k = i + Math.floor(Math.random() * (deck.length - i));
        const t = deck[i]; deck[i] = deck[k]; deck[k] = t;
      }
      const full = needBoard ? board.concat(deck.slice(0, needBoard)) : board;
      const mine = bestScore(mode, hole, full);
      let ties = 0, lost = false;
      for (let o = 0; o < nOpp; o++) {
        const start = needBoard + o * hN;
        const s = bestScore(mode, deck.slice(start, start + hN), full);
        if (s > mine) { lost = true; break; }
        if (s === mine) ties++;
      }
      if (!lost) total += 1 / (ties + 1);
    }
    return total / iters;
  }

  function cardText(c) {
    return c.j ? 'Джокер' : RANK_LABEL[c.r] + SUIT_GLYPH[c.s];
  }

  P.Cards = {
    baseMode,
    randInt,
    makeDeck,
    shuffle,
    bestScore,
    handName,
    equity,
    cardText,
    cardsText: (cards) => cards.map(cardText).join(' '),
    rankLabel: (r) => RANK_LABEL[r],
    suitGlyph: (s) => SUIT_GLYPH[s],
  };
})(window.Poker = window.Poker || {});
