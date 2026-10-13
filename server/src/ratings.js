// Рейтинг сетевых игроков: чистый выигрыш по раздачам за столами без ботов, где играли хотя бы двое людей.
// Хранилище — файл (локальный запуск) или Upstash Redis по REST (бесплатно и переживает перезапуски Render).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PLAYERS = 3000;          // столько записей держим; лишние вытесняются (сначала — не попавшие в таблицу)
const MIN_HANDS = 10;              // в таблицу попадают сыгравшие хотя бы столько раздач
const TOP_SIZE = 50;
const SAVE_EVERY_MS = 15 * 1000;
const LOAD_RETRY_MS = 30 * 1000;
const REDIS_PREFIX = 'poker:rating:';
const NUM_MAX = 1e12;

// Публичный id игрока — хеш секретного ключа устройства: сам ключ из сервера не уходит.
const ratingId = (deviceKey) => crypto.createHash('sha256').update(String(deviceKey)).digest('hex').slice(0, 20);

const int = (v) => (Number.isFinite(v) ? Math.max(-NUM_MAX, Math.min(NUM_MAX, Math.round(v))) : 0);
const count = (v) => Math.max(0, int(v));

// Данные из хранилища тоже проверяем: файл могли поправить руками, а Redis — другой сервис.
function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nick = typeof raw.nick === 'string' ? Array.from(raw.nick).slice(0, 16).join('') : '';
  if (!nick) return null;
  return {
    nick, profit: int(Number(raw.profit)), hands: count(Number(raw.hands)), wins: count(Number(raw.wins)),
    best: count(Number(raw.best)), at: count(Number(raw.at)),
  };
}

// Файл: один сервер, поэтому пишем снимок целиком — во временный файл и переименованием.
class FileStore {
  constructor(file) { this.file = file; }
  describe() { return `файл ${this.file}`; }

  async load() {
    try {
      return JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw e;
    }
  }

  async save({ entries }) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(Object.fromEntries(entries)));
    await fs.promises.rename(tmp, this.file);
  }
}

// Redis: при перевыкладке старый и новый сервер работают одновременно, поэтому пишем не снимок,
// а приращения (HINCRBY) — сохранения двух экземпляров складываются, а не затирают друг друга.
class UpstashStore {
  constructor(url, token, { fetchImpl = fetch } = {}) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.keys = { profit: `${REDIS_PREFIX}profit`, hands: `${REDIS_PREFIX}hands`, wins: `${REDIS_PREFIX}wins`, meta: `${REDIS_PREFIX}meta` };
  }

  describe() { return 'Upstash Redis'; }

  async pipeline(commands) {
    const res = await this.fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Upstash ответил ${res.status}`);
    const results = await res.json();
    const failed = Array.isArray(results) ? results.find((r) => r && r.error) : { error: 'неожиданный ответ' };
    if (failed) throw new Error(`Upstash: ${failed.error}`);
    return results.map((r) => r.result);
  }

  async load() {
    const k = this.keys;
    const [profit, hands, wins, meta] = await this.pipeline([k.profit, k.hands, k.wins, k.meta].map((key) => ['HGETALL', key]));
    const pairs = (flat) => {
      const out = new Map();
      for (let i = 0; Array.isArray(flat) && i + 1 < flat.length; i += 2) out.set(flat[i], flat[i + 1]);
      return out;
    };
    const p = pairs(profit);
    const h = pairs(hands);
    const w = pairs(wins);
    const data = {};
    for (const [rid, json] of pairs(meta)) {
      let m;
      try { m = JSON.parse(json); } catch (e) { continue; }
      data[rid] = { ...m, profit: p.get(rid), hands: h.get(rid), wins: w.get(rid) };
    }
    return data;
  }

  async save({ entries, deltas, evicted }) {
    const k = this.keys;
    const commands = [];
    if (evicted.size) [k.profit, k.hands, k.wins, k.meta].forEach((key) => commands.push(['HDEL', key, ...evicted]));
    for (const [rid, d] of deltas) {
      const e = entries.get(rid);
      if (!e) continue;
      if (d.profit) commands.push(['HINCRBY', k.profit, rid, String(d.profit)]);
      if (d.hands) commands.push(['HINCRBY', k.hands, rid, String(d.hands)]);
      if (d.wins) commands.push(['HINCRBY', k.wins, rid, String(d.wins)]);
      commands.push(['HSET', k.meta, rid, JSON.stringify({ nick: e.nick, best: e.best, at: e.at })]);
    }
    if (commands.length) await this.pipeline(commands);
  }
}

// Хранилище по переменным окружения: Upstash, если заданы его адрес и токен, иначе файл.
function storeFromEnv(env = process.env) {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  return new FileStore(env.RATINGS_FILE || path.join(__dirname, '..', 'data', 'ratings.json'));
}

class Ratings {
  // store = null — рейтинг живёт только в памяти (тесты); log — куда писать о загрузке и сбоях.
  constructor(store = null, { log = console, maxPlayers = MAX_PLAYERS } = {}) {
    this.store = store;
    this.log = log;
    this.maxPlayers = maxPlayers;
    this.entries = new Map();   // ratingId → { nick, profit, hands, wins, best, at }
    this.deltas = new Map();    // ratingId → { profit, hands, wins } — ещё не сохранённые приращения
    this.evicted = new Set();   // вытесненные записи, которые надо удалить и в хранилище
    this.loaded = !store;       // пока данные не прочитаны, не пишем — иначе затрём сохранённый рейтинг
    this.dirty = false;
    this.sorted = null;
    this.saving = Promise.resolve();
    this.saveTimer = null;
    this.retryTimer = null;
  }

  // Ошибка чтения не роняет сервер: копим результаты в памяти и пробуем снова, потом сливаем.
  async load() {
    if (!this.store || this.loaded) return;
    try {
      const data = await this.store.load();
      this.merge(data && typeof data === 'object' ? data : {});
      this.loaded = true;
      this.log.log(`Рейтинг загружен (${this.store.describe()}): игроков ${this.entries.size}`);
      if (this.dirty) this.markDirty();
    } catch (e) {
      this.log.error(`Рейтинг не загрузился (${this.store.describe()}), повтор через ${LOAD_RETRY_MS / 1000} с:`, e.message);
      this.retryTimer = setTimeout(() => this.load(), LOAD_RETRY_MS);
      if (this.retryTimer.unref) this.retryTimer.unref();
    }
  }

  // Записи, накопленные до загрузки, — это приросты: складываем их с сохранёнными.
  merge(data) {
    for (const [id, raw] of Object.entries(data)) {
      const saved = cleanEntry(raw);
      if (!saved) continue;
      const fresh = this.entries.get(id);
      this.entries.set(id, fresh ? {
        nick: fresh.nick, profit: saved.profit + fresh.profit, hands: saved.hands + fresh.hands,
        wins: saved.wins + fresh.wins, best: Math.max(saved.best, fresh.best), at: Math.max(saved.at, fresh.at),
      } : saved);
    }
    this.sorted = null;
    this.prune();
  }

  // Итог раздачи: [{ rid, nick, net }]. Считаем, только если людей в раздаче было хотя бы двое.
  recordHand(results) {
    if (results.length < 2) return;
    const now = Date.now();
    for (const r of results) {
      const e = this.entries.get(r.rid) || { nick: r.nick, profit: 0, hands: 0, wins: 0, best: 0, at: 0 };
      const net = int(r.net);
      const won = net > 0 ? 1 : 0;
      this.entries.set(r.rid, {
        nick: r.nick, profit: e.profit + net, hands: e.hands + 1, wins: e.wins + won, best: Math.max(e.best, net), at: now,
      });
      const d = this.deltas.get(r.rid) || { profit: 0, hands: 0, wins: 0 };
      this.deltas.set(r.rid, { profit: d.profit + net, hands: d.hands + 1, wins: d.wins + won });
    }
    this.sorted = null;
    this.prune();
    this.markDirty();
  }

  // Переполнение: сначала уходят давние записи вне таблицы (так «одноразовые» игроки не вытеснят лидеров),
  // и только потом — игроки таблицы с наименьшим выигрышем.
  prune() {
    const extra = this.entries.size - this.maxPlayers;
    if (extra <= 0) return;
    const all = [...this.entries];
    const unranked = all.filter(([, e]) => e.hands < MIN_HANDS).sort((a, b) => a[1].at - b[1].at);
    const ranked = all.filter(([, e]) => e.hands >= MIN_HANDS).sort((a, b) => a[1].profit - b[1].profit);
    [...unranked, ...ranked].slice(0, extra).forEach(([id]) => {
      this.entries.delete(id);
      this.deltas.delete(id);
      this.evicted.add(id);
    });
    this.sorted = null;
    this.dirty = true;
  }

  ranked() {
    if (!this.sorted) {
      this.sorted = [...this.entries]
        .filter(([, e]) => e.hands >= MIN_HANDS)
        .sort((a, b) => b[1].profit - a[1].profit || b[1].hands - a[1].hands || a[1].at - b[1].at);
    }
    return this.sorted;
  }

  // Таблица для игрока: топ и его собственная строка (даже если до таблицы ему ещё играть).
  board(rid) {
    const ranked = this.ranked();
    const row = (id, e, place) => ({
      place, nick: e.nick, profit: e.profit, hands: e.hands, wins: e.wins, best: e.best, me: id === rid,
    });
    const top = ranked.slice(0, TOP_SIZE).map(([id, e], i) => row(id, e, i + 1));
    const mine = this.entries.get(rid);
    const index = ranked.findIndex(([id]) => id === rid);
    const me = mine
      ? { ...row(rid, mine, index >= 0 ? index + 1 : null), needHands: Math.max(0, MIN_HANDS - mine.hands) }
      : null;
    return { top, me, total: ranked.length, minHands: MIN_HANDS };
  }

  markDirty() {
    this.dirty = true;
    if (!this.store || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_EVERY_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  // Сохранения идут строго по очереди: следующее начинается, когда закончилось предыдущее.
  flush() {
    this.saving = this.saving.then(() => this.saveOnce());
    return this.saving;
  }

  async saveOnce() {
    if (!this.store || !this.loaded || !this.dirty) return;
    const { deltas, evicted } = this;
    this.deltas = new Map();
    this.evicted = new Set();
    this.dirty = false;
    try {
      await this.store.save({ entries: this.entries, deltas, evicted });
    } catch (e) {
      // Возвращаем несохранённое в очередь — уйдёт со следующей попыткой.
      for (const [rid, d] of deltas) {
        if (!this.entries.has(rid)) continue;
        const now = this.deltas.get(rid) || { profit: 0, hands: 0, wins: 0 };
        this.deltas.set(rid, { profit: now.profit + d.profit, hands: now.hands + d.hands, wins: now.wins + d.wins });
      }
      evicted.forEach((id) => this.evicted.add(id)); // удаление идёт в хранилище раньше новых приращений
      this.log.error(`Рейтинг не сохранился (${this.store.describe()}):`, e.message);
      this.markDirty();
    }
  }

  close() {
    clearTimeout(this.saveTimer);
    clearTimeout(this.retryTimer);
    this.saveTimer = null;
  }
}

module.exports = { Ratings, FileStore, UpstashStore, storeFromEnv, ratingId, MIN_HANDS, TOP_SIZE };
