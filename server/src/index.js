// Сервер сетевой игры: HTTP для проверки здоровья + WebSocket для лобби, столов и чата.
'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');
const { Lobby, safeSend } = require('./rooms');
const V = require('./validate');

const PORT = Number(process.env.PORT) || 8787;
const MAX_PAYLOAD = 48 * 1024;            // аватар-фото (до 24 КБ) + запас
const MAX_CONN_TOTAL = 400;
const MAX_CONN_PER_IP = 8;
const HELLO_TIMEOUT_MS = 10000;           // кто не представился за 10 с — отключаем
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 60;                       // сообщений за окно с одного соединения
const RATE_KICK = RATE_MAX * 3;            // явный флуд — закрываем соединение
const CHAT_GAP_MS = 700;                   // не чаще одного сообщения в чат
const CREATE_GAP_MS = 10000;               // не чаще одного нового стола в 10 с
const HEARTBEAT_MS = 25000;
const SESSION_IDLE_MS = 10 * 60 * 1000;

// Адрес клиента: за прокси хостинга — первый адрес из X-Forwarded-For, иначе адрес сокета.
const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

function createServer() {
  const lobby = new Lobby();
  const perIp = new Map();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(req.url === '/health' ? 'ok' : 'Сервер игры «Покер». Подключайтесь из приложения.');
  });

  const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

  wss.on('connection', (ws, req) => {
    const ip = ipOf(req);
    if (wss.clients.size > MAX_CONN_TOTAL || (perIp.get(ip) || 0) >= MAX_CONN_PER_IP) {
      ws.close(1013, 'busy');
      return;
    }
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const conn = { ws, ip, session: null, alive: true, windowStart: Date.now(), count: 0, lastChat: 0 };
    ws.__conn = conn;
    conn.helloTimer = setTimeout(() => { if (!conn.session) ws.close(1008, 'hello timeout'); }, HELLO_TIMEOUT_MS);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data) => {
      try {
        onMessage(lobby, conn, data);
      } catch (e) {
        console.error(`[${ip}] ошибка обработки сообщения:`, e);
        ws.terminate();
      }
    });
    ws.on('close', () => {
      clearTimeout(conn.helloTimer);
      const left = (perIp.get(ip) || 1) - 1;
      if (left) perIp.set(ip, left); else perIp.delete(ip);
      onClose(lobby, conn);
    });
    ws.on('error', () => ws.terminate());
  });

  // Пинг раз в 25 с: мёртвые соединения (телефон уснул, сеть пропала) закрываются; заодно уборка.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = ws.__conn;
      if (!conn) continue;
      if (!conn.alive) { ws.terminate(); continue; }
      conn.alive = false;
      ws.ping();
    }
    lobby.sweep(SESSION_IDLE_MS);
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return { server, wss, lobby, close: () => { clearInterval(heartbeat); wss.close(); server.close(); } };
}

const send = (ws, msg) => safeSend(ws, JSON.stringify(msg));
const fail = (ws, msg) => send(ws, { t: 'error', msg });

function rateLimited(conn) {
  const now = Date.now();
  if (now - conn.windowStart > RATE_WINDOW_MS) { conn.windowStart = now; conn.count = 0; }
  conn.count++;
  if (conn.count > RATE_KICK) { console.warn(`[${conn.ip}] флуд — соединение закрыто`); conn.ws.terminate(); return true; }
  return conn.count > RATE_MAX;
}

function onMessage(lobby, conn, data) {
  const ws = conn.ws;
  conn.alive = true;
  if (rateLimited(conn)) { fail(ws, 'Слишком много сообщений, подождите немного'); return; }
  let msg;
  try { msg = JSON.parse(String(data)); } catch (e) { fail(ws, 'Не удалось прочитать сообщение'); return; }
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'hello') { hello(lobby, conn, msg); return; }
  const session = conn.session;
  if (!session) { fail(ws, 'Сначала представьтесь'); return; }
  if (session.ws !== ws) return; // соединение вытеснено другим устройством — больше не управляет сессией
  session.lastSeen = Date.now();
  const room = lobby.roomOf(session);
  if (room) room.touch();

  switch (msg.t) {
    case 'list': send(ws, { t: 'rooms', rooms: lobby.list() }); break;
    case 'create': {
      const now = Date.now();
      if (now - (session.lastCreate || 0) < CREATE_GAP_MS) { fail(ws, 'Новый стол можно создавать не чаще раза в 10 секунд'); break; }
      const settings = V.roomSettings(msg.settings, session.nick);
      const check = lobby.canCreate(settings);
      if (check) { fail(ws, check); break; }
      session.lastCreate = now;
      if (room) room.leave(session, 'switch');
      lobby.create(session, settings);
      break;
    }
    case 'join': {
      const code = V.code(msg.code);
      if (!code) { fail(ws, 'Код комнаты — 6 букв и цифр'); break; }
      if (room && room.code === code) break;
      // Сначала проверяем, что за целевым столом есть место, и только потом уходим из текущего.
      const check = lobby.canJoin(code);
      if (check) { fail(ws, check); break; }
      if (room) room.leave(session, 'switch');
      const result = lobby.join(session, code);
      if (result.error) fail(ws, result.error);
      break;
    }
    case 'leave': if (room) room.leave(session, 'self'); break;
    case 'start': if (room) { const err = room.start(session); if (err) fail(ws, err); } break;
    case 'act': { const action = V.action(msg.action); if (room && action) room.act(session, action); break; }
    case 'return': if (room) room.returnToTable(session); break;
    case 'rebuy': if (room) room.answerRebuy(session, msg.accept === true); break;
    case 'chat': {
      const text = V.chat(msg.text);
      if (!room || !text) break;
      const now = Date.now();
      if (now - conn.lastChat < CHAT_GAP_MS) { fail(ws, 'Не так быстро — сообщения в чат не чаще раза в секунду'); break; }
      conn.lastChat = now;
      room.chatFrom(session, text);
      break;
    }
    default: break;
  }
}

// Знакомство — один раз на соединение. Секретный ключ связывает переподключения с тем же местом за столом.
function hello(lobby, conn, msg) {
  if (conn.session) { fail(conn.ws, 'Вы уже представились'); return; }
  const key = V.key(msg.key);
  if (!key) { fail(conn.ws, 'Неверный ключ клиента'); conn.ws.close(1008, 'bad key'); return; }
  clearTimeout(conn.helloTimer);
  const session = lobby.session(key);
  if (session.ws && session.ws !== conn.ws) {
    send(session.ws, { t: 'replaced' });
    session.ws.close();
  }
  session.ws = conn.ws;
  session.nick = V.nick(msg.nick);
  session.avatar = V.avatar(msg.avatar);
  session.lastSeen = Date.now();
  conn.session = session;
  // Уход, случившийся без связи (выбыл по таймеру, комнату распустили), доставляем первым делом.
  if (session.pendingLeft) { send(conn.ws, session.pendingLeft); session.pendingLeft = null; }
  const room = lobby.roomOf(session);
  send(conn.ws, { t: 'welcome', id: session.id, room: room ? room.code : null });
  if (room) room.reconnected(session);
}

function onClose(lobby, conn) {
  const session = conn.session;
  if (!session || session.ws !== conn.ws) return;
  session.ws = null;
  session.lastSeen = Date.now();
  const room = lobby.roomOf(session);
  if (room) room.disconnected(session);
}

if (require.main === module) {
  // Последний рубеж: ошибка в одной комнате не должна ронять сервер со всеми остальными столами.
  process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
  const { server } = createServer();
  server.listen(PORT, () => console.log(`Покер-сервер слушает порт ${PORT}`));
}

module.exports = { createServer };
