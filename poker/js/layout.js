// Геометрия мест за столом: где стоят игроки, их ставки и кнопка дилера (в процентах от .table).
// Три раскладки: обычный альбом, низкий альбомный телефон (max-height: 560px) и портрет (телефон вертикально).
(function (P) {
  'use strict';

  const compactQuery = window.matchMedia('(max-height: 560px)');
  const portraitQuery = window.matchMedia('(orientation: portrait)');

  const isPortrait = () => portraitQuery.matches;
  // Компактный альбом: низкий экран, лежащий на боку. В портрете своя раскладка, поэтому там false.
  const isCompact = () => compactQuery.matches && !portraitQuery.matches;

  /* ---------- альбом: места по эллипсу, человек снизу ---------- */

  function landscapeGeometry(i, n, human) {
    const a = ((90 + (i * 360) / n) * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const compact = compactQuery.matches;
    return {
      x: 50 + 47 * cos,
      y: human ? (compact ? 85 : 100) : 50 + 47 * sin,
      bx: human ? (compact ? 25 : 35) : 50 + 30 * cos,
      by: human ? (compact ? 74 : 82) : 50 + 29 * sin,
      dx: human ? (compact ? 75 : 64) : 50 + 37 * cos + 4 * Math.sign(cos || 1),
      dy: human ? (compact ? 74 : 82) : 50 + 36 * sin,
      upper: sin < -0.3,
    };
  }

  /* ---------- портрет: высокий стол, шесть фиксированных мест ---------- */

  // Середина стола по высоте занята банком и общими картами (примерно 35–61 %), поэтому
  // верхние боковые места стоят над этой полосой, а нижние — по бокам от своих карт человека.
  // Ставки лежат в свободных просветах: сверху — между местами, снизу — между картами и местами.
  // Левые места заданы явно, правые — их зеркальное отражение.
  const LEFT_SLOTS = {
    bottom: { x: 50, y: 100, bx: 50, by: 66.5, dx: 29, dy: 71, upper: false },
    lowerLeft: { x: 16, y: 77, bx: 24, by: 65, dx: 8.5, dy: 65, upper: false },
    upperLeft: { x: 16, y: 22.5, bx: 38.5, by: 26, dx: 31, dy: 15, upper: false },
    top: { x: 50, y: 8.5, bx: 50, by: 20, dx: 32, dy: 7.5, upper: true },
  };
  const mirror = (s) => ({ ...s, x: 100 - s.x, bx: 100 - s.bx, dx: 100 - s.dx });
  const PORTRAIT_SLOTS = {
    ...LEFT_SLOTS,
    upperRight: mirror(LEFT_SLOTS.upperLeft),
    lowerRight: mirror(LEFT_SLOTS.lowerLeft),
  };

  // Порядок мест по часовой стрелке от человека; при неполном столе — самые свободные места.
  const PORTRAIT_ORDER = {
    2: ['bottom', 'top'],
    3: ['bottom', 'upperLeft', 'upperRight'],
    4: ['bottom', 'upperLeft', 'top', 'upperRight'],
    5: ['bottom', 'lowerLeft', 'upperLeft', 'upperRight', 'lowerRight'],
    6: ['bottom', 'lowerLeft', 'upperLeft', 'top', 'upperRight', 'lowerRight'],
  };

  // Больше шести мест игра не создаёт, но на всякий случай — вытянутый эллипс.
  function portraitEllipse(i, n) {
    const a = ((90 + (i * 360) / n) * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return {
      x: 50 + 33 * cos,
      y: 50 + 42 * sin,
      bx: 50 + 21 * cos,
      by: 50 + 30 * sin,
      dx: 50 + 27 * cos,
      dy: 50 + 36 * sin - 6,
      upper: sin < -0.9,
    };
  }

  function portraitGeometry(i, n, human) {
    if (human) return { ...PORTRAIT_SLOTS.bottom };
    const order = PORTRAIT_ORDER[n];
    const slot = order && order[i];
    return slot ? { ...PORTRAIT_SLOTS[slot] } : portraitEllipse(i, n);
  }

  /* ---------- API ---------- */

  // i — индекс места (0 — человек), n — число мест, human — место человека (всегда снизу).
  function seatGeometry(i, n, human) {
    return isPortrait() ? portraitGeometry(i, n, human) : landscapeGeometry(i, n, human);
  }

  // Подписка на поворот экрана и смену компактности. Возвращает функцию отписки.
  // При повороте меняются сразу оба условия — fn вызывается один раз на фактическую смену раскладки.
  function onChange(fn) {
    let last = `${isPortrait()}|${isCompact()}`;
    const handler = () => {
      const state = { portrait: isPortrait(), compact: isCompact() };
      const key = `${state.portrait}|${state.compact}`;
      if (key === last) return;
      last = key;
      fn(state);
    };
    const queries = [portraitQuery, compactQuery];
    queries.forEach((q) => {
      if (q.addEventListener) q.addEventListener('change', handler);
      else q.addListener(handler); // старые WebView без addEventListener у MediaQueryList
    });
    return () => queries.forEach((q) => {
      if (q.removeEventListener) q.removeEventListener('change', handler);
      else q.removeListener(handler);
    });
  }

  P.Layout = { seatGeometry, isPortrait, isCompact, onChange };
})(window.Poker = window.Poker || {});
