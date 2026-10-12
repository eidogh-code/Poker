// Проверка всего, что приходит от клиентов. Ничему не доверяем: строки чистим, числа сверяем со списками.
'use strict';

const LIMITS = {
  NICK_MAX: 16,
  ROOM_NAME_MAX: 24,
  CHAT_MAX: 200,
  PHOTO_MAX: 24000, // аватар 160×160 в JPEG — около 10–20 КБ в base64
};
const MODES = ['holdem', 'omaha', 'joker', 'short'];
const BUY_INS = [500, 1000, 2000, 5000];
const LEVELS = [0, 1, 3];
const GLYPHS = ['♠', '♥', '♦', '♣', '★', '♛', '♞', '☘'];
const ACTIONS = ['fold', 'check', 'call', 'raise'];
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
// Сигнатура настоящей картинки в начале base64: JPEG, PNG или WebP.
const PHOTO_MAGIC = /^data:image\/(?:jpeg;base64,\/9j\/|png;base64,iVBORw0KGgo|webp;base64,UklGR)/;
const MEANINGFUL = /[\p{L}\p{N}]/u;
const INVISIBLE_RE = new RegExp('[\\u2800\\u3164\\u115F\\u1160\\uFFA0\\u034F\\u2060-\\u2064\\u180E]', 'g'); // «пустые» буквы, которые выглядят как пробел
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CODE_RE = /^[A-Z0-9]{6}$/;
const CONTROL_RE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069]', 'g');

// Убираем управляющие и «невидимые» символы, схлопываем пробелы, режем по длине в символах (не в байтах).
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_RE, '').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('');
}

// Ник и название обязаны содержать хоть одну букву или цифру — «невидимые» имена не проходят.
const meaningful = (text) => (MEANINGFUL.test(text) ? text : '');
const nick = (v) => meaningful(cleanText(v, LIMITS.NICK_MAX)) || 'Игрок';
const roomName = (v, fallback) => meaningful(cleanText(v, LIMITS.ROOM_NAME_MAX)) || fallback;
const chat = (v) => cleanText(v, LIMITS.CHAT_MAX) || null;
const key = (v) => (typeof v === 'string' && KEY_RE.test(v) ? v : null);
const code = (v) => {
  const c = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return CODE_RE.test(c) ? c : null;
};

function avatar(a) {
  if (a && a.kind === 'photo' && typeof a.data === 'string' && a.data.length < LIMITS.PHOTO_MAX
    && PHOTO_RE.test(a.data) && PHOTO_MAGIC.test(a.data)) {
    return { kind: 'photo', data: a.data };
  }
  if (a && a.kind === 'glyph' && GLYPHS.includes(a.glyph)) {
    const tone = Number.isInteger(a.tone) && a.tone >= 0 && a.tone < GLYPHS.length ? a.tone : 0;
    return { kind: 'glyph', glyph: a.glyph, tone };
  }
  return { kind: 'glyph', glyph: '♠', tone: 0 };
}

function roomSettings(raw, hostNick) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    name: roomName(r.name, `Стол ${hostNick}`),
    visibility: r.visibility === 'closed' ? 'closed' : 'open',
    mode: MODES.includes(r.mode) ? r.mode : 'holdem',
    buyIn: BUY_INS.includes(r.buyIn) ? r.buyIn : 1000,
    level: LEVELS.includes(r.level) ? r.level : 1,
    blindUp: r.blindUp !== false,
    bots: r.bots === true,
  };
}

function action(a) {
  if (!a || typeof a !== 'object' || !ACTIONS.includes(a.type)) return null;
  const out = { type: a.type };
  if (a.type === 'raise') {
    const to = Number(a.to);
    if (!Number.isFinite(to) || to <= 0 || to > 1e9) return null;
    out.to = Math.round(to);
  }
  return out;
}

module.exports = { LIMITS, MODES, BUY_INS, cleanText, nick, roomName, chat, key, code, avatar, roomSettings, action };
