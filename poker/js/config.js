// Настройки сборки. serverUrl — адрес сервера сетевой игры (wss://…).
// Игрок может указать другой сервер вручную в лобби — тогда используется он.
(function (P) {
  'use strict';
  P.Config = {
    serverUrl: 'wss://poker-server-s356.onrender.com',
  };
})(window.Poker = window.Poker || {});
