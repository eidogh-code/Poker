// Заставка с логотипом студии: медленно проявляется, держится и так же медленно гаснет. Касание — пропустить.
(function () {
  'use strict';

  const FADE_IN_MS = 1600;
  const HOLD_MS = 1400;
  const FADE_OUT_MS = 1600;

  function run() {
    const splash = document.getElementById('splash');
    if (!splash) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scale = reduced ? 0.4 : 1;
    let finished = false;
    const timers = [];
    // Пока идёт заставка, меню под ней недоступно ни для клавиатуры, ни для скринридера.
    const behind = Array.from(document.body.children).filter((el) => el !== splash && el.tagName !== 'SCRIPT');
    behind.forEach((el) => { el.inert = true; });

    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      splash.remove();
      behind.forEach((el) => { el.inert = false; });
      document.body.classList.remove('splashing');
    };
    const fadeOut = () => {
      splash.style.setProperty('--fade-ms', `${FADE_OUT_MS * scale}ms`);
      splash.classList.remove('shown');
      timers.push(setTimeout(finish, FADE_OUT_MS * scale));
    };

    splash.style.setProperty('--fade-ms', `${FADE_IN_MS * scale}ms`);
    // Логотип загружается до начала проявления — иначе анимация пройдёт по пустому экрану.
    const logo = splash.querySelector('img');
    const start = () => {
      requestAnimationFrame(() => splash.classList.add('shown'));
      timers.push(setTimeout(fadeOut, (FADE_IN_MS + HOLD_MS) * scale));
    };
    if (logo.complete) start(); else { logo.addEventListener('load', start); logo.addEventListener('error', finish); }
    splash.addEventListener('pointerdown', fadeOut, { once: true });
  }

  document.addEventListener('DOMContentLoaded', run);
})();
