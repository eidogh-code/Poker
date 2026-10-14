// Профиль игрока: ник, аватар, кошелёк, ежедневный бонус, оформление.
// Чистые функции возвращают новый профиль и не меняют исходный; хранилище — тонкая обёртка над localStorage.
(function (P) {
  'use strict';

  const KEY = 'poker.profile';
  const START_BALANCE = 10000;
  const DAILY_BONUS = 10000;
  const NICK_MAX = 16;
  const DEFAULT_NICK = 'Игрок';
  const PHOTO_MAX = 200000; // ~150 КБ картинки в base64 — с запасом для аватара 160×160
  const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

  const AVATAR_GLYPHS = ['♠', '♥', '♦', '♣', '★', '♛', '♞', '☘'];
  const FELTS = ['oxblood', 'emerald', 'sapphire', 'graphite', 'plum'];
  const BACKS = ['lattice', 'diamonds', 'deco', 'classic', 'dots'];

  const defaults = () => ({
    nick: DEFAULT_NICK,
    avatar: { kind: 'glyph', glyph: '♠', tone: 0 },
    balance: START_BALANCE,
    table: 0,
    bonusDay: '',
    felt: FELTS[0],
    back: BACKS[0],
  });

  function sanitizeNick(value) {
    const nick = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
    return nick ? Array.from(nick).slice(0, NICK_MAX).join('') : DEFAULT_NICK;
  }

  const wholeChips = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

  function normalizeAvatar(a) {
    if (a && a.kind === 'photo' && typeof a.data === 'string' && a.data.length < PHOTO_MAX && PHOTO_RE.test(a.data)) {
      return { kind: 'photo', data: a.data };
    }
    if (a && a.kind === 'glyph' && AVATAR_GLYPHS.includes(a.glyph)) {
      const tone = Number.isInteger(a.tone) && a.tone >= 0 && a.tone < AVATAR_GLYPHS.length ? a.tone : 0;
      return { kind: 'glyph', glyph: a.glyph, tone };
    }
    return defaults().avatar;
  }

  // Любые данные из хранилища приводятся к безопасному виду: повреждённое заменяется значением по умолчанию.
  function normalize(raw) {
    const base = defaults();
    if (!raw || typeof raw !== 'object') return base;
    return {
      nick: typeof raw.nick === 'string' ? sanitizeNick(raw.nick) : base.nick,
      avatar: normalizeAvatar(raw.avatar),
      balance: raw.balance === undefined ? base.balance : wholeChips(raw.balance),
      table: wholeChips(raw.table),
      bonusDay: typeof raw.bonusDay === 'string' ? raw.bonusDay : '',
      felt: FELTS.includes(raw.felt) ? raw.felt : base.felt,
      back: BACKS.includes(raw.back) ? raw.back : base.back,
    };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  const bonusAvailable = (state, now) => state.bonusDay !== dayKey(now);

  function msToNextBonus(now) {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return midnight.getTime() - now.getTime();
  }

  function claimBonus(state, now) {
    if (!bonusAvailable(state, now)) return { state, granted: 0 };
    return { state: { ...state, balance: state.balance + DAILY_BONUS, bonusDay: dayKey(now) }, granted: DAILY_BONUS };
  }

  function buyIn(state, amount) {
    const chips = wholeChips(amount);
    if (!chips || chips > state.balance) return { state, ok: false };
    return { state: { ...state, balance: state.balance - chips, table: state.table + chips }, ok: true };
  }

  // Турнир: взнос уходит в призовой фонд, фишки турнира деньгами не считаются (table не трогаем).
  function payEntry(state, amount) {
    const fee = wholeChips(amount);
    if (!fee || fee > state.balance) return { state, ok: false };
    return { state: { ...state, balance: state.balance - fee }, ok: true };
  }

  const award = (state, amount) => ({ ...state, balance: state.balance + wholeChips(amount) });

  const setTableChips = (state, chips) => ({ ...state, table: wholeChips(chips) });

  const cashOut = (state, chips) => ({ ...state, balance: state.balance + wholeChips(chips), table: 0 });

  // Если приложение закрыли посреди игры, фишки со стола возвращаются на баланс при следующем запуске.
  function recoverTable(state) {
    if (!state.table) return { state, recovered: 0 };
    return { state: cashOut(state, state.table), recovered: state.table };
  }

  /* ---------- хранилище ---------- */

  let current = null;
  const listeners = [];

  function load() {
    let raw = null;
    try {
      const text = window.localStorage.getItem(KEY);
      raw = text ? JSON.parse(text) : null;
    } catch (e) {
      raw = null; // хранилище недоступно или повреждено — начинаем с чистого профиля
    }
    current = normalize(raw);
    return current;
  }

  function get() { return current || load(); }

  function commit(next) {
    current = normalize(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(current));
    } catch (e) {
      // Не удалось сохранить — профиль живёт до закрытия приложения.
    }
    listeners.forEach((fn) => fn(current));
    return current;
  }

  // update принимает функцию «старый профиль → новый профиль» и сохраняет результат.
  const update = (fn) => commit(fn(get()));
  const subscribe = (fn) => { listeners.push(fn); };

  P.Profile = {
    START_BALANCE, DAILY_BONUS, AVATAR_GLYPHS, FELTS, BACKS,
    defaults, normalize, sanitizeNick, dayKey,
    bonusAvailable, msToNextBonus, claimBonus,
    buyIn, payEntry, award, setTableChips, cashOut, recoverTable,
    load, get, update, subscribe,
  };
})(window.Poker = window.Poker || {});
