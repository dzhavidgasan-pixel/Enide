// Required update: when GitHub has a newer release, the installed app shows this screen
// before anything else, downloads the right file for the OS and installs it.
import { h, clear, icon } from './dom.js';
import { api } from './api.js';
import { tr } from './i18n.js';

const fmtMB = (n) => (n / 1048576).toFixed(n > 100 * 1048576 ? 0 : 1);

export async function checkRequiredUpdate() {
  let r = null;
  try { r = await Promise.race([api.invoke('update:check'), new Promise((res) => setTimeout(() => res(null), 7000))]); } catch { return null; }
  if (!r || !r.available) return r;
  if (r.required) await showUpdateScreen(r, { blocking: true }); // never resolves: the app restarts into the new version
  return r;
}

export function showUpdateScreen(r, { blocking = false } = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'update-screen';
    const notes = String(r.notes || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^\||^#|^\*\*|^!\[/.test(l)).slice(0, 4);
    const bar = h('div', { class: 'up-bar' }, h('i'));
    const status = h('div', { class: 'up-status' });
    const go = h('button', { class: 'btn primary lg up-go' }, icon('download'), tr('Update now', 'Обновить сейчас'));
    const manual = h('button', { class: 'btn lg hidden', onclick: () => api.invoke('app:open-external', r.page || r.url) }, icon('external'), tr('Download manually', 'Скачать вручную'));
    const later = blocking ? null : h('button', { class: 'btn ghost lg', onclick: () => { host.remove(); resolve(); } }, tr('Later', 'Позже'));
    const card = h('div', { class: 'up-card' },
      h('div', { class: 'up-badge' }, icon('download')),
      h('h1', null, tr(`Enide ${r.latest} is out`, `Вышла Enide ${r.latest}`)),
      h('p', { class: 'up-sub' }, blocking
        ? tr(`You have ${r.current}. Update to keep using Enide — it takes a minute and keeps your chats, keys and settings.`, `У тебя ${r.current}. Обнови, чтобы продолжить, — это минута, чаты, ключи и настройки сохранятся.`)
        : tr(`You have ${r.current}.`, `У тебя ${r.current}.`)),
      notes.length ? h('ul', { class: 'up-notes' }, ...notes.map((n) => h('li', null, n.replace(/^[-*•]\s*/, '')))) : null,
      bar, status,
      h('div', { class: 'up-actions' }, go, manual, later));
    host.append(card);
    document.body.append(host);
    if (!r.asset) { go.classList.add('hidden'); manual.classList.remove('hidden'); status.textContent = tr('No file for this system in the release — download it from the release page.', 'В релизе нет файла для этой системы — скачай со страницы релиза.'); }

    let off = null;
    go.addEventListener('click', async () => {
      go.disabled = true; manual.classList.add('hidden');
      bar.classList.add('on');
      status.textContent = tr('Downloading…', 'Скачиваю…');
      off = api.on('update:progress', (p) => {
        const pct = p.total ? Math.min(100, (p.got / p.total) * 100) : 0;
        bar.firstChild.style.width = pct + '%';
        status.textContent = p.done ? tr('Installing…', 'Устанавливаю…') : `${tr('Downloading', 'Скачиваю')} ${fmtMB(p.got)}${p.total ? ' / ' + fmtMB(p.total) : ''} MB`;
      });
      try {
        const res = await api.invoke('update:install', r);
        if (res && res.relaunching) status.textContent = tr('Restarting into the new version…', 'Перезапускаю в новой версии…');
        else if (res && res.installer) status.textContent = tr('The installer is open — finish it and Enide restarts.', 'Открыт установщик — пройди его, и Enide откроется заново.');
        else status.textContent = tr('Opened the downloaded file — install it and reopen Enide.', 'Скачанный файл открыт — установи его и запусти Enide заново.');
      } catch (e) {
        status.textContent = `${tr('Could not update', 'Не получилось обновить')}: ${e.message}`;
        status.classList.add('err');
        go.disabled = false; go.lastChild.textContent = tr('Try again', 'Ещё раз');
        manual.classList.remove('hidden');
      } finally { if (off) off(); }
    });
  });
}
