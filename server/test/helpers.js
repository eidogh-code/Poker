// Общее для сквозных тестов: локальный сервер и WebSocket-клиент с почтовым ящиком.
'use strict';

const WebSocket = require('ws');
const { createServer } = require('../src/index');

async function startServer(options) {
  const srv = createServer(options);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  return { srv, port: srv.server.address().port };
}

let keySeq = 0;
const newKey = () => `test-key-${Date.now()}-${++keySeq}-abcdef`;

// Клиент с почтовым ящиком: next(pred) ждёт первое подходящее сообщение (в том числе уже пришедшее).
async function connectClient(port, nick, key = newKey()) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = new Set();
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    inbox.push(m);
    for (const w of [...waiters]) w(m);
  });
  await new Promise((r) => ws.on('open', r));
  const c = {
    ws, key, inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    next: (pred, ms = 8000) => new Promise((resolve, reject) => {
      const found = inbox.find(pred);
      if (found) { inbox.splice(inbox.indexOf(found), 1); resolve(found); return; }
      const timer = setTimeout(() => { waiters.delete(w); reject(new Error(`timeout waiting in ${nick}`)); }, ms);
      const w = (m) => {
        if (!pred(m)) return;
        clearTimeout(timer);
        waiters.delete(w);
        inbox.splice(inbox.indexOf(m), 1);
        resolve(m);
      };
      waiters.add(w);
    }),
    // Закрыть и дождаться, пока сервер это заметит (лимит соединений с одного адреса).
    close: () => new Promise((r) => {
      if (ws.readyState === WebSocket.CLOSED) { r(); return; }
      ws.once('close', r);
      ws.close();
    }),
  };
  c.send({ t: 'hello', key, nick, avatar: { kind: 'glyph', glyph: '♥', tone: 1 } });
  const welcome = await c.next((m) => m.t === 'welcome');
  c.id = welcome.id;
  c.boot = welcome.boot;
  return c;
}

// Автоигра: на каждый свой ход клиент отвечает действием pick(limits).
function autoPlay(c, pick) {
  const onMsg = (data) => {
    const m = JSON.parse(String(data));
    if (m.t === 'turn') c.send({ t: 'act', action: pick(m.limits) });
  };
  c.ws.on('message', onMsg);
  return () => c.ws.off('message', onMsg);
}

const roomMsg = (m) => m.t === 'room';

module.exports = { startServer, connectClient, autoPlay, roomMsg };
