// Подключает игровой движок клиента (poker/js) на сервере: правила онлайн и офлайн — один и тот же код.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// В Docker-образе движок лежит рядом (ENGINE_DIR), в репозитории — в ../../poker/js.
const ENGINE_DIR = process.env.ENGINE_DIR || path.join(__dirname, '..', '..', 'poker', 'js');
const FILES = ['cards.js', 'ai.js', 'game.js'];

function loadEngine() {
  const context = vm.createContext({
    window: { crypto: webcrypto },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, Error, Set, Map, Array, Object, Number, String, Uint32Array,
  });
  for (const file of FILES) {
    const code = fs.readFileSync(path.join(ENGINE_DIR, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context.window.Poker;
}

// Один экземпляр движка на процесс: им пользуются и комнаты, и проверка ввода.
const P = loadEngine();

module.exports = { loadEngine, P };
