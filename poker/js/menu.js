// Главное меню: профиль, баланс, ежедневный бонус, окна «Профиль» и «Оформление».
(function (P) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Number(n).toLocaleString('ru-RU');
  const Profile = P.Profile;
  const PHOTO_SIZES = [160, 128, 96];
  const PHOTO_QUALITIES = [0.85, 0.7, 0.55];
  const PHOTO_NET_MAX = 22000; // сервер принимает аватар до 24000 символов base64
  const BONUS_REFRESH_MS = 30 * 1000;

  const FELT_NAMES = { oxblood: 'Бордо', emerald: 'Изумруд', sapphire: 'Сапфир', graphite: 'Графит', plum: 'Слива' };
  const BACK_NAMES = { lattice: 'Решётка', diamonds: 'Ромбы', deco: 'Ар-деко', classic: 'Классика', dots: 'Горох' };

  const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // Аватар: фото (уже проверено Profile.normalize — только data:image в base64) или символ в цветном круге.
  function avatarMarkup(avatar, extraClass) {
    const cls = `avatar${extraClass ? ' ' + extraClass : ''}`;
    if (avatar && avatar.kind === 'photo') return `<span class="${cls} photo" style="background-image:url(${avatar.data})"></span>`;
    const a = avatar && avatar.kind === 'glyph' ? avatar : Profile.defaults().avatar;
    return `<span class="${cls} av-${a.tone}">${escapeHTML(a.glyph)}</span>`;
  }

  function setAvatar(el, avatar) {
    el.outerHTML = avatarMarkup(avatar, el.classList.contains('big') ? 'big' : '').replace('<span ', `<span id="${el.id}" aria-hidden="true" `);
  }

  function formatWait(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h} ч ${m} мин` : `${m} мин`;
  }

  /* ---------- карточка профиля и бонус ---------- */

  function renderProfile() {
    const p = Profile.get();
    setAvatar($('#me-avatar'), p.avatar);
    $('#me-nick').textContent = p.nick;
    $('#me-balance').textContent = `Баланс ${fmt(p.balance)}`;
    renderBonus();
    syncBuyIns();
  }

  function renderBonus() {
    const now = new Date();
    const btn = $('#btn-bonus');
    const ready = Profile.bonusAvailable(Profile.get(), now);
    btn.disabled = !ready;
    btn.textContent = ready ? `Бонус +${fmt(Profile.DAILY_BONUS)}` : `Бонус через ${formatWait(Profile.msToNextBonus(now))}`;
  }

  function claimBonus() {
    let granted = 0;
    Profile.update((p) => {
      const result = Profile.claimBonus(p, new Date());
      granted = result.granted;
      return result.state;
    });
    if (granted) {
      P.Sound.play('win');
      showNote(`Начислено ${fmt(granted)}. Следующий бонус — завтра.`);
    }
    return granted;
  }

  // Взносы дороже баланса недоступны; если выбранный стал недоступен — берём самый крупный доступный.
  function syncBuyIns() {
    const balance = Profile.get().balance;
    const inputs = Array.from(document.querySelectorAll('input[name="stack"]'));
    inputs.forEach((input) => { input.disabled = Number(input.value) > balance; });
    const checked = inputs.find((i) => i.checked);
    if (checked && checked.disabled) {
      const affordable = inputs.filter((i) => !i.disabled);
      if (affordable.length) affordable[affordable.length - 1].checked = true;
    }
  }

  function showNote(text) {
    const note = $('#setup-note');
    note.textContent = text;
    note.hidden = !text;
  }

  /* ---------- окно «Профиль» ---------- */

  let draftAvatar = null;

  function renderGlyphs() {
    $('#pf-glyphs').innerHTML = Profile.AVATAR_GLYPHS.map((glyph, tone) => {
      const checked = draftAvatar.kind === 'glyph' && draftAvatar.glyph === glyph ? ' checked' : '';
      return `<label class="glyph"><input type="radio" name="pf-glyph" value="${tone}"${checked}>${avatarMarkup({ kind: 'glyph', glyph, tone })}</label>`;
    }).join('');
  }

  function renderPreview() { setAvatar($('#pf-preview'), draftAvatar); }

  function openProfile() {
    const p = Profile.get();
    draftAvatar = p.avatar;
    $('#pf-nick').value = p.nick;
    $('#pf-photo-error').hidden = true;
    renderGlyphs();
    renderPreview();
    $('#dlg-profile').showModal();
  }

  // Сжимаем, пока фото не влезет в лимит сервера: его рассылают всем за столом.
  function encodePhoto(img) {
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    let data = '';
    for (const size of PHOTO_SIZES) {
      canvas.width = size;
      canvas.height = size;
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      for (const quality of PHOTO_QUALITIES) {
        data = canvas.toDataURL('image/jpeg', quality);
        if (data.length <= PHOTO_NET_MAX) return data;
      }
    }
    return data;
  }

  // Фото обрезается по центру в квадрат и уменьшается до 160×160 — в хранилище лежит пара десятков килобайт.
  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('Выберите картинку: JPG, PNG или WebP.')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(encodePhoto(img));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не получилось открыть эту картинку. Попробуйте другую.')); };
      img.src = url;
    });
  }

  async function onPhotoPicked(e) {
    const err = $('#pf-photo-error');
    err.hidden = true;
    try {
      const data = await readPhoto(e.target.files && e.target.files[0]);
      const avatar = Profile.normalize({ avatar: { kind: 'photo', data } }).avatar;
      if (avatar.kind !== 'photo') throw new Error('Картинка слишком большая. Попробуйте другую.');
      draftAvatar = avatar;
      renderGlyphs();
      renderPreview();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      e.target.value = '';
    }
  }

  // Сохраняем по отправке формы: она приходит сразу и знает нажатую кнопку, а событие close может запаздывать.
  function onProfileSubmit(e) {
    if (!e.submitter || e.submitter.value !== 'save') return;
    const nick = Profile.sanitizeNick($('#pf-nick').value);
    Profile.update((p) => ({ ...p, nick, avatar: draftAvatar }));
  }

  /* ---------- окно «Оформление» ---------- */

  function applyLook(p) {
    document.body.dataset.felt = p.felt;
    document.body.dataset.back = p.back;
  }

  function renderLook() {
    const p = Profile.get();
    $('#look-felts').innerHTML = Profile.FELTS.map((felt) => `
      <label class="swatch"><input type="radio" name="look-felt" value="${felt}"${p.felt === felt ? ' checked' : ''}>
        <span class="swatch-felt" data-felt="${felt}" aria-hidden="true"></span><span>${FELT_NAMES[felt]}</span></label>`).join('');
    $('#look-backs').innerHTML = Profile.BACKS.map((back) => `
      <label class="swatch"><input type="radio" name="look-back" value="${back}"${p.back === back ? ' checked' : ''}>
        <span class="swatch-back" data-back="${back}" aria-hidden="true"><span class="card back"></span></span><span>${BACK_NAMES[back]}</span></label>`).join('');
  }

  function onLookChanged(e) {
    const { name, value } = e.target;
    if (name === 'look-felt') Profile.update((p) => ({ ...p, felt: value }));
    if (name === 'look-back') Profile.update((p) => ({ ...p, back: value }));
  }

  /* ---------- запуск ---------- */

  function init() {
    Profile.load();
    const { recovered } = Profile.recoverTable(Profile.get());
    if (recovered) Profile.update((p) => Profile.recoverTable(p).state);

    Profile.subscribe((p) => { applyLook(p); renderProfile(); });
    applyLook(Profile.get());
    renderProfile();
    if (recovered) showNote(`Фишки с прошлого стола — ${fmt(recovered)} — вернулись на баланс.`);

    $('#btn-bonus').addEventListener('click', claimBonus);
    $('#btn-profile').addEventListener('click', openProfile);
    $('#btn-look').addEventListener('click', () => { renderLook(); $('#dlg-look').showModal(); });
    $('#pf-photo').addEventListener('change', onPhotoPicked);
    $('#pf-glyphs').addEventListener('change', (e) => {
      const tone = Number(e.target.value);
      draftAvatar = { kind: 'glyph', glyph: Profile.AVATAR_GLYPHS[tone], tone };
      renderPreview();
    });
    $('#profile-form').addEventListener('submit', onProfileSubmit);
    $('#look-form').addEventListener('change', onLookChanged);
    setInterval(renderBonus, BONUS_REFRESH_MS);
  }

  P.Menu = { init, refresh: renderProfile, avatarMarkup, escapeHTML, showNote, claimBonus, syncBuyIns };
})(window.Poker = window.Poker || {});
