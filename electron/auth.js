'use strict';
// Local Enide accounts: nickname + login + password, with a code word to reset a forgotten
// password. No e-mail, no codes, no server. Passwords and code words are stored only as
// scrypt hashes; the "remember me" session token is encrypted with the OS keychain.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOGIN_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(secret), salt, 64, SCRYPT).toString('hex');
  return { salt, hash };
}
function verifySecret(secret, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const a = Buffer.from(hashSecret(secret, rec.salt).hash, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const normLogin = (s) => String(s || '').trim().toLowerCase();
const normWord = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class AuthError extends Error {
  constructor(code, message, field) { super(message); this.code = code; this.field = field; }
}

class AuthStore {
  constructor({ dir, safeStorage }) {
    this.file = path.join(dir, 'accounts.json');
    this.sessionFile = path.join(dir, 'session.bin');
    this.safe = safeStorage;
    this.current = null;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = { accounts: [] }; }
    if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
    this.restoreSession();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  pub(a) { return a ? { id: a.id, nick: a.nick, login: a.login, created: a.created, lastLogin: a.lastLogin } : null; }
  find(login) { const l = normLogin(login); return this.data.accounts.find((a) => a.login === l); }
  byId(id) { return this.data.accounts.find((a) => a.id === id); }

  status() { return { hasAccounts: this.data.accounts.length > 0, user: this.pub(this.current) }; }
  isSignedIn() { return !!this.current; }

  // ---------- validation ----------
  checkNick(nick) {
    const n = String(nick || '').trim();
    if (n.length < 2) throw new AuthError('nick', 'Ник — минимум 2 символа', 'nick');
    if (n.length > 32) throw new AuthError('nick', 'Ник — максимум 32 символа', 'nick');
    return n;
  }
  checkLogin(login) {
    const l = normLogin(login);
    if (!LOGIN_RE.test(l)) throw new AuthError('login', 'Логин: 3–32 символа, латиница, цифры, _ . -', 'login');
    return l;
  }
  checkPassword(pw, field = 'password') {
    const p = String(pw || '');
    if (p.length < 6) throw new AuthError('password', 'Пароль — минимум 6 символов', field);
    if (p.length > 256) throw new AuthError('password', 'Пароль слишком длинный', field);
    return p;
  }
  checkWord(word) {
    const w = normWord(word);
    if (w.length < 3) throw new AuthError('word', 'Кодовое слово — минимум 3 символа', 'word');
    return w;
  }

  // Slow down guessing: after 5 wrong tries the account locks for 30 s, doubling up to 15 min.
  guard(a) {
    const until = a.lockUntil || 0;
    if (until > Date.now()) {
      const s = Math.ceil((until - Date.now()) / 1000);
      throw new AuthError('locked', `Слишком много попыток. Подожди ${s >= 60 ? Math.ceil(s / 60) + ' мин' : s + ' с'}`);
    }
  }
  fail(a) {
    a.failed = (a.failed || 0) + 1;
    if (a.failed >= 5) a.lockUntil = Date.now() + Math.min(15 * 60, 30 * 2 ** (a.failed - 5)) * 1000;
    this.save();
  }

  // ---------- actions ----------
  register({ nick, login, password, word, remember = true }) {
    const n = this.checkNick(nick);
    const l = this.checkLogin(login);
    const p = this.checkPassword(password);
    const w = this.checkWord(word);
    if (this.find(l)) throw new AuthError('taken', 'Этот логин уже занят', 'login');
    if (normWord(p) === w) throw new AuthError('word', 'Кодовое слово не должно совпадать с паролем', 'word');
    const a = { id: crypto.randomUUID(), nick: n, login: l, pass: hashSecret(p), word: hashSecret(w), created: Date.now(), lastLogin: null, failed: 0, lockUntil: 0 };
    this.data.accounts.push(a);
    return this.startSession(a, remember);
  }

  login({ login, password, remember = true }) {
    const a = this.find(login);
    if (!a) throw new AuthError('credentials', 'Неверный логин или пароль', 'password');
    this.guard(a);
    if (!verifySecret(password, a.pass)) { this.fail(a); throw new AuthError('credentials', 'Неверный логин или пароль', 'password'); }
    return this.startSession(a, remember);
  }

  recover({ login, word, newPassword, remember = true }) {
    const a = this.find(login);
    if (!a) throw new AuthError('credentials', 'Неверный логин или кодовое слово', 'word');
    this.guard(a);
    if (!verifySecret(normWord(word), a.word)) { this.fail(a); throw new AuthError('credentials', 'Неверный логин или кодовое слово', 'word'); }
    a.pass = hashSecret(this.checkPassword(newPassword, 'newPassword'));
    a.sessions = []; // sign out everywhere
    return this.startSession(a, remember);
  }

  updateProfile({ nick }) {
    const a = this.requireUser();
    a.nick = this.checkNick(nick);
    this.save();
    return this.pub(a);
  }

  changePassword({ password, newPassword }) {
    const a = this.requireUser();
    if (!verifySecret(password, a.pass)) throw new AuthError('credentials', 'Текущий пароль неверный', 'password');
    a.pass = hashSecret(this.checkPassword(newPassword, 'newPassword'));
    this.save();
    return true;
  }

  changeWord({ password, word }) {
    const a = this.requireUser();
    if (!verifySecret(password, a.pass)) throw new AuthError('credentials', 'Пароль неверный', 'password');
    a.word = hashSecret(this.checkWord(word));
    this.save();
    return true;
  }

  deleteAccount({ password }) {
    const a = this.requireUser();
    if (!verifySecret(password, a.pass)) throw new AuthError('credentials', 'Пароль неверный', 'password');
    this.data.accounts = this.data.accounts.filter((x) => x.id !== a.id);
    this.save();
    this.logout();
    return true;
  }

  logout() {
    if (this.current) {
      const s = this.readSession();
      if (s && s.id === this.current.id) this.current.sessions = (this.current.sessions || []).filter((h) => h !== sha(s.token));
      this.save();
    }
    this.current = null;
    try { fs.rmSync(this.sessionFile, { force: true }); } catch {}
    return true;
  }

  requireUser() {
    if (!this.current) throw new AuthError('auth', 'Нужно войти в аккаунт');
    return this.current;
  }

  // ---------- session ----------
  startSession(a, remember) {
    a.failed = 0; a.lockUntil = 0; a.lastLogin = Date.now();
    a.sessions = (a.sessions || []).slice(-4);
    this.current = a;
    if (remember) {
      const token = crypto.randomBytes(32).toString('hex');
      a.sessions.push(sha(token));
      this.writeSession({ id: a.id, token });
    } else {
      try { fs.rmSync(this.sessionFile, { force: true }); } catch {}
    }
    this.save();
    return this.pub(a);
  }

  encAvailable() { try { return !!(this.safe && this.safe.isEncryptionAvailable()); } catch { return false; } }

  writeSession(obj) {
    const json = JSON.stringify(obj);
    const buf = this.encAvailable() ? Buffer.concat([Buffer.from('E1'), this.safe.encryptString(json)]) : Buffer.from('P1' + json);
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    fs.writeFileSync(this.sessionFile, buf, { mode: 0o600 });
  }

  readSession() {
    try {
      const buf = fs.readFileSync(this.sessionFile);
      const tag = buf.slice(0, 2).toString();
      const body = buf.slice(2);
      const json = tag === 'E1' ? this.safe.decryptString(body) : tag === 'P1' ? body.toString() : null;
      return json ? JSON.parse(json) : null;
    } catch { return null; }
  }

  // Keychain may only be ready after app 'ready': call again then.
  restoreSession() {
    if (this.current) return;
    const s = this.readSession();
    if (!s) return;
    const a = this.byId(s.id);
    if (a && (a.sessions || []).includes(sha(s.token))) this.current = a;
  }
}

module.exports = { AuthStore, AuthError, hashSecret, verifySecret };
