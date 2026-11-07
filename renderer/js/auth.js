// Sign-in screen: nickname + login + password, code word to reset a forgotten password.
// Accounts are local (see electron/auth.js) — no e-mail and no codes.
import { h, clear, icon } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { tr } from './i18n.js';
import { starfield } from './stars.js';

const EN = {
  nick: 'Nickname — at least 2 characters',
  login: 'Login: 3–32 characters — latin letters, digits, _ . -',
  password: 'Password — at least 6 characters',
  word: 'Code word — at least 3 characters',
  taken: 'This login is already taken',
  credentials: 'Wrong login or password',
  locked: 'Too many attempts — wait a little',
};
const errText = (e) => (state.lang === 'en' || document.documentElement.lang === 'en') && EN[e.code] ? EN[e.code] : e.message;

// Deterministic avatar colors from the login.
export function avatar(user, size = 28) {
  const seed = [...String((user && user.login) || '?')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const h1 = seed % 360, h2 = (h1 + 48) % 360;
  const nick = String((user && user.nick) || '?').trim();
  const parts = nick.split(/\s+/);
  const ini = (parts.length > 1 ? parts[0][0] + parts[1][0] : nick.slice(0, 2)).toUpperCase();
  return h('span', { class: 'avatar', style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px', background: `linear-gradient(135deg, hsl(${h1} 70% 62%), hsl(${h2} 72% 48%))` } }, ini);
}

function strength(pw) {
  let s = 0;
  if (pw.length >= 6) s++;
  if (pw.length >= 10) s++;
  if (/[a-zа-я]/.test(pw) && /[A-ZА-Я]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^\w\s]/.test(pw)) s++;
  return Math.min(4, pw.length < 6 ? 0 : Math.max(1, s - 1));
}

// One labelled input with inline error.
function field(name, label, attrs = {}, hint) {
  const input = h('input', { class: 'auth-input', name, autocomplete: 'off', spellcheck: 'false', ...attrs });
  const err = h('div', { class: 'auth-err' });
  const wrap = h('label', { class: 'auth-field' }, h('span', { class: 'auth-label' }, label), h('div', { class: 'auth-control' }, input), hint ? h('div', { class: 'auth-hint' }, hint) : null, err);
  if (attrs.type === 'password') {
    const eye = h('button', { type: 'button', class: 'auth-eye', tabindex: '-1', title: tr('Show', 'Показать'), onclick: (e) => { e.preventDefault(); const show = input.type === 'password'; input.type = show ? 'text' : 'password'; eye.replaceChildren(icon(show ? 'eyeOff' : 'eye')); input.focus(); } }, icon('eye'));
    wrap.querySelector('.auth-control').append(eye);
  }
  input.addEventListener('input', () => { wrap.classList.remove('bad'); err.textContent = ''; });
  return { wrap, input, setError(msg) { wrap.classList.add('bad'); err.textContent = msg; } };
}

export async function authGate() {
  let st;
  try { st = await api.invoke('auth:status'); } catch { st = { hasAccounts: false, user: null }; }
  if (st.user) return st.user;
  return new Promise((resolve) => {
    const app = document.getElementById('app');
    clear(app);
    const root = h('div', { class: 'auth' });
    const card = h('div', { class: 'auth-card' });
    const tabs = h('div', { class: 'auth-tabs' });
    const body = h('div', { class: 'auth-body' });
    root.append(
      h('div', { class: 'auth-brand' },
        h('div', { class: 'hero-logo auth-logo', 'aria-label': 'Enide' }, 'enide'),
        h('div', { class: 'auth-tag' }, tr('Code openly.', 'Код открыто.'))),
      card);
    card.append(tabs, body);
    app.append(root);
    let stars = null;
    requestAnimationFrame(() => { if (state.settings && state.settings.starfield === true) stars = starfield(root, { light: document.documentElement.dataset.theme === 'light' }); });

    const done = (user) => {
      root.classList.add('leaving');
      setTimeout(() => { if (stars) stars.destroy(); resolve(user); }, 260);
    };
    const shake = () => { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); };

    const submitBtn = (label) => h('button', { type: 'submit', class: 'btn primary auth-submit' }, h('span', { class: 'lbl' }, label), h('span', { class: 'spin' }));
    const run = async (form, btnEl, fields, fn) => {
      if (btnEl.disabled) return;
      btnEl.disabled = true; btnEl.classList.add('busy');
      try { done(await fn()); }
      catch (e) {
        const f = fields[e.field] || fields[e.code] || null;
        if (f) { f.setError(errText(e)); f.input.focus(); } else form.querySelector('.auth-form-err').textContent = errText(e);
        shake();
      } finally { btnEl.disabled = false; btnEl.classList.remove('busy'); }
    };

    const views = {
      login() {
        const f = {
          login: field('login', tr('Login', 'Логин'), { autocomplete: 'username', autofocus: true }),
          password: field('password', tr('Password', 'Пароль'), { type: 'password', autocomplete: 'current-password' }),
        };
        const remember = h('input', { type: 'checkbox', checked: true });
        const b = submitBtn(tr('Sign in', 'Войти'));
        const form = h('form', { class: 'auth-form' },
          h('h1', null, tr('Welcome back', 'С возвращением')),
          h('p', { class: 'auth-sub' }, tr('Sign in to your Enide account.', 'Войди в свой аккаунт Enide.')),
          f.login.wrap, f.password.wrap,
          h('div', { class: 'auth-row' },
            h('label', { class: 'auth-check' }, remember, h('span', null, tr('Remember me', 'Запомнить меня'))),
            h('a', { class: 'auth-link', onclick: () => show('recover') }, tr('Forgot password?', 'Забыли пароль?'))),
          h('div', { class: 'auth-form-err' }), b,
          h('div', { class: 'auth-switch' }, tr('No account yet? ', 'Ещё нет аккаунта? '), h('a', { class: 'auth-link', onclick: () => show('register') }, tr('Create one', 'Создать'))));
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!f.login.input.value.trim()) { f.login.setError(tr('Enter your login', 'Введи логин')); return shake(); }
          if (!f.password.input.value) { f.password.setError(tr('Enter your password', 'Введи пароль')); return shake(); }
          run(form, b, f, () => api.invoke('auth:login', { login: f.login.input.value, password: f.password.input.value, remember: remember.checked }));
        });
        return form;
      },

      register() {
        const f = {
          nick: field('nick', tr('Nickname', 'Ник'), { maxlength: 32, autofocus: true, placeholder: tr('How Enide greets you', 'Как тебя называть') }),
          login: field('login', tr('Login', 'Логин'), { maxlength: 32, autocomplete: 'username', placeholder: 'maxberry' }, tr('For signing in: latin letters, digits, _ . -', 'Для входа: латиница, цифры, _ . -')),
          password: field('password', tr('Password', 'Пароль'), { type: 'password', autocomplete: 'new-password', placeholder: tr('At least 6 characters', 'Минимум 6 символов') }),
          password2: field('password2', tr('Repeat password', 'Повтори пароль'), { type: 'password', autocomplete: 'new-password' }),
          word: field('word', tr('Code word', 'Кодовое слово'), { placeholder: tr('e.g. the name of your first pet', 'например, кличка первого питомца') }, tr('Resets your password if you forget it. Remember it or write it down — there is no other way to recover.', 'Нужно, чтобы сбросить пароль, если забудешь. Запомни или запиши — другого способа восстановить нет.')),
        };
        const meter = h('div', { class: 'auth-meter' }, h('i'), h('i'), h('i'), h('i'), h('span', { class: 't' }));
        f.password.wrap.insertBefore(meter, f.password.wrap.querySelector('.auth-err'));
        const LBL = [['', ''], [tr('weak', 'слабый'), 'w'], [tr('fair', 'средний'), 'f'], [tr('good', 'хороший'), 'g'], [tr('strong', 'сильный'), 's']];
        f.password.input.addEventListener('input', () => {
          const v = f.password.input.value; const sc = v ? Math.max(1, strength(v)) : 0;
          meter.className = `auth-meter s${sc}`; meter.querySelector('.t').textContent = v ? LBL[sc][0] : '';
        });
        const b = submitBtn(tr('Create account', 'Создать аккаунт'));
        const form = h('form', { class: 'auth-form' },
          h('h1', null, tr('Create your account', 'Создай аккаунт')),
          h('p', { class: 'auth-sub' }, tr('No e-mail, no codes — just a password and a code word.', 'Без почты и кодов — только пароль и кодовое слово.')),
          f.nick.wrap, f.login.wrap,
          h('div', { class: 'auth-pair' }, f.password.wrap, f.password2.wrap),
          f.word.wrap,
          h('div', { class: 'auth-form-err' }), b,
          h('div', { class: 'auth-switch' }, tr('Already have an account? ', 'Уже есть аккаунт? '), h('a', { class: 'auth-link', onclick: () => show('login') }, tr('Sign in', 'Войти'))));
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (f.password.input.value !== f.password2.input.value) { f.password2.setError(tr('Passwords do not match', 'Пароли не совпадают')); return shake(); }
          run(form, b, f, () => api.invoke('auth:register', { nick: f.nick.input.value, login: f.login.input.value, password: f.password.input.value, word: f.word.input.value, remember: true }));
        });
        return form;
      },

      recover() {
        const f = {
          login: field('login', tr('Login', 'Логин'), { autocomplete: 'username', autofocus: true }),
          word: field('word', tr('Code word', 'Кодовое слово'), {}, tr('Case and extra spaces do not matter.', 'Регистр и лишние пробелы не важны.')),
          newPassword: field('newPassword', tr('New password', 'Новый пароль'), { type: 'password', autocomplete: 'new-password', placeholder: tr('At least 6 characters', 'Минимум 6 символов') }),
        };
        const b = submitBtn(tr('Set password & sign in', 'Сменить пароль и войти'));
        const form = h('form', { class: 'auth-form' },
          h('button', { type: 'button', class: 'auth-back', onclick: () => show('login') }, icon('chevron'), tr('Back', 'Назад')),
          h('h1', null, tr('Reset password', 'Восстановить пароль')),
          h('p', { class: 'auth-sub' }, tr('Enter the code word you chose when creating the account.', 'Введи кодовое слово, которое указал при создании аккаунта.')),
          f.login.wrap, f.word.wrap, f.newPassword.wrap,
          h('div', { class: 'auth-form-err' }), b);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          run(form, b, f, () => api.invoke('auth:recover', { login: f.login.input.value, word: f.word.input.value, newPassword: f.newPassword.input.value, remember: true }));
        });
        return form;
      },
    };

    function show(view) {
      clear(tabs);
      if (view !== 'recover') {
        for (const [id, label] of [['login', tr('Sign in', 'Вход')], ['register', tr('New account', 'Регистрация')]]) {
          tabs.append(h('button', { type: 'button', class: id === view ? 'on' : '', onclick: () => show(id) }, label));
        }
        tabs.classList.toggle('right', view === 'register');
      }
      tabs.classList.toggle('hidden', view === 'recover');
      const form = views[view]();
      clear(body);
      body.append(form);
      body.classList.remove('in'); void body.offsetWidth; body.classList.add('in');
      setTimeout(() => { const a = form.querySelector('[autofocus]'); if (a) a.focus(); }, 30);
    }
    show(st.hasAccounts ? 'login' : 'register');
  });
}
