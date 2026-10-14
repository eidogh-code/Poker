// Тесты профиля и кошелька: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../poker/js/profile.js', import.meta.url), 'utf8');
const context = { window: {}, Date, Math, JSON, Number, String, Object, Array, RegExp };
vm.runInNewContext(source, context);
const Profile = context.window.Poker.Profile;

const day = (iso) => new Date(iso);

test('новый профиль: 10 000 на балансе, ник «Игрок», аватар-пика', () => {
  const p = Profile.defaults();
  assert.equal(p.balance, 10000);
  assert.equal(p.nick, 'Игрок');
  assert.equal(p.avatar.kind, 'glyph');
  assert.equal(p.table, 0);
});

test('ник: обрезка пробелов, не длиннее 16 символов, пустой — «Игрок»', () => {
  assert.equal(Profile.sanitizeNick('  Макс   Пэйн  '), 'Макс Пэйн');
  assert.equal(Profile.sanitizeNick('Очень-очень-длинный-ник'), 'Очень-очень-длин');
  assert.equal(Profile.sanitizeNick('   '), 'Игрок');
  assert.equal(Profile.sanitizeNick(undefined), 'Игрок');
});

test('ежедневный бонус: раз в календарный день', () => {
  const start = Profile.defaults();
  const first = Profile.claimBonus(start, day('2026-10-12T09:00:00'));
  assert.equal(first.granted, 10000);
  assert.equal(first.state.balance, 20000);
  assert.equal(start.balance, 10000, 'исходный профиль не меняется');

  const again = Profile.claimBonus(first.state, day('2026-10-12T23:59:00'));
  assert.equal(again.granted, 0);
  assert.equal(again.state.balance, 20000);
  assert.equal(Profile.bonusAvailable(first.state, day('2026-10-12T23:59:00')), false);

  const tomorrow = Profile.claimBonus(first.state, day('2026-10-13T00:01:00'));
  assert.equal(tomorrow.granted, 10000);
  assert.equal(tomorrow.state.balance, 30000);
});

test('до следующего бонуса — время до полуночи', () => {
  assert.equal(Profile.msToNextBonus(day('2026-10-12T23:00:00')), 60 * 60 * 1000);
});

test('взнос за стол списывается с баланса и не уходит в минус', () => {
  const p = Profile.defaults();
  const ok = Profile.buyIn(p, 2000);
  assert.equal(ok.ok, true);
  assert.equal(ok.state.balance, 8000);
  assert.equal(ok.state.table, 2000);

  const tooMuch = Profile.buyIn(ok.state, 9000);
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.state.balance, 8000);
});

test('уход из-за стола возвращает фишки на баланс', () => {
  const seated = Profile.buyIn(Profile.defaults(), 1000).state;
  const playing = Profile.setTableChips(seated, 2500);
  const left = Profile.cashOut(playing, 2500);
  assert.equal(left.balance, 11500);
  assert.equal(left.table, 0);
});

test('фишки незакрытого стола возвращаются при следующем запуске', () => {
  const crashed = Profile.setTableChips(Profile.buyIn(Profile.defaults(), 1000).state, 1800);
  const { state, recovered } = Profile.recoverTable(crashed);
  assert.equal(recovered, 1800);
  assert.equal(state.balance, 10800);
  assert.equal(state.table, 0);
  assert.equal(Profile.recoverTable(state).recovered, 0);
});

test('повреждённые данные заменяются значениями по умолчанию', () => {
  const p = Profile.normalize({ balance: -5, nick: 42, felt: 'неон', back: null, avatar: { kind: 'photo', data: 'javascript:alert(1)' } });
  assert.equal(p.balance, 0);
  assert.equal(p.nick, 'Игрок');
  assert.equal(p.felt, 'oxblood');
  assert.equal(p.back, 'lattice');
  assert.equal(p.avatar.kind, 'glyph', 'небезопасная картинка отброшена');
});

test('фото-аватар принимается только как data:image в base64', () => {
  const data = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  assert.equal(Profile.normalize({ avatar: { kind: 'photo', data } }).avatar.data, data);
});

test('турнирный взнос списывается с баланса, не трогая стол; приз зачисляется', () => {
  const p = { ...Profile.defaults(), balance: 3000, table: 0 };
  const paid = Profile.payEntry(p, 1000);
  assert.ok(paid.ok);
  assert.equal(paid.state.balance, 2000);
  assert.equal(paid.state.table, 0, 'турнирные фишки — не деньги');
  assert.equal(Profile.payEntry(p, 5000).ok, false);
  assert.equal(Profile.award(paid.state, 6000).balance, 8000);
});
