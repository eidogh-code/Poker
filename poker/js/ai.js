// Решения ботов: шансы на победу + характер (свобода входа, агрессия, блеф).
(function (P) {
  'use strict';

  const ITERS = { holdem: 260, omaha: 120, joker: 170, short: 260, aof: 260, aofomaha: 120 };
  const SHOVE_SHARE = 0.7; // если ставка съедает больше 70% стека — проще пойти ва-банк

  function clampTo(L, to) {
    return Math.max(L.minTo, Math.min(L.maxTo, Math.round(to)));
  }

  function raise(g, p, L, frac) {
    let to = clampTo(L, g.maxBet + frac * (L.potAll + L.toCallFull));
    if (to > L.stackTo * SHOVE_SHARE) to = L.maxTo;
    return { type: 'raise', to };
  }

  // AoF: первым — пойти ва-банк с рукой лучше средней (порог ниже у азартных),
  // против чужого ва-банка — уравнять, если шансы выше цены колла.
  function decideAof(g, p, L, eq, opps) {
    const pers = p.persona;
    const noise = (Math.random() - 0.5) * 0.08;
    // Ва-банк соперника — даже короткий, на большой блайнд или меньше, — уже не «открытие».
    const facingShove = g.maxBet > g.bb || g.players.some((o) => o !== p && o.allIn && !o.folded);
    let play;
    if (!facingShove) {
      const fair = 1 / (opps + 1);
      play = eq + noise > fair * (1.3 - pers.loose * 0.35 - pers.aggr * 0.15);
    } else {
      const odds = L.toCall / (L.potAll + L.toCall);
      play = eq + noise > odds * (1.15 - pers.loose * 0.3);
    }
    if (!play) return { type: L.toCallFull > 0 ? 'fold' : 'check' };
    return { type: 'allin' };
  }

  function decide(g, p) {
    const L = g.limits(p);
    const opps = g.players.filter((o) => o !== p && !o.folded && !o.out).length;
    if (opps === 0) return { type: L.toCallFull ? 'call' : 'check' };

    const eq = P.Cards.equity(g.mode, p.hole, g.board, opps, ITERS[g.mode]);
    if (g.aof) return decideAof(g, p, L, eq, opps);
    const pers = p.persona;
    const rnd = Math.random;
    const pre = g.street === 'preflop';
    const strength = eq * (opps + 1) + (rnd() - 0.5) * 0.25 + (pers.loose - 0.5) * 0.3;

    if (L.toCallFull === 0) {
      if (L.canRaise) {
        if (strength > 1.7 && rnd() < 0.55 + pers.aggr * 0.4) return raise(g, p, L, 0.55 + rnd() * 0.45);
        if (strength > 1.25 && rnd() < pers.aggr * 0.7) return raise(g, p, L, 0.4 + rnd() * 0.25);
        if (!pre && rnd() < pers.bluff * 0.55) return raise(g, p, L, 0.5);
      }
      return { type: 'check' };
    }

    const odds = L.toCallFull / (L.potAll + L.toCallFull);
    const need = odds * (pre ? 0.75 : 1) * (1.05 - pers.loose * 0.45);
    if (eq < need && strength < 1.3) {
      if (L.canRaise && !pre && rnd() < pers.bluff * 0.18) return raise(g, p, L, 0.75);
      return { type: 'fold' };
    }
    if (L.canRaise && strength > 1.9 && rnd() < 0.35 + pers.aggr * 0.5) return raise(g, p, L, 0.6 + rnd() * 0.5);

    const callIsAllIn = L.toCallFull >= p.chips;
    if (callIsAllIn && eq < 0.45 && strength < 1.6 && rnd() > pers.loose * 0.5) return { type: 'fold' };
    return { type: 'call' };
  }

  P.AI = { decide };
})(window.Poker = window.Poker || {});
