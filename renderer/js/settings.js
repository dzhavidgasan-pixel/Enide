// Settings modal: providers & models, agent permissions, prompts & rules (fully visible),
// plugins & MCP, editor, autocomplete, voice, appearance, shortcuts.
import { h, clear, icon, iconBtn, btn, toggle, seg, toast, confirmDialog, promptDialog, popMenu, modal, jsonHighlight, basename } from './dom.js';
import { api } from './api.js';
import { state, emit, allModels } from './state.js';
import { t, tr, getLang } from './i18n.js';
import { avatar } from './auth.js';
import { modelIcon, providerIcon, vendorIcon, vendorOfModel, vendorOfProvider, resetVendorIcons } from './vendors.js';

const SECTIONS = [
  ['providers', 'cpu', () => tr('Models', 'Модели')],
  ['rules', 'edit', () => tr('Rules', 'Правила')],
  ['plugins', 'puzzle', () => tr('Plugins & MCP', 'Плагины и MCP')],
  ['general', 'settings', () => tr('General', 'Основное')],
  ['account', 'user', () => tr('Account', 'Аккаунт')],
];

const REASONING_STYLES = [
  ['none', '—'], ['anthropic-adaptive', 'Anthropic · adaptive (Claude 4.6+)'], ['anthropic-budget', 'Anthropic · budget_tokens'],
  ['openai-effort', 'OpenAI · reasoning_effort'], ['openai-responses', 'OpenAI Responses · reasoning'], ['openrouter', 'OpenRouter · reasoning'],
  ['thinking-object', 'thinking: {type} (GLM, Kimi, DeepSeek)'], ['enable-thinking', 'enable_thinking (Qwen)'], ['kimi-effort', 'Kimi K3 · reasoning_effort low/high/max'], ['gemini', 'Gemini · thinkingConfig'],
];

let open = null;

export function openSettings(section = 'providers') {
  if (open) { open.go(section); return; }
  const nav = h('div', { class: 'set-nav' }, h('div', { class: 'brand wordmark' }, 'En', h('span', { class: 'ig' }, 'ı', h('span', { class: 'orb' })), 'de'));
  const main = h('div', { class: 'set-main selectable' });
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc, true); open = null; };
  const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.menu')) { e.stopPropagation(); close(); } };
  const m = h('div', { class: 'modal' }, nav, main, h('div', { class: 'set-close' }, iconBtn('x', 'Close', close)));
  const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(); } }, m);
  document.getElementById('overlays').append(ov);
  document.addEventListener('keydown', esc, true);
  const go = (id) => {
    clear(nav); nav.append(h('div', { class: 'brand wordmark' }, 'En', h('span', { class: 'ig' }, 'ı', h('span', { class: 'orb' })), 'de'));
    for (const [sid, ic, label] of SECTIONS) nav.append(h('button', { class: sid === id ? 'on' : '', onclick: () => go(sid) }, icon(ic), label()));
    clear(main);
    main.scrollTop = 0;
    (RENDER[id] || RENDER.providers)(main, () => go(id));
  };
  open = { go, close };
  go(section);
}

const save = (patch) => new Promise((resolve) => emit('save-settings', patch, resolve));
const S = () => state.settings;

function field(label, hint, control, top) {
  return h('div', { class: `field ${top ? 'top' : ''}` }, h('div', null, h('label', { class: 'l' }, label), hint ? h('div', { class: 'hint' }, hint) : null), h('div', null, control));
}
function input(value, onchange, attrs = {}) {
  const el = h('input', { class: 'input', value: value == null ? '' : value, ...attrs });
  el.addEventListener('change', () => onchange(attrs.type === 'number' ? (el.value === '' ? null : +el.value) : el.value));
  return el;
}
function select(options, value, onchange) {
  const el = h('select', { class: 'select' }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  el.addEventListener('change', () => onchange(el.value));
  return el;
}
function textarea(value, onchange, rows = 6, attrs = {}) {
  const el = h('textarea', { class: 'textarea', rows, ...attrs });
  el.value = value || '';
  el.addEventListener('change', () => onchange(el.value));
  return el;
}
function modelOptions(includeDefault) {
  const opts = includeDefault ? [['', tr('Same as chat model', 'Как в чате')]] : [];
  for (const m of allModels()) opts.push([`${m.ref.providerId}::${m.ref.modelId}`, `${m.provider.name} · ${m.model.name || m.model.id}`]);
  return opts;
}
const refToVal = (r) => (r ? `${r.providerId}::${r.modelId}` : '');
const valToRef = (v) => { if (!v) return null; const [providerId, ...rest] = v.split('::'); return { providerId, modelId: rest.join('::') }; };

function head(main, title, lead) {
  main.append(h('h1', null, title));
  if (lead) main.append(h('p', { class: 'lead' }, lead));
}

// Password-type input + action button, with an inline status line.
function secretForm(fields, label, onsubmit, danger) {
  const inputs = fields.map(([name, ph, type]) => h('input', { class: 'input', name, type: type || 'password', placeholder: ph, autocomplete: 'off' }));
  const msg = h('div', { class: 'acc-msg' });
  const b = btn(label, { cls: `sm ${danger ? 'danger' : 'primary'}`, onclick: async () => {
    msg.className = 'acc-msg'; msg.textContent = '';
    b.disabled = true;
    try {
      const vals = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      const ok = await onsubmit(vals);
      if (ok !== false) { inputs.forEach((i) => { i.value = ''; }); msg.className = 'acc-msg ok'; msg.textContent = typeof ok === 'string' ? ok : tr('Saved', 'Сохранено'); }
    } catch (e) { msg.className = 'acc-msg err'; msg.textContent = e.message; }
    b.disabled = false;
  } });
  return h('div', { class: 'acc-form' }, h('div', { class: 'row', style: { flexWrap: 'wrap' } }, ...inputs, b), msg);
}

const RENDER = {
  account(main, rerender) {
    const u = state.user || {};
    head(main, tr('Account', 'Аккаунт'), tr('Your local Enide account: it locks the app with a password on this computer. No e-mail — the code word resets a forgotten password.', 'Твой локальный аккаунт Enide: защищает вход в приложение паролем на этом компьютере. Без почты — забытый пароль сбрасывается кодовым словом.'));
    main.append(h('div', { class: 'card acc-card' },
      avatar(u, 56),
      h('div', { class: 'grow' },
        h('div', { class: 'acc-nick' }, u.nick || ''),
        h('div', { class: 'acc-login' }, '@' + (u.login || '')),
        u.created ? h('div', { class: 'acc-since' }, tr('Member since ', 'С нами с ') + new Date(u.created).toLocaleDateString()) : null),
      btn(tr('Sign out', 'Выйти'), { cls: 'sm', icon: 'logout', onclick: async () => { try { await api.invoke('auth:logout'); } catch {} location.reload(); } })));

    const nick = input(u.nick, async (v) => {
      try { const nu = await api.invoke('auth:update', { nick: v }); emit('user', nu); toast(tr('Nickname saved', 'Ник сохранён'), 'ok', 1500); rerender(); }
      catch (e) { toast(e.message, 'error'); }
    }, { maxlength: 32 });
    main.append(h('div', { class: 'group-title' }, tr('Profile', 'Профиль')),
      field(tr('Nickname', 'Ник'), tr('Shown in the title bar and greetings', 'Показывается в шапке и приветствии'), nick),
      field(tr('Login', 'Логин'), tr('Used to sign in; cannot be changed', 'Для входа; изменить нельзя'), h('input', { class: 'input', value: u.login || '', disabled: true })));

    main.append(h('div', { class: 'group-title' }, tr('Security', 'Безопасность')),
      field(tr('Password', 'Пароль'), tr('At least 6 characters', 'Минимум 6 символов'),
        secretForm([['password', tr('Current password', 'Текущий пароль')], ['newPassword', tr('New password', 'Новый пароль')]], tr('Change', 'Сменить'),
          (v) => api.invoke('auth:change-password', v).then(() => tr('Password changed', 'Пароль изменён'))), true),
      field(tr('Code word', 'Кодовое слово'), tr('Resets your password if you forget it', 'Сбрасывает пароль, если забудешь'),
        secretForm([['password', tr('Password', 'Пароль')], ['word', tr('New code word', 'Новое кодовое слово'), 'text']], tr('Change', 'Сменить'),
          (v) => api.invoke('auth:change-word', v).then(() => tr('Code word changed', 'Кодовое слово изменено'))), true));

    main.append(h('div', { class: 'group-title' }, tr('Danger zone', 'Опасная зона')),
      field(tr('Delete account', 'Удалить аккаунт'), tr('Removes the account from this computer. Chats, settings and keys stay.', 'Удаляет аккаунт с этого компьютера. Чаты, настройки и ключи остаются.'),
        secretForm([['password', tr('Password', 'Пароль')]], tr('Delete', 'Удалить'), async (v) => {
          if (!(await confirmDialog(tr('Delete account', 'Удалить аккаунт'), '@' + u.login, t('delete'), true))) return false;
          await api.invoke('auth:delete', v); location.reload(); return true;
        }, true), true));
  },

  general(main, rerender) {
    head(main, tr('General', 'Основное'));
    const up = S().updates || {};
    main.append(
      field(tr('Language', 'Язык'), null, seg([{ value: 'auto', label: 'Auto' }, { value: 'en', label: 'EN' }, { value: 'ru', label: 'RU' }], S().language || 'auto', async (v) => { await save({ language: v }); rerender(); })),
      field(tr('Theme', 'Тема'), null, seg([{ value: 'dark', label: tr('Dark', 'Тёмная') }, { value: 'light', label: tr('Light', 'Светлая') }, { value: 'system', label: tr('System', 'Системная') }], S().theme || 'dark', (v) => save({ theme: v }))),
      field(tr('Proxy', 'Прокси'), tr('Only if the model API is not reachable directly. Empty = system proxy.', 'Только если API модели недоступен напрямую. Пусто — системный.'), input((S().network || {}).proxy, (v) => save({ network: { proxy: v.trim() } }), { placeholder: 'http://127.0.0.1:7890' })),
      field(tr('Version', 'Версия'), up.repo ? `github.com/${up.repo}` : null, h('div', { class: 'row' }, h('span', { class: 'mono', style: { marginRight: '10px' } }, state.info.version), btn(tr('Check for updates', 'Проверить обновления'), { icon: 'download', onclick: () => emit('cmd', 'check-update') }))),
    );
  },

  // Models: each one is an ID + endpoint + key. Nothing built in.
  providers(main, rerender) {
    head(main, tr('Models', 'Модели'), tr('Add any model: its ID, the API endpoint and a key. Works with OpenAI-compatible APIs, Anthropic and Gemini.', 'Добавь любую модель: её ID, адрес API и ключ. Работает с OpenAI-совместимыми API, Anthropic и Gemini.'));
    const add = btn(tr('Add model', 'Добавить модель'), { cls: 'primary lg', icon: 'plus', onclick: async () => {
      const list = S().providers || [];
      const last = list[list.length - 1];
      const np = await api.invoke('providers:custom', { baseUrl: last ? last.baseUrl : '', protocol: last ? last.protocol : undefined });
      await save({ providers: [...list, np] });
      openModel.add(np.id);
      rerender();
    } });
    main.append(h('div', { class: 'models-top' }, add));
    const list = S().providers || [];
    if (!list.length) main.append(h('div', { class: 'models-empty' }, icon('cpu'), h('b', null, tr('No models yet', 'Моделей пока нет')), h('span', null, tr('Press "Add model" and paste the model ID, endpoint and key.', 'Нажми «Добавить модель» и вставь ID модели, адрес и ключ.'))));
    for (const p of list) main.append(modelCard(p, rerender));
  },

  // One field. Added to every agent request (visible in "What the model sees").
  rules(main) {
    head(main, tr('Rules', 'Правила'), tr('Global rules for the agent — added to every request. AGENTS.md / .cursorrules in a project are picked up too.', 'Глобальные правила для агента — добавляются к каждому запросу. AGENTS.md / .cursorrules в проекте тоже учитываются.'));
    const r = S().rules || {};
    const ta = h('textarea', { class: 'textarea rules-ta', rows: 18, spellcheck: 'false', placeholder: tr('For example:\n— Answer in English\n— Write tests for new code\n— Do not touch the migrations folder', 'Например:\n— Отвечай по-русски\n— Пиши тесты для нового кода\n— Не трогай папку migrations') });
    ta.value = r.global || '';
    const st = h('span', { class: 'rules-st' });
    let t0;
    ta.addEventListener('input', () => { clearTimeout(t0); st.textContent = '…'; t0 = setTimeout(async () => { await save({ rules: { ...(S().rules || {}), global: ta.value } }); st.textContent = tr('Saved', 'Сохранено'); }, 500); });
    main.append(ta, h('div', { class: 'rules-foot' }, st));
    setTimeout(() => ta.focus(), 30);
  },

  agent(main, rerender) {
    head(main, tr('Agent & permissions', 'Агент и разрешения'), tr('The agent runs on your Mac with your user rights. Choose what it may do without asking.', 'Агент работает на твоём Mac с твоими правами. Выбери, что он может делать без вопроса.'));
    const a = S().agent || {};
    const pol = a.policy || state.info.defaultPolicy;
    const setPol = (patch) => save({ agent: { policy: { ...pol, ...patch } } }).then(rerender);
    const ask3 = [['auto', tr('Allow', 'Разрешать')], ['ask', tr('Ask', 'Спрашивать')]];
    main.append(
      h('div', { class: 'group-title' }, tr('Quick mode', 'Быстрый режим')),
      field(tr('Permissions', 'Разрешения'), tr('Also available right under the chat input.', 'Также доступно прямо под полем ввода.'), seg([
        { value: 'ask', label: tr('Ask for commands', 'Спрашивать команды') }, { value: 'askAll', label: tr('Ask everything', 'Спрашивать всё') }, { value: 'auto', label: tr('Allow all', 'Разрешить всё') },
      ], pol.command === 'auto' && pol.writeOutside === 'auto' ? 'auto' : pol.write === 'ask' ? 'askAll' : 'ask', (v) => {
        const M = { ask: { command: 'ask', write: 'auto', writeOutside: 'ask', mcp: 'ask', plugins: 'ask', computer: 'ask', network: 'auto' }, askAll: { command: 'ask', write: 'ask', writeOutside: 'ask', mcp: 'ask', plugins: 'ask', computer: 'ask-all', network: 'ask' }, auto: { command: 'auto', write: 'auto', writeOutside: 'auto', mcp: 'auto', plugins: 'auto', computer: 'auto', network: 'auto' } };
        setPol(M[v]);
      })),
      h('div', { class: 'group-title' }, tr('Fine-grained', 'Подробно')),
      field(tr('Edit files in the project', 'Правка файлов проекта'), tr('Every edit is checkpointed and can be undone.', 'Каждая правка сохраняется в чекпоинт и откатывается.'), select(ask3, pol.write, (v) => setPol({ write: v }))),
      field(tr('Edit files outside the project', 'Правка файлов вне проекта'), null, select(ask3, pol.writeOutside, (v) => setPol({ writeOutside: v }))),
      field(tr('Run terminal commands', 'Запуск команд'), tr('Allow-list commands always run; deny-list always asks.', 'Команды из белого списка запускаются всегда; из чёрного — всегда спрашивают.'), select(ask3, pol.command, (v) => setPol({ command: v }))),
      field(tr('Allow-list', 'Белый список'), tr('One command prefix per line', 'Один префикс команды на строку'), textarea((pol.allowList || []).join('\n'), (v) => setPol({ allowList: v.split('\n').map((x) => x.trim()).filter(Boolean) }), 6), true),
      field(tr('Deny-list', 'Чёрный список'), tr('Substrings that always require confirmation', 'Подстроки, которые всегда требуют подтверждения'), textarea((pol.denyList || []).join('\n'), (v) => setPol({ denyList: v.split('\n').filter((x) => x.trim()) }), 5), true),
      field(tr('Allow chained commands from allow-list', 'Разрешать цепочки (;, &&, |) из белого списка'), null, toggle(!!pol.allowChained, (v) => setPol({ allowChained: v }))),
      field(tr('Web requests', 'Веб-запросы'), null, select(ask3, pol.network, (v) => setPol({ network: v }))),
      field(tr('MCP tools', 'MCP-инструменты'), null, select(ask3, pol.mcp, (v) => setPol({ mcp: v }))),
      field(tr('Plugin tools', 'Инструменты плагинов'), null, select(ask3, pol.plugins, (v) => setPol({ plugins: v }))),
      h('div', { class: 'group-title' }, tr('Computer use (mouse, keyboard, screen)', 'Управление компьютером (мышь, клавиатура, экран)')),
      field(tr('Let the agent control this Mac', 'Разрешить агенту управлять Mac'), tr('Adds the "computer" tool: screenshots, clicks, typing, shortcuts. Needs a vision model and macOS permissions: Accessibility + Screen Recording for Enide.', 'Добавляет инструмент computer: скриншоты, клики, ввод, горячие клавиши. Нужна vision-модель и разрешения macOS для Enide: Универсальный доступ + Запись экрана.'), toggle(!!a.computerUse, (v) => save({ agent: { computerUse: v } }).then(rerender))),
      field(tr('Confirm computer actions', 'Подтверждать действия'), null, select([['ask', tr('Ask for clicks/typing (screenshots free)', 'Спрашивать клики и ввод (скриншоты без вопроса)')], ['ask-all', tr('Ask for everything', 'Спрашивать всё')], ['auto', tr('Allow', 'Разрешать')]], pol.computer || 'ask', (v) => setPol({ computer: v }))),
      h('div', { class: 'group-title' }, tr('Behaviour', 'Поведение')),
      field(tr('Max steps per message', 'Макс. шагов на сообщение'), null, input(a.maxSteps || 80, (v) => save({ agent: { maxSteps: Math.max(1, v || 80) } }), { type: 'number', min: 1, max: 1000, style: { width: '120px' } })),
      field(tr('Checkpoints', 'Чекпоинты'), tr('Save originals before the agent edits a file', 'Сохранять оригиналы перед правкой'), toggle(a.checkpoints !== false, (v) => save({ agent: { checkpoints: v } }))),
      field(tr('Open edited files', 'Открывать изменённые файлы'), null, toggle(a.autoOpenEdits !== false, (v) => save({ agent: { autoOpenEdits: v } }))),
      field(tr('Subagents (task tool)', 'Субагенты (инструмент task)'), tr('The agent can delegate research to parallel subagents with a fresh context.', 'Агент может поручать исследование параллельным субагентам с чистым контекстом.'), toggle(a.subagents !== false, (v) => save({ agent: { subagents: v } }))),
      field(tr('Subagent max steps', 'Макс. шагов субагента'), null, input(a.subagentMaxSteps || 30, (v) => save({ agent: { subagentMaxSteps: Math.max(1, v || 30) } }), { type: 'number', style: { width: '120px' } })),
      field(tr('Auto-compact context', 'Автосжатие контекста'), tr('Summarize older turns when the context window fills up.', 'Пересказывать старые ходы, когда контекст заполняется.'), toggle(a.autoCompact !== false, (v) => save({ agent: { autoCompact: v } }))),
      field(tr('Compact at', 'Сжимать при'), tr('share of the context window', 'доля контекстного окна'), select([['0.6', '60%'], ['0.7', '70%'], ['0.8', '80%'], ['0.9', '90%']], String(a.compactAt || 0.8), (v) => save({ agent: { compactAt: +v } }))),
      h('div', { class: 'group-title' }, tr('Browser for the agent', 'Браузер для агента')),
      field(tr('Browser tool', 'Инструмент browser'), tr('Agent opens pages and your localhost app, reads them, clicks, types, checks console errors and screenshots.', 'Агент открывает страницы и твой localhost, читает, кликает, вводит текст, смотрит ошибки консоли и скриншоты.'), toggle(a.browser !== false, (v) => save({ agent: { browser: v } }))),
      field(tr('Show browser window', 'Показывать окно браузера'), null, toggle(a.browserVisible !== false, (v) => save({ agent: { browserVisible: v } }))),
      h('div', { class: 'group-title' }, tr('Hooks', 'Хуки')),
    );
    hooksSection(main, rerender);
    main.append(
      h('div', { class: 'group-title' }, tr('Built-in tools', 'Встроенные инструменты')),
      ...state.info.toolDefs.map((td) => field(td.name, td.description, toggle(!(a.tools && a.tools[td.name] === false), (v) => save({ agent: { tools: { ...(a.tools || {}), [td.name]: v } } })), true)),
    );
  },

  async prompts(main, rerender) {
    head(main, tr('Prompts & rules', 'Промпты и правила'));
    main.append(h('div', { class: 'card transparency' }, h('div', { class: 'tile' }, icon('eye')), h('div', null,
      h('b', null, tr('No hidden prompts.', 'Никаких скрытых промптов.')),
      h('span', null, tr('These templates are everything Enide adds to a request. Edit or clear any of them. The Request Log shows the exact bytes of every call.', 'Эти шаблоны — всё, что Enide добавляет к запросу. Любой можно изменить или очистить. В логе запросов видны точные байты каждого вызова.')),
      h('div', { class: 'row', style: { marginTop: '10px' } }, btn(t('contextPreview'), { cls: 'sm primary', icon: 'eye', onclick: () => emit('context-preview', state.mode) }), btn(t('requestLog'), { cls: 'sm', icon: 'activity', onclick: () => emit('cmd', 'request-log') })))));
    const defaults = state.info.defaultPrompts;
    const cur = S().prompts || {};
    const labels = {
      agent: tr('Agent mode — system prompt', 'Режим Агент — системный промпт'), ask: tr('Ask mode — system prompt', 'Режим Вопрос — системный промпт'), plan: tr('Plan mode — system prompt', 'Режим План — системный промпт'),
      inlineEditSystem: '⌘K — system', inlineEditUser: '⌘K — user template', autocompleteSystem: 'Tab — system', autocompleteUser: 'Tab — user template',
      commitSystem: tr('Commit message — system', 'Сообщение коммита — system'), debug: tr('Debug mode — system prompt', 'Режим Отладка — системный промпт'), subagent: tr('Subagent — system prompt', 'Субагент — системный промпт'),
      compactSystem: tr('Context compaction — system', 'Сжатие контекста — system'), nextEditSystem: tr('Next edit (Tab) — system', 'Следующая правка (Tab) — system'), nextEditUser: tr('Next edit (Tab) — user template', 'Следующая правка (Tab) — шаблон'), reviewSystem: tr('AI review (Bugbot) — system', 'ИИ-ревью (Bugbot) — system'), terminalSystem: tr('Terminal ⌘K — system', 'Терминал ⌘K — system'), transcribe: tr('Voice (Gemini) — instruction', 'Голос (Gemini) — инструкция'), titleSystem: tr('Chat title (unused unless enabled)', 'Заголовок чата (не используется)'),
    };
    main.append(h('div', { class: 'group-title' }, tr('Variables: {{workspace}} {{os}} {{shell}} {{date}} {{rules}} · ⌘K/Tab: {{path}} {{language}} {{prefix}} {{selection}} {{suffix}} {{instruction}}', 'Переменные: {{workspace}} {{os}} {{shell}} {{date}} {{rules}} · ⌘K/Tab: {{path}} {{language}} {{prefix}} {{selection}} {{suffix}} {{instruction}}')));
    for (const key of Object.keys(defaults)) {
      if (key === 'titleSystem') continue;
      const isCustom = cur[key] != null && cur[key] !== defaults[key];
      const ta = textarea(cur[key] != null ? cur[key] : defaults[key], (v) => save({ prompts: { ...S().prompts, [key]: v } }).then(rerender), key === 'agent' ? 16 : 6);
      main.append(h('div', { class: 'field stack' },
        h('div', { class: 'row' }, h('label', { class: 'l grow' }, labels[key] || key, isCustom ? h('span', { class: 'chip', style: { marginLeft: '8px' } }, tr('edited', 'изменён')) : null),
          isCustom ? btn(tr('Reset', 'Сбросить'), { cls: 'sm ghost', icon: 'undo', onclick: () => { const p = { ...S().prompts }; delete p[key]; emit('save-settings-replace', 'prompts', p, rerender); } }) : null,
          btn(tr('Clear', 'Очистить'), { cls: 'sm ghost', onclick: () => save({ prompts: { ...S().prompts, [key]: '' } }).then(rerender) })),
        ta));
    }
    main.append(h('div', { class: 'group-title' }, tr('Memory', 'Память')));
    main.append(field(tr('Memory', 'Память'), tr('Facts the agent saves with update_memory. Inserted via {{memory}}. Edit freely.', 'Факты, которые агент сохраняет через update_memory. Вставляются через {{memory}}. Правь как хочешь.'), toggle(!(S().memory && S().memory.enabled === false), (v) => save({ memory: { enabled: v } }))));
    try {
      const mem = await api.invoke('memory:get');
      for (const scope of ['project', 'global']) {
        const m = mem[scope];
        if (!m) continue;
        main.append(field(scope === 'project' ? tr('Project memory', 'Память проекта') : tr('Global memory', 'Глобальная память'), m.path.replace(state.info.home, '~'), textarea(m.text, (v) => api.invoke('memory:save', scope, v).then(() => toast(tr('Saved', 'Сохранено'), 'ok', 1500)), 5, { placeholder: '- one fact per line' }), true));
      }
    } catch {}
    main.append(h('div', { class: 'group-title' }, tr('Rules', 'Правила')));
    const r = S().rules || {};
    main.append(field(tr('Global rules', 'Глобальные правила'), tr('Appended to every agent/ask/plan system prompt via {{rules}}', 'Добавляются ко всем системным промптам через {{rules}}'), textarea(r.global, (v) => save({ rules: { global: v } }), 6), true));
    main.append(field(tr('Use project rule files', 'Использовать файлы правил проекта'), 'AGENTS.md, CLAUDE.md, .cursorrules, .windsurfrules, .github/copilot-instructions.md, .enide/rules/*, .cursor/rules/*', toggle(r.useProjectFiles !== false, (v) => save({ rules: { useProjectFiles: v } }))));
    let files = [];
    try { files = await api.invoke('rules:list'); } catch {}
    const disabled = new Set(r.disabledFiles || []);
    for (const f of files) {
      main.append(field(f.source, `${f.text.length} chars`, h('div', { class: 'row' }, toggle(!disabled.has(f.source), (v) => { const d = new Set(S().rules.disabledFiles || []); if (v) d.delete(f.source); else d.add(f.source); save({ rules: { disabledFiles: [...d] } }); }), btn(tr('Open', 'Открыть'), { cls: 'sm ghost', onclick: () => { emit('open-file', f.path); openSettingsClose(); } }))));
    }
    if (!files.length) main.append(h('div', { class: 'muted', style: { padding: '8px 0' } }, state.root ? tr('No rule files in this project.', 'В проекте нет файлов правил.') : t('noFolder')));
  },

  async plugins(main, rerender) {
    head(main, tr('Plugins & MCP', 'Плагины и MCP'), tr('MCP servers add tools from the ecosystem (browsers, docs, GitHub, databases). Enide plugins are your own tools and commands in plain JavaScript.', 'MCP-серверы добавляют инструменты из экосистемы (браузер, документация, GitHub, базы). Плагины Enide — твои инструменты и команды на обычном JavaScript.'));
    const servers = S().mcpServers || [];
    let status = [];
    try { status = await api.invoke('mcp:status'); } catch {}
    const st = (id) => status.find((x) => x.id === id);
    const saveServers = (list) => save({ mcpServers: list }).then(() => setTimeout(rerender, 400));
    main.append(h('div', { class: 'row', style: { marginBottom: '10px', flexWrap: 'wrap' } },
      btn(tr('Add MCP server', 'Добавить MCP-сервер'), { cls: 'primary sm', icon: 'plus', onclick: () => editServer(null, (s) => saveServers([...servers, s])) }),
      btn(tr('Import from Cursor / Claude', 'Импорт из Cursor / Claude'), { cls: 'sm', icon: 'download', onclick: async () => {
        const found = await api.invoke('mcp:import');
        if (!found.length) { toast(tr('No MCP configs found.', 'Конфиги MCP не найдены.')); return; }
        const names = new Set(servers.map((s) => s.name));
        const add = found.filter((f) => !names.has(f.name));
        await saveServers([...servers, ...add]);
        toast(tr(`Imported ${add.length} server(s)`, `Импортировано серверов: ${add.length}`), 'ok');
      } })));
    main.append(h('div', { class: 'group-title' }, tr('MCP servers', 'MCP-серверы')));
    if (!servers.length) main.append(h('div', { class: 'muted', style: { padding: '6px 0 10px' } }, tr('None yet — install one from the catalog below.', 'Пока нет — поставь из каталога ниже.')));
    for (const s of servers) {
      const info = st(s.id) || { status: s.enabled === false ? 'stopped' : 'starting', tools: [] };
      const dot = info.status === 'ready' ? 'ok' : info.status === 'error' ? 'err' : info.status === 'starting' ? 'busy' : '';
      const body = h('div', { class: 'prov-body hidden' });
      const card = h('div', { class: 'card prov-card' },
        h('div', { class: 'prov-head', onclick: () => body.classList.toggle('hidden') },
          h('div', { class: 'tile' }, icon(s.type === 'http' ? 'globe' : 'plug')),
          h('div', { class: 'grow' }, h('div', { class: 'nm row' }, h('span', { class: `dot ${dot}` }), s.name), h('div', { class: 'sub ellipsis' }, s.type === 'http' ? s.url : [s.command, ...(s.args || [])].join(' '))),
          h('span', { class: 'muted', style: { fontSize: '12px' } }, info.status === 'ready' ? `${info.tools.length} tools` : info.status),
          toggle(s.enabled !== false, (v) => saveServers(servers.map((x) => (x.id === s.id ? { ...x, enabled: v } : x))))),
        body);
      card.querySelector('.switch').addEventListener('click', (e) => e.stopPropagation());
      if (info.error) body.append(h('div', { class: 'notice error' }, icon('alert'), h('div', { class: 'body' }, info.error)));
      body.append(h('div', { class: 'row', style: { margin: '10px 0', flexWrap: 'wrap' } },
        btn(tr('Edit', 'Изменить'), { cls: 'sm', icon: 'edit', onclick: () => editServer(s, (ns) => saveServers(servers.map((x) => (x.id === s.id ? ns : x)))) }),
        btn(tr('Restart', 'Перезапустить'), { cls: 'sm', icon: 'refresh', onclick: async () => { await api.invoke('mcp:restart', s.id); rerender(); } }),
        h('label', { class: 'check' }, toggle(!!s.autoApprove, (v) => saveServers(servers.map((x) => (x.id === s.id ? { ...x, autoApprove: v } : x)))), tr('Auto-approve all tools', 'Автоодобрение всех инструментов')),
        h('span', { class: 'grow' }),
        btn(t('delete'), { cls: 'sm danger ghost', icon: 'trash', onclick: async () => { if (await confirmDialog(t('delete'), s.name, t('delete'), true)) saveServers(servers.filter((x) => x.id !== s.id)); } })));
      const disabledTools = new Set(s.disabledTools || []);
      for (const tl of info.tools || []) {
        body.append(field(tl.name + (tl.readOnly ? ' · read-only' : ''), (tl.description || '').slice(0, 220), toggle(!disabledTools.has(tl.name), (v) => { const d = new Set(s.disabledTools || []); if (v) d.delete(tl.name); else d.add(tl.name); saveServers(servers.map((x) => (x.id === s.id ? { ...x, disabledTools: [...d] } : x))); }), true));
      }
      if (info.log && info.log.length) body.append(h('div', { class: 'group-title' }, 'log'), h('pre', { class: 'code-view', style: { maxHeight: '180px' } }, info.log.join('\n')));
      main.append(card);
    }
    main.append(h('div', { class: 'group-title' }, tr('Catalog', 'Каталог')));
    const grid = h('div', { class: 'features', style: { marginTop: '6px', width: '100%' } });
    for (const c of state.info.mcpCatalog) {
      const installed = servers.some((s) => s.catalogKey === c.key);
      grid.append(h('div', { class: 'card feature', style: { padding: '16px' } },
        h('div', { class: 'row' }, h('div', { class: 'tile', style: { width: '34px', height: '34px' } }, icon(c.type === 'http' ? 'globe' : 'plug')), h('b', { class: 'grow' }, c.name),
          btn(installed ? tr('Installed', 'Установлен') : tr('Install', 'Установить'), { cls: `sm ${installed ? '' : 'primary'}`, disabled: installed, onclick: () => {
            const s = { id: `${c.key}-${Math.random().toString(36).slice(2, 6)}`, catalogKey: c.key, name: c.name, type: c.type, command: c.command, args: c.args, url: c.url, headers: c.headers, env: {}, enabled: true };
            if (c.type === 'http' && c.headers) editServer(s, (ns) => saveServers([...servers, ns]));
            else saveServers([...servers, s]);
          } })),
        h('p', { style: { marginTop: '10px' } }, c.description), h('div', { class: 'mono muted', style: { fontSize: '11px', marginTop: '8px', wordBreak: 'break-all' } }, c.type === 'http' ? c.url : [c.command, ...c.args].join(' '))));
    }
    main.append(grid);

    main.append(h('div', { class: 'group-title', style: { marginTop: '34px' } }, tr('Enide plugins', 'Плагины Enide')));
    let plugs = [];
    try { plugs = await api.invoke('plugins:status'); } catch {}
    main.append(h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '10px' } },
      btn(tr('Install from folder…', 'Установить из папки…'), { cls: 'sm', icon: 'folder', onclick: async () => { const f = await api.invoke('plugins:pick-folder'); if (f) { try { await api.invoke('plugins:install', f); toast('✓', 'ok'); rerender(); } catch (e) { toast(e.message, 'error'); } } } }),
      btn(tr('Install from Git URL…', 'Установить из Git…'), { cls: 'sm', icon: 'git', onclick: async () => { const u = await promptDialog(tr('Git URL', 'Git URL'), 'https://github.com/user/enide-plugin.git'); if (u) { try { await api.invoke('plugins:install', u); toast('✓', 'ok'); rerender(); } catch (e) { toast(e.message, 'error', 8000); } } } }),
      btn(tr('Create plugin', 'Создать плагин'), { cls: 'sm', icon: 'plus', onclick: async () => { const n = await promptDialog(tr('Plugin name', 'Название плагина'), 'my-plugin'); if (n) { const r = await api.invoke('plugins:scaffold', n); emit('open-file', r.folder + '/index.js'); rerender(); } } }),
      btn(tr('Open plugins folder', 'Открыть папку плагинов'), { cls: 'sm ghost', icon: 'external', onclick: async () => api.invoke('app:open-path', await api.invoke('plugins:dir')) }),
      btn(tr('Reload', 'Перезагрузить'), { cls: 'sm ghost', icon: 'refresh', onclick: async () => { await api.invoke('plugins:reload'); rerender(); } })));
    if (!plugs.length) main.append(h('div', { class: 'muted', style: { padding: '6px 0' } }, tr('No plugins installed. "Create plugin" makes a working example with a tool, a command and a slash command.', 'Плагинов нет. «Создать плагин» сделает рабочий пример с инструментом, командой и слэш-командой.')));
    for (const p of plugs) {
      const disabled = new Set((S().plugins || {}).disabled || []);
      main.append(h('div', { class: 'card prov-card' }, h('div', { class: 'prov-head' },
        h('div', { class: 'tile' }, icon('puzzle')),
        h('div', { class: 'grow' }, h('div', { class: 'nm' }, `${p.name} ${p.version}`), h('div', { class: 'sub' }, p.error ? `⚠ ${p.error}` : `${p.description} · ${p.tools.length} tools · ${p.commands.length} commands`)),
        btn(tr('Open', 'Открыть'), { cls: 'sm ghost', onclick: () => { emit('open-file', p.folder + '/index.js'); } }),
        btn('', { cls: 'sm ghost danger', icon: 'trash', onclick: async () => { if (await confirmDialog(t('delete'), p.name, t('delete'), true)) { await api.invoke('plugins:remove', p.id); rerender(); } } }),
        toggle(!disabled.has(p.id), (v) => { const d = new Set((S().plugins || {}).disabled || []); if (v) d.delete(p.id); else d.add(p.id); save({ plugins: { disabled: [...d] } }).then(() => setTimeout(rerender, 300)); }))));
    }
    main.append(h('div', { class: 'group-title', style: { marginTop: '34px' } }, tr('VS Code extensions', 'Расширения VS Code')));
    main.append(h('p', { class: 'lead' }, tr('Enide is not a VS Code fork, so VS Code/Open VSX extensions cannot run here. Most of what they add for AI work — tools, linters, browsers, databases — is available as MCP servers or a few lines of Enide plugin code.', 'Enide — не форк VS Code, поэтому расширения VS Code/Open VSX здесь не запускаются. Большая часть того, что они дают для работы с ИИ — инструменты, линтеры, браузер, базы данных — доступна как MCP-серверы или пара строк плагина Enide.')));
  },

  editor(main) {
    head(main, tr('Editor & terminal', 'Редактор и терминал'));
    const e = S().editor || {};
    const se = (patch) => save({ editor: patch });
    main.append(
      themeField(e, se),
      field(tr('Semantic TypeScript errors', 'Семантические ошибки TypeScript'), tr('Type errors across the project in the editor. Off by default because types from node_modules are not loaded.', 'Ошибки типов по проекту в редакторе. По умолчанию выкл., т.к. типы из node_modules не загружаются.'), toggle(!!e.semanticDiagnostics, (v) => se({ semanticDiagnostics: v }))),
      field(tr('Font size', 'Размер шрифта'), null, input(e.fontSize || 13, (v) => se({ fontSize: v || 13 }), { type: 'number', min: 8, max: 32, style: { width: '100px' } })),
      field(tr('Font family', 'Шрифт'), null, input(e.fontFamily, (v) => se({ fontFamily: v }))),
      field(tr('Line height', 'Высота строки'), null, input(e.lineHeight || 20, (v) => se({ lineHeight: v || 20 }), { type: 'number', style: { width: '100px' } })),
      field(tr('Tab size', 'Размер табуляции'), null, seg([{ value: 2, label: '2' }, { value: 4, label: '4' }, { value: 8, label: '8' }], e.tabSize || 2, (v) => se({ tabSize: v }))),
      field(tr('Word wrap', 'Перенос строк'), null, seg([{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], e.wordWrap || 'off', (v) => se({ wordWrap: v }))),
      field('Minimap', null, toggle(!!e.minimap, (v) => se({ minimap: v }))),
      field('Sticky scroll', null, toggle(e.stickyScroll !== false, (v) => se({ stickyScroll: v }))),
      field(tr('Auto save', 'Автосохранение'), null, seg([{ value: 'off', label: 'Off' }, { value: 'afterDelay', label: tr('After 1s', 'Через 1с') }], e.autoSave || 'off', (v) => se({ autoSave: v }))),
      field(tr('Terminal font size', 'Шрифт терминала'), null, input((S().terminal || {}).fontSize || 12, (v) => save({ terminal: { fontSize: v || 12 } }), { type: 'number', style: { width: '100px' } })),
      field(tr('Shell', 'Оболочка'), tr('Empty = your login shell', 'Пусто — твоя оболочка входа'), input((S().terminal || {}).shell, (v) => save({ terminal: { shell: v } }), { placeholder: '/bin/zsh' })),
      field(tr('Terminal mode', 'Режим терминала'), null, h('span', { class: 'dim' }, state.info.hasPty ? 'node-pty ✓' : tr('fallback (script) — run "npm install" to get node-pty', 'запасной (script) — выполни "npm install", чтобы получить node-pty'))),
    );
  },

  ai(main) {
    head(main, tr('Tab, ⌘K & voice', 'Tab, ⌘K и голос'));
    const ac = S().autocomplete || {};
    const sa = (p) => save({ autocomplete: p });
    const voice = S().voice || {};
    main.append(
      h('div', { class: 'group-title' }, tr('Tab autocomplete', 'Автодополнение Tab')),
      field(tr('Enabled', 'Включено'), tr('Ghost-text suggestions while you type. Use a fast model.', 'Подсказки серым текстом при наборе. Нужна быстрая модель.'), toggle(!!ac.enabled, (v) => sa({ enabled: v }))),
      field(tr('Next-edit prediction', 'Предсказание следующей правки'), tr('After you edit, Enide suggests the matching change elsewhere — Tab jumps to it, Tab again applies.', 'После правки Enide предлагает связанное изменение в другом месте — Tab переходит к нему, ещё раз Tab применяет.'), toggle(ac.nextEdit !== false, (v) => sa({ nextEdit: v }))),
      field(tr('Model', 'Модель'), null, select(modelOptions(true), refToVal(ac.model), (v) => sa({ model: valToRef(v) }))),
      field(tr('Delay (ms)', 'Задержка (мс)'), null, input(ac.debounceMs || 350, (v) => sa({ debounceMs: v || 350 }), { type: 'number', style: { width: '120px' } })),
      field(tr('Max tokens', 'Макс. токенов'), null, input(ac.maxTokens || 256, (v) => sa({ maxTokens: v || 256 }), { type: 'number', style: { width: '120px' } })),
      h('div', { class: 'group-title' }, '⌘K'),
      field(tr('Inline edit model', 'Модель для ⌘K'), tr('Also used for terminal ⌘K', 'Также для ⌘K в терминале'), select(modelOptions(true), refToVal((S().inlineEdit || {}).model), (v) => save({ inlineEdit: { model: valToRef(v) } }))),
      field(tr('Commit message model', 'Модель для коммитов'), null, select(modelOptions(true), refToVal(S().commitModel), (v) => save({ commitModel: valToRef(v) }))),
      field(tr('AI review model', 'Модель для ИИ-ревью'), null, select(modelOptions(true), refToVal(S().reviewModel), (v) => save({ reviewModel: valToRef(v) }))),
      h('div', { class: 'group-title' }, tr('Voice input', 'Голосовой ввод')),
      field(tr('Speech-to-text provider', 'Провайдер распознавания'), tr('OpenAI or Groq (/audio/transcriptions) or Gemini. Empty = first suitable provider with a key.', 'OpenAI или Groq (/audio/transcriptions) либо Gemini. Пусто — первый подходящий с ключом.'), select([['', 'Auto'], ...(S().providers || []).map((p) => [p.id, p.name])], voice.providerId || '', (v) => save({ voice: { providerId: v || null } }))),
      field(tr('Model', 'Модель'), 'whisper-1 · gpt-4o-transcribe · whisper-large-v3-turbo · gemini-2.5-flash', input(voice.model, (v) => save({ voice: { model: v.trim() } }), { placeholder: 'auto' })),
      field(tr('Language', 'Язык'), tr('ISO code like ru or en; empty = auto', 'Код ISO, например ru или en; пусто — авто'), input(voice.language, (v) => save({ voice: { language: v.trim() } }), { placeholder: 'auto', style: { width: '120px' } })),
    );
  },

  keys(main, rerender) {
    head(main, tr('Shortcuts', 'Горячие клавиши'), tr('Click a shortcut and press a new key combination. Backspace clears it, Esc cancels.', 'Нажми на сочетание и введи новое. Backspace — очистить, Esc — отмена.'));
    const kb = S().keybindings || {};
    main.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
      btn(tr('Import from Cursor / VS Code', 'Импорт из Cursor / VS Code'), { cls: 'sm', icon: 'download', onclick: async () => {
        try { const r = await api.invoke('keys:import'); if (!r.from.length) { toast(tr('No keybindings.json found', 'keybindings.json не найден')); return; } await save({ keybindings: { ...kb, ...r.keybindings } }); toast(tr(`Imported ${Object.keys(r.keybindings).length} from ${r.from.join(', ')}`, `Импортировано ${Object.keys(r.keybindings).length} из ${r.from.join(', ')}`), 'ok'); rerender(); } catch (e) { toast(e.message, 'error'); }
      } }),
      btn(tr('Reset all', 'Сбросить всё'), { cls: 'sm ghost', icon: 'undo', onclick: async () => { await new Promise((res) => emit('save-settings-replace', 'keybindings', {}, res)); rerender(); } })));
    const table = h('table', { class: 'kbd-table' });
    for (const [id, label, def] of KEY_COMMANDS) {
      const cur = kb[id] !== undefined ? kb[id] : def;
      const inp = h('input', { class: 'input kbd-input', readonly: true, value: prettyAcc(cur) || '—' });
      inp.addEventListener('focus', () => { inp.classList.add('rec'); inp.value = tr('press keys…', 'нажми клавиши…'); });
      inp.addEventListener('blur', () => { inp.classList.remove('rec'); inp.value = prettyAcc(kb[id] !== undefined ? kb[id] : def) || '—'; });
      inp.addEventListener('keydown', async (e) => {
        e.preventDefault();
        if (e.key === 'Escape') { inp.blur(); return; }
        if (e.key === 'Backspace' && !(e.metaKey || e.ctrlKey) && !e.ctrlKey && !e.altKey) { kb[id] = ''; await save({ keybindings: { ...kb } }); inp.blur(); return; }
        if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
        const parts = [];
        if ((e.metaKey || e.ctrlKey)) parts.push('Cmd'); if (e.ctrlKey) parts.push('Ctrl'); if (e.altKey) parts.push('Alt'); if (e.shiftKey) parts.push('Shift');
        const k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : ({ Backquote: '`', Backslash: '\\', Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Space: 'Space', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[e.code] || e.key);
        if (!parts.length && !/^F\d+$/.test(k)) return;
        parts.push(k);
        kb[id] = parts.join('+');
        await save({ keybindings: { ...kb } });
        inp.blur();
      });
      table.append(h('tr', null, h('td', null, label()), h('td', null, kb[id] !== undefined ? h('span', { class: 'chip', style: { marginRight: '8px' } }, tr('custom', 'своё')) : null, inp)));
    }
    main.append(table);
    main.append(h('p', { class: 'muted', style: { marginTop: '14px', fontSize: '12px' } }, tr('Editor keys inside Monaco (Tab, ⌘D, ⌥↑ …) follow VS Code defaults.', 'Клавиши внутри редактора Monaco (Tab, ⌘D, ⌥↑ …) — как в VS Code.')));
  },

  async index(main, rerender) {
    head(main, tr('Index & docs', 'Индекс и документация'), tr('A semantic index lets the agent find code by meaning (semantic_search). Docs sets are crawled websites the agent can search (docs_search, @Docs). Everything is stored locally.', 'Семантический индекс позволяет агенту искать код по смыслу (semantic_search). Документация — скачанные сайты, по которым агент ищет (docs_search, @Docs). Всё хранится локально.'));
    const ix = S().index || {};
    const embProviders = (S().providers || []).filter((p) => p.protocol !== 'anthropic');
    let st = { state: 'none' };
    try { st = await api.invoke('index:status'); } catch {}
    const status = st.state === 'ready' ? `${st.files} ${tr('files', 'файлов')} · ${st.chunks} ${tr('chunks', 'фрагментов')} · ${st.model} · ${new Date(st.updated).toLocaleString()}` : st.state === 'building' ? `${tr('Indexing', 'Индексация')} ${st.done || 0}/${st.total || '…'}` : state.root ? tr('Not indexed yet', 'Ещё не проиндексировано') : t('noFolder');
    main.append(h('div', { class: 'group-title' }, tr('Semantic code index', 'Семантический индекс кода')),
      field(tr('Enabled', 'Включён'), tr('Indexes the open folder and keeps it updated as files change.', 'Индексирует открытую папку и обновляет при изменениях.'), toggle(!!ix.enabled, (v) => save({ index: { enabled: v } }))),
      field(tr('Embeddings provider', 'Провайдер эмбеддингов'), tr('OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio, Together…) or Gemini. Anthropic/Z.ai Anthropic API has no embeddings.', 'OpenAI-совместимый (OpenAI, OpenRouter, Ollama, LM Studio, Together…) или Gemini. У Anthropic API (и Z.ai Anthropic) эмбеддингов нет.'), select([['', '—'], ...embProviders.map((p) => [p.id, p.name])], ix.providerId || '', (v) => save({ index: { providerId: v || null } }))),
      field(tr('Embedding model', 'Модель эмбеддингов'), 'text-embedding-3-small · nomic-embed-text · text-embedding-004 · embedding-3', input(ix.model, (v) => save({ index: { model: v.trim() } }), { placeholder: 'text-embedding-3-small' })),
      field(tr('Status', 'Статус'), null, h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('span', { class: 'dim' }, status),
        btn(tr('Index now', 'Индексировать'), { cls: 'sm primary', icon: 'layers', disabled: !state.root, onclick: async () => { try { await api.invoke('index:build', false); toast(tr('Indexing started', 'Индексация запущена'), 'ok'); setTimeout(rerender, 600); } catch (e) { toast(e.message, 'error'); } } }),
        btn(tr('Rebuild', 'Пересобрать'), { cls: 'sm', disabled: !state.root, onclick: async () => { try { await api.invoke('index:build', true); setTimeout(rerender, 600); } catch (e) { toast(e.message, 'error'); } } }),
        st.state === 'ready' ? btn(t('delete'), { cls: 'sm ghost', icon: 'trash', onclick: async () => { await api.invoke('index:remove'); rerender(); } }) : null)));
    if (st.state === 'ready') {
      const q = h('input', { class: 'input', placeholder: tr('Try a search: where is auth handled?', 'Попробуй: где обрабатывается авторизация?') });
      const out = h('pre', { class: 'code-view hidden', style: { maxHeight: '300px', marginTop: '8px' } });
      q.addEventListener('keydown', async (e) => { if (e.key !== 'Enter') return; out.classList.remove('hidden'); out.textContent = '…'; try { out.textContent = await api.invoke('index:search', q.value); } catch (err) { out.textContent = err.message; } });
      main.append(field(tr('Test search', 'Проверить поиск'), null, h('div', null, q, out), true));
    }

    main.append(h('div', { class: 'group-title', style: { marginTop: '30px' } }, tr('Documentation (@Docs)', 'Документация (@Docs)')));
    const name = h('input', { class: 'input', placeholder: tr('Name, e.g. react', 'Имя, напр. react'), style: { width: '160px' } });
    const url = h('input', { class: 'input', placeholder: 'https://react.dev/reference/' });
    const pages = h('input', { class: 'input', type: 'number', value: 60, style: { width: '80px' }, title: tr('Max pages', 'Макс. страниц') });
    main.append(h('div', { class: 'row', style: { marginBottom: '12px' } }, name, url, pages, btn(tr('Add', 'Добавить'), { cls: 'sm primary', icon: 'plus', onclick: async () => {
      if (!/^https?:\/\//.test(url.value.trim())) { toast(tr('Enter a full URL', 'Введи полный URL'), 'error'); return; }
      try { await api.invoke('docs:add', { name: name.value.trim() || undefined, url: url.value.trim(), maxPages: +pages.value || 60 }); toast(tr('Crawling…', 'Скачиваю…'), 'info'); rerender(); } catch (e) { toast(e.message, 'error'); }
    } })));
    let docsList = [];
    try { docsList = await api.invoke('docs:list'); } catch {}
    if (!docsList.length) main.append(h('div', { class: 'muted' }, tr('No docs yet. Add a docs URL — Enide crawls pages under that path. Then type @ in chat and pick "Docs: name".', 'Документации пока нет. Добавь URL — Enide скачает страницы под этим путём. Потом в чате набери @ и выбери «Docs: имя».')));
    for (const d of docsList) {
      main.append(h('div', { class: 'card prov-card' }, h('div', { class: 'prov-head' },
        h('div', { class: 'tile' }, icon('book')),
        h('div', { class: 'grow' }, h('div', { class: 'nm row' }, h('span', { class: `dot ${d.status === 'ready' ? 'ok' : d.status === 'error' ? 'err' : 'busy'}` }), d.name), h('div', { class: 'sub ellipsis' }, `${d.url} · ${d.pages || 0} ${tr('pages', 'стр.')}${d.chunks ? ` · ${d.chunks} ${tr('chunks', 'фрагм.')}` : ''}${d.error ? ' · ' + d.error : ''}`)),
        btn(tr('Re-crawl', 'Обновить'), { cls: 'sm ghost', icon: 'refresh', onclick: async () => { await api.invoke('docs:reindex', d.id); rerender(); } }),
        btn('', { cls: 'sm ghost danger', icon: 'trash', onclick: async () => { await api.invoke('docs:remove', d.id); rerender(); } }))));
    }
    if (docsList.some((d) => d.status === 'crawling')) setTimeout(() => { if (open) rerender(); }, 2000);
  },

  automations(main, rerender) {
    head(main, tr('Automations', 'Автозадачи'), tr('Agent runs on a schedule while Enide is open — e.g. "every weekday at 9:00 run the tests and fix failures". Results appear in chat history with a notification.', 'Запуски агента по расписанию, пока Enide открыт — например «по будням в 9:00 прогони тесты и почини». Результат — в истории чатов и уведомлении.'));
    const list = S().automations || [];
    const saveList = (l) => new Promise((res) => emit('save-settings-replace', 'automations', l, res)).then(rerender);
    main.append(h('div', { class: 'row', style: { marginBottom: '14px' } }, btn(tr('New automation', 'Новая автозадача'), { cls: 'primary sm', icon: 'plus', onclick: () => saveList([...list, { id: 'auto_' + Date.now().toString(36), name: tr('Nightly tests', 'Ночные тесты'), enabled: false, folder: state.root || '', prompt: tr('Run the test suite. If anything fails, find the cause and fix it, then run the tests again. Summarize what you changed.', 'Прогони тесты. Если что-то падает — найди причину и почини, потом прогони снова. Кратко опиши изменения.'), mode: 'agent', approval: 'safe', schedule: { type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } }]) })));
    if (!list.length) main.append(h('div', { class: 'muted' }, tr('No automations yet.', 'Автозадач пока нет.')));
    const days = [[1, tr('Mo', 'Пн')], [2, tr('Tu', 'Вт')], [3, tr('We', 'Ср')], [4, tr('Th', 'Чт')], [5, tr('Fr', 'Пт')], [6, tr('Sa', 'Сб')], [0, tr('Su', 'Вс')]];
    for (const a of list) {
      const upd = (patch) => saveList(list.map((x) => (x.id === a.id ? { ...x, ...patch } : x)));
      const sch = a.schedule || { type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] };
      const dayBox = h('div', { class: 'seg' }, ...days.map(([d, l]) => h('button', { class: (sch.days || []).includes(d) ? 'on' : '', onclick: () => { const set = new Set(sch.days || []); if (set.has(d)) set.delete(d); else set.add(d); upd({ schedule: { ...sch, days: [...set] } }); } }, l)));
      const body = h('div', { class: 'prov-body' },
        field(tr('Name', 'Название'), null, input(a.name, (v) => upd({ name: v }))),
        field(tr('Folder', 'Папка'), null, h('div', { class: 'row' }, input(a.folder, (v) => upd({ folder: v })), btn('…', { cls: 'sm', onclick: async () => { const f = await api.invoke('automations:pick-folder'); if (f) upd({ folder: f }); } }))),
        field(tr('Prompt', 'Задание'), null, textarea(a.prompt, (v) => upd({ prompt: v }), 4), true),
        field(tr('Schedule', 'Расписание'), null, h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          seg([{ value: 'daily', label: tr('Daily', 'Ежедневно') }, { value: 'interval', label: tr('Every N minutes', 'Каждые N минут') }], sch.type, (v) => upd({ schedule: { ...sch, type: v } })),
          sch.type === 'interval' ? input(sch.minutes || 60, (v) => upd({ schedule: { ...sch, minutes: Math.max(5, v || 60) } }), { type: 'number', style: { width: '90px' } }) : h('input', { class: 'input', type: 'time', value: sch.time || '09:00', style: { width: '110px' }, onchange: (e) => upd({ schedule: { ...sch, time: e.target.value } }) }),
          sch.type === 'daily' ? dayBox : null)),
        field(tr('Mode', 'Режим'), null, select([['agent', t('agent')], ['ask', t('ask')], ['debug', tr('Debug', 'Отладка')]], a.mode || 'agent', (v) => upd({ mode: v }))),
        field(tr('Permissions', 'Разрешения'), tr('Nobody is there to approve: "Safe" rejects anything that would need approval.', 'Подтверждать некому: «Безопасно» отклоняет всё, что требует подтверждения.'), select([['safe', tr('Safe (reject what needs approval)', 'Безопасно (отклонять то, что требует подтверждения)')], ['auto', tr('Allow all', 'Разрешить всё')]], a.approval || 'safe', (v) => upd({ approval: v }))),
        field(tr('Model', 'Модель'), null, select(modelOptions(true), refToVal(a.modelRef), (v) => upd({ modelRef: valToRef(v) }))),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          btn(tr('Run now', 'Запустить сейчас'), { cls: 'sm primary', icon: 'play', onclick: async () => { await api.invoke('automations:run-now', a.id); toast(tr('Started', 'Запущено'), 'ok'); } }),
          a.lastChatId ? btn(tr('Open last result', 'Открыть последний результат'), { cls: 'sm', onclick: () => { emit('cmd', 'open-chat', a.lastChatId); openSettingsClose(); } }) : null,
          h('span', { class: 'grow' }),
          btn(t('delete'), { cls: 'sm danger ghost', icon: 'trash', onclick: () => saveList(list.filter((x) => x.id !== a.id)) })));
      main.append(h('div', { class: 'card prov-card' },
        h('div', { class: 'prov-head' }, h('div', { class: 'tile' }, icon('clock')),
          h('div', { class: 'grow' }, h('div', { class: 'nm' }, a.name), h('div', { class: 'sub' }, `${sch.type === 'interval' ? tr(`every ${sch.minutes || 60} min`, `каждые ${sch.minutes || 60} мин`) : `${sch.time || '09:00'}`} · ${a.lastRun ? tr('last run ', 'последний запуск ') + new Date(a.lastRun).toLocaleString() + ' · ' + (a.lastStatus || '') : tr('never ran', 'ещё не запускалась')}`)),
          toggle(!!a.enabled, (v) => upd({ enabled: v }))), body));
    }
  },

  async usage(main, rerender) {
    head(main, tr('Usage & cost', 'Расход и стоимость'), tr('Every request to a model is counted locally. Set prices per model in Providers → model ⚙ to see dollars.', 'Каждый запрос к модели считается локально. Цены задаются у модели в Провайдерах → ⚙, тогда видны доллары.'));
    let u;
    try { u = await api.invoke('usage:summary', 30); } catch (e) { main.append(h('div', { class: 'muted' }, e.message)); return; }
    const fmt = (o) => (o.priced ? `$${o.usd.toFixed(o.usd < 1 ? 3 : 2)}` : `${fmtTok(o.input + o.output + o.cache)} tok`);
    const card = (label, o) => h('div', { class: 'card usage-card' }, h('div', { class: 'muted' }, label), h('div', { class: 'big' }, fmt(o)), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${o.requests} ${tr('requests', 'запросов')} · ↑${fmtTok(o.input + o.cache)} ↓${fmtTok(o.output)}`));
    main.append(h('div', { class: 'usage-cards' }, card(tr('Today', 'Сегодня'), u.totals.today), card(tr('7 days', '7 дней'), u.totals.week), card(tr('30 days', '30 дней'), u.totals.month)));
    const max = Math.max(1, ...u.days.map((d) => d.input + d.output + d.cache));
    main.append(h('div', { class: 'group-title' }, tr('Tokens per day', 'Токены по дням')), h('div', { class: 'usage-bars' }, ...u.days.map((d) => h('div', { class: 'b', style: { height: Math.max(1, ((d.input + d.output + d.cache) / max) * 100) + '%' }, title: `${d.day}: ${fmtTok(d.input + d.output + d.cache)} tok${d.priced ? ` · $${d.usd.toFixed(3)}` : ''} · ${d.requests} req` }))));
    const tbl = h('table', { class: 'model-table' }, h('thead', null, h('tr', null, ...[tr('model', 'модель'), tr('requests', 'запросы'), 'input', 'cache', 'output', '$'].map((x) => h('th', null, x)))));
    const tb = h('tbody');
    for (const m of u.models) tb.append(h('tr', null, h('td', null, m.name), h('td', null, m.requests), h('td', null, fmtTok(m.input)), h('td', null, fmtTok(m.cache)), h('td', null, fmtTok(m.output)), h('td', null, m.priced ? `$${m.usd.toFixed(3)}` : '—')));
    tbl.append(tb);
    main.append(h('div', { class: 'group-title' }, tr('By model (30 days)', 'По моделям (30 дней)')), tbl);
    main.append(h('div', { class: 'group-title' }, tr('By feature', 'По функциям')), h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, ...u.kinds.map((k) => h('span', { class: 'chip' }, `${k.kind}: ${fmtTok(k.input + k.output + k.cache)}${k.priced ? ` · $${k.usd.toFixed(3)}` : ''}`))));
    main.append(h('div', { class: 'row', style: { marginTop: '20px' } }, btn(tr('Clear history', 'Очистить историю'), { cls: 'sm ghost danger', icon: 'trash', onclick: async () => { if (await confirmDialog(tr('Clear usage history', 'Очистить историю расхода'), '', t('delete'), true)) { await api.invoke('usage:clear'); rerender(); } } })));
  },

  about(main) {
    head(main, 'Enide');
    main.append(h('div', { class: 'hero-logo', style: { fontSize: '96px', marginBottom: '10px' } }, 'en', h('span', { class: 'ig' }, 'ı', h('span', { class: 'orb' })), 'de'));
    main.append(h('p', { class: 'lead' }, `${tr('Version', 'Версия')} ${state.info.version} · ${state.info.platform}/${state.info.arch}`),
      h('p', { class: 'lead' }, tr('Code openly. Any model, nothing hidden.', 'Код открыто. Любая модель, ничего скрытого.')));
    const up = S().updates || {};
    main.append(h('div', { class: 'group-title' }, tr('Updates', 'Обновления')),
      field(tr('GitHub repository', 'GitHub-репозиторий'), tr('Releases with a .dmg are checked on start. Format: owner/name', 'Релизы с .dmg проверяются при запуске. Формат: owner/name'), input(up.repo, (v) => save({ updates: { repo: v.trim() } }), { placeholder: 'you/enide' })),
      field(tr('Check on start', 'Проверять при запуске'), null, toggle(up.auto !== false, (v) => save({ updates: { auto: v } }))),
      h('div', { class: 'row', style: { marginTop: '12px' } }, btn(tr('Check now', 'Проверить сейчас'), { cls: 'sm primary', icon: 'download', onclick: () => emit('cmd', 'check-update') })));
  },
};

function openSettingsClose() { if (open) open.close(); }

// ---------- model card ----------
const openModel = new Set();
const PROTOCOLS = () => [['openai', tr('OpenAI-compatible', 'OpenAI-совместимый')], ['anthropic', 'Anthropic'], ['gemini', 'Gemini'], ['openai-responses', 'OpenAI Responses']];
const AUTHS = () => [['bearer', 'Authorization: Bearer'], ['x-api-key', 'x-api-key'], ['both', 'x-api-key + Bearer'], ['goog', 'x-goog-api-key'], ['api-key', 'api-key (Azure)'], ['none', tr('none', 'без ключа')]];
const detectProto = (u) => (/anthropic/i.test(u) ? 'anthropic' : /generativelanguage\.googleapis\.com/i.test(u) ? 'gemini' : 'openai');
const authOf = (proto, u) => (proto === 'anthropic' ? (/api\.anthropic\.com/i.test(u) ? 'x-api-key' : 'both') : proto === 'gemini' ? 'goog' : 'bearer');

function modelCard(p, rerender) {
  const m = (p.models || [])[0] || { id: '' };
  const all = () => S().providers || [];
  const put = async (patch, mpatch) => {
    const cur = all().find((x) => x.id === p.id) || p;
    let next = { ...cur, ...patch };
    if (mpatch) {
      let nm = { ...((cur.models || [])[0] || {}), ...mpatch };
      if (mpatch.id !== undefined || patch.protocol) nm = await api.invoke('providers:normalize', { id: nm.id, name: nm.name, custom: true, contextWindow: nm.contextWindow, maxOutput: nm.maxOutput, vision: nm.vision, reasoningStyle: mpatch.reasoningStyle }, next);
      next.models = [nm];
      next.name = nm.name || nm.id;
    }
    await save({ providers: all().map((x) => (x.id === p.id ? next : x)) });
    Object.assign(p, next);
  };
  const isDefault = S().defaultModel && S().defaultModel.providerId === p.id;
  const keyHint = state.keyHints[p.id];
  const title = h('div', { class: 'mc-title' }, m.name || m.id || tr('New model', 'Новая модель'));
  const sub = h('div', { class: 'mc-sub mono' }, (p.baseUrl || tr('no endpoint', 'адрес не указан')).replace(/^https?:\/\//, ''));
  const status = h('div', { class: 'mc-status' });
  const testBtn = btn(tr('Test', 'Проверить'), { icon: 'plug', onclick: async (e) => {
    e.stopPropagation();
    const cur = (all().find((x) => x.id === p.id) || p);
    const mid = ((cur.models || [])[0] || {}).id;
    if (!mid) { status.className = 'mc-status err'; status.textContent = tr('Enter the model ID first', 'Сначала введи ID модели'); return; }
    testBtn.disabled = true; status.className = 'mc-status'; status.replaceChildren(h('span', { class: 'spinner' }), tr(' Sending a test request…', ' Отправляю тестовый запрос…'));
    try {
      const r = await api.invoke('providers:test', p.id, mid, false);
      status.className = `mc-status ${r.ok ? 'ok' : 'err'}`;
      status.textContent = r.ok ? `${tr('Works', 'Работает')} · ${((r.firstTokenMs || r.ms) / 1000).toFixed(1)} ${tr('s', 'с')} · «${String(r.text || '').trim().slice(0, 60)}»` : String(r.error || 'Error').slice(0, 400);
    } catch (err) { status.className = 'mc-status err'; status.textContent = err.message; }
    testBtn.disabled = false;
  } });
  const body = h('div', { class: `mc-body ${openModel.has(p.id) || !m.id ? '' : 'hidden'}` });
  const headEl = h('div', { class: 'mc-head' },
    modelIcon(m, 34),
    h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'row', style: { gap: '8px' } }, title, isDefault ? h('span', { class: 'mc-badge' }, tr('default', 'по умолчанию')) : null), sub),
    testBtn,
    iconBtn('trash', t('delete'), async (e) => {
      e.stopPropagation();
      if (!(await confirmDialog(tr('Delete model', 'Удалить модель'), m.name || m.id || '', t('delete'), true))) return;
      await api.invoke('secrets:set', p.id, '');
      const rest = all().filter((x) => x.id !== p.id);
      const patch = { providers: rest };
      if (isDefault) patch.defaultModel = rest[0] && rest[0].models[0] ? { providerId: rest[0].id, modelId: rest[0].models[0].id } : null;
      await save(patch);
      rerender();
    }));
  headEl.addEventListener('click', (e) => { if (e.target.closest('button')) return; body.classList.toggle('hidden'); if (body.classList.contains('hidden')) openModel.delete(p.id); else openModel.add(p.id); });

  const idIn = h('input', { class: 'input big', value: m.id || '', placeholder: 'glm-5.2 · gpt-5.5 · claude-sonnet-5-5 · kimi-k3 …', spellcheck: 'false' });
  idIn.addEventListener('change', async () => {
    const v = idIn.value.trim();
    await put({}, { id: v });
    title.textContent = (p.models[0] && p.models[0].name) || v || tr('New model', 'Новая модель');
    const ref = S().defaultModel;
    if (!ref || ref.providerId === p.id) { await save({ defaultModel: { providerId: p.id, modelId: v } }); state.modelRef = { providerId: p.id, modelId: v }; }
  });
  const urlIn = h('input', { class: 'input big', value: p.baseUrl || '', placeholder: 'https://api.example.com/v1', spellcheck: 'false' });
  const protoSel = select(PROTOCOLS(), p.protocol || 'openai', async (v) => { await put({ protocol: v, authStyle: authOf(v, urlIn.value) }, {}); rerender(); });
  urlIn.addEventListener('change', async () => {
    const u = urlIn.value.trim();
    const proto = detectProto(u) === 'openai' && p.protocol === 'openai-responses' ? p.protocol : detectProto(u);
    await put({ baseUrl: u, protocol: proto, authStyle: authOf(proto, u) }, {});
    protoSel.value = proto; sub.textContent = u.replace(/^https?:\/\//, '');
  });
  const keyIn = h('input', { class: 'input big', type: 'password', autocomplete: 'off', placeholder: keyHint ? (keyHint.endsWith('↺') ? tr(`Same key as another model on this endpoint (${keyHint.replace(' ↺', '')})`, `Общий ключ с другой моделью на этом адресе (${keyHint.replace(' ↺', '')})`) : `${tr('Saved', 'Сохранён')}: ${keyHint}`) : tr('Paste the API key', 'Вставь API-ключ') });
  keyIn.addEventListener('change', async () => {
    const v = keyIn.value.trim(); if (!v) return;
    const hint = await api.invoke('secrets:set', p.id, v); state.keyHints[p.id] = hint;
    keyIn.value = ''; keyIn.placeholder = `${tr('Saved', 'Сохранён')}: ${hint}`;
    toast(tr('Key saved', 'Ключ сохранён'), 'ok', 1500);
  });
  const nameIn = input(m.name && m.name !== m.id ? m.name : '', async (v) => { await put({}, { name: v.trim() }); title.textContent = v.trim() || m.id; }, { placeholder: tr('Optional — how it shows in the list', 'Необязательно — как показывать в списке') });

  const more = h('div', { class: 'mc-more hidden' },
    field(tr('Protocol', 'Протокол'), tr('Detected from the endpoint', 'Определяется по адресу'), protoSel),
    field(tr('Key header', 'Заголовок ключа'), null, select(AUTHS(), p.authStyle || 'bearer', (v) => put({ authStyle: v }))),
    field(tr('Context window', 'Контекст'), tr('tokens', 'токенов'), input(m.contextWindow, (v) => put({}, { contextWindow: v || 128000 }), { type: 'number', min: 1000, step: 1000 })),
    field(tr('Max answer', 'Макс. ответ'), tr('tokens', 'токенов'), input(m.maxOutput, (v) => put({}, { maxOutput: v || 8192 }), { type: 'number', min: 256, step: 256 })),
    field(tr('Reasoning', 'Размышления'), tr('How thinking is turned on for this model', 'Как включать размышления у этой модели'), select(REASONING_STYLES, m.reasoningStyle || 'none', (v) => put({}, { reasoningStyle: v }))),
    field(tr('Images', 'Картинки'), tr('The model accepts images', 'Модель принимает картинки'), toggle(!!m.vision, (v) => put({}, { vision: v }))),
    field(tr('Default', 'По умолчанию'), null, toggle(isDefault, async (v) => { if (v) { await save({ defaultModel: { providerId: p.id, modelId: (p.models[0] || {}).id } }); state.modelRef = S().defaultModel; rerender(); } })));
  const moreBtn = h('button', { class: 'mc-more-btn', onclick: () => { more.classList.toggle('hidden'); moreBtn.classList.toggle('open'); } }, icon('chevron'), tr('More settings', 'Дополнительно'));

  body.append(
    field(tr('Model ID', 'ID модели'), tr('Exactly as the API expects it', 'Точно как его ждёт API'), idIn),
    field(tr('Endpoint', 'Адрес API'), tr('Base URL, e.g. …/v1', 'Базовый адрес, например …/v1'), urlIn),
    field(tr('API key', 'API-ключ'), tr('Stored encrypted on this computer', 'Хранится зашифрованным на этом компьютере'), keyIn),
    field(tr('Name', 'Название'), null, nameIn),
    moreBtn, more, status);
  if (!m.id) setTimeout(() => idIn.focus(), 30);
  return h('div', { class: 'card mc' }, headEl, body);
}

// ---------- MCP server editor ----------
function editServer(s, onSave) {
  const cur = { id: `mcp-${Math.random().toString(36).slice(2, 8)}`, name: '', type: 'stdio', command: '', args: [], env: {}, url: '', headers: {}, enabled: true, ...(s || {}) };
  let type = cur.type || 'stdio';
  const name = h('input', { class: 'input', value: cur.name, placeholder: 'my-server' });
  const command = h('input', { class: 'input', value: cur.command || '', placeholder: 'npx' });
  const args = h('textarea', { class: 'textarea', rows: 3, placeholder: '-y\n@scope/mcp-server\n{{workspace}}' });
  args.value = (cur.args || []).join('\n');
  const env = h('textarea', { class: 'textarea', rows: 3, placeholder: 'API_KEY=…' });
  env.value = Object.entries(cur.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  const url = h('input', { class: 'input', value: cur.url || '', placeholder: 'https://example.com/mcp' });
  const headers = h('textarea', { class: 'textarea', rows: 3 });
  headers.value = JSON.stringify(cur.headers || {}, null, 2);
  const paste = h('textarea', { class: 'textarea', rows: 4, placeholder: '{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "…"] } } }' });
  const stdioBox = h('div', null, field('Command', null, command), field('Arguments', tr('One per line. {{workspace}} = open folder', 'По одному на строку. {{workspace}} — открытая папка'), args, true), field('Env', 'KEY=VALUE', env, true));
  const httpBox = h('div', null, field('URL', tr('Streamable HTTP endpoint', 'Streamable HTTP endpoint'), url), field('Headers', 'JSON', headers, true));
  const sync = () => { stdioBox.style.display = type === 'stdio' ? '' : 'none'; httpBox.style.display = type === 'http' ? '' : 'none'; };
  const typeSeg = seg([{ value: 'stdio', label: 'stdio (local)' }, { value: 'http', label: 'HTTP (remote)' }], type, (v) => { type = v; sync(); });
  paste.addEventListener('change', () => {
    try {
      let j = JSON.parse(paste.value);
      if (j.mcpServers) { const [k, v] = Object.entries(j.mcpServers)[0]; j = { name: k, ...v }; }
      if (j.name) name.value = j.name;
      if (j.url) { type = 'http'; typeSeg.setValue('http'); url.value = j.url; headers.value = JSON.stringify(j.headers || {}, null, 2); }
      else { type = 'stdio'; typeSeg.setValue('stdio'); command.value = j.command || ''; args.value = (j.args || []).join('\n'); env.value = Object.entries(j.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'); }
      sync();
    } catch { toast('Invalid JSON', 'error'); }
  });
  sync();
  const m = modal({
    title: s ? tr('Edit MCP server', 'Изменить MCP-сервер') : tr('Add MCP server', 'Добавить MCP-сервер'), size: 'md',
    body: h('div', null, field(tr('Name', 'Название'), null, name), field(tr('Transport', 'Транспорт'), null, typeSeg), stdioBox, httpBox,
      field(tr('…or paste JSON config', '…или вставь JSON-конфиг'), tr('From Cursor, Claude Desktop or a README', 'Из Cursor, Claude Desktop или README'), paste, true)),
    footer: [btn('Cancel', { onclick: () => m.close() }), btn(t('save'), { cls: 'primary', onclick: () => {
      let hdr = {};
      try { hdr = JSON.parse(headers.value || '{}'); } catch { toast('Headers: invalid JSON', 'error'); return; }
      const envObj = {};
      for (const line of env.value.split('\n')) { const i = line.indexOf('='); if (i > 0) envObj[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      const out = { ...cur, name: name.value.trim() || 'mcp', type, command: command.value.trim(), args: args.value.split('\n').map((x) => x.trim()).filter(Boolean), env: envObj, url: url.value.trim(), headers: hdr };
      if (type === 'stdio' && !out.command) { toast(tr('Command is required', 'Нужна команда'), 'error'); return; }
      if (type === 'http' && !out.url) { toast(tr('URL is required', 'Нужен URL'), 'error'); return; }
      m.close();
      onSave(out);
    } })],
  });
}


const KEY_COMMANDS = [
  ['quick-open', () => tr('Go to file', 'Перейти к файлу'), 'Cmd+P'], ['palette', () => tr('Command palette', 'Палитра команд'), 'Cmd+Shift+P'], ['search', () => tr('Find in files', 'Поиск по файлам'), 'Cmd+Shift+F'],
  ['toggle-agent', () => tr('Toggle agent panel', 'Панель агента'), 'Cmd+Alt+B'], ['focus-chat', () => tr('Add selection to chat', 'Выделение в чат'), 'Cmd+L'], ['new-chat', () => t('newChat'), 'Cmd+Shift+L'],
  ['new-chat-tab', () => tr('New chat tab', 'Новая вкладка чата'), 'Cmd+T'], ['inline-edit', () => tr('Inline edit / terminal command', 'Правка в коде / команда терминала'), 'Cmd+K'],
  ['mode-agent', () => t('agent'), 'Cmd+1'], ['mode-ask', () => t('ask'), 'Cmd+2'], ['mode-plan', () => t('plan'), 'Cmd+3'], ['mode-debug', () => tr('Debug', 'Отладка'), 'Cmd+4'],
  ['toggle-sidebar', () => tr('Toggle sidebar', 'Боковая панель'), 'Cmd+B'], ['toggle-panel', () => tr('Toggle terminal', 'Терминал'), 'Cmd+J'], ['new-terminal', () => t('newTerminal'), 'Ctrl+Shift+`'],
  ['split-editor', () => tr('Split editor', 'Разделить редактор'), 'Cmd+\\'], ['problems', () => tr('Problems', 'Проблемы'), 'Cmd+Shift+M'],
  ['save', () => t('save'), 'Cmd+S'], ['save-all', () => tr('Save all', 'Сохранить всё'), 'Cmd+Alt+S'], ['new-file', () => t('newFile'), 'Cmd+N'], ['open-folder', () => t('openFolder'), 'Cmd+O'],
  ['close-tab', () => tr('Close tab', 'Закрыть вкладку'), 'Cmd+W'], ['explorer', () => tr('Explorer', 'Проводник'), 'Cmd+Shift+E'], ['git', () => 'Source control', 'Ctrl+Shift+G'], ['plugins', () => tr('Plugins & MCP', 'Плагины и MCP'), 'Cmd+Shift+X'],
  ['settings', () => t('settings'), 'Cmd+,'], ['compact', () => tr('Compact context', 'Сжать контекст'), ''], ['review', () => tr('AI review', 'ИИ-ревью'), ''], ['show-browser', () => tr('Agent browser', 'Браузер агента'), ''],
];

function prettyAcc(a) { return String(a || '').replace(/Cmd\+?/g, '⌘').replace(/Shift\+?/g, '⇧').replace(/Alt\+?/g, '⌥').replace(/Ctrl\+?/g, '⌃'); }
function fmtTok(n) { if (!n) return '0'; if (n < 1000) return String(n); if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k'; return (n / 1e6).toFixed(2) + 'M'; }

function themeField(e, se) {
  const cur = e.theme && e.theme.name ? e.theme.name : 'Enide';
  const b = btn(cur, { cls: 'sm', icon: 'eye', onclick: async (ev) => {
    const anchor = ev.currentTarget;
    let themes = [];
    try { themes = await api.invoke('themes:list'); } catch {}
    popMenu(anchor, [
      { label: 'Enide (default)', on: !e.theme, onclick: () => se({ theme: null }) },
      { label: tr('Import theme .json…', 'Импорт темы .json…'), icon: 'download', onclick: async () => { try { const th = await api.invoke('themes:pick-file'); if (th) se({ theme: { name: th.name, data: th.data, terminal: th.terminal } }); } catch (err) { toast(err.message, 'error'); } } },
      ...(themes.length ? [{ header: tr('Installed in VS Code / Cursor', 'Установлены в VS Code / Cursor') }] : [{ header: tr('No VS Code / Cursor themes found', 'Темы VS Code / Cursor не найдены') }]),
      ...themes.map((th) => ({ label: th.label, sub: th.from, on: e.theme && e.theme.name === th.label, onclick: async () => { try { const r = await api.invoke('themes:load', th.path, th.uiTheme); se({ theme: { name: th.label, data: r.data, terminal: r.terminal } }); toast(`${th.label} ✓`, 'ok', 1500); } catch (err) { toast(err.message, 'error'); } } })),
    ], { search: tr('Search themes', 'Поиск тем'), minWidth: 320 });
  } });
  return field(tr('Editor color theme', 'Цветовая тема редактора'), tr('Pick any theme installed in VS Code or Cursor, or import a theme .json. The Enide interface stays black.', 'Любая тема из VS Code или Cursor, или импорт .json. Интерфейс Enide остаётся чёрным.'), b);
}

async function hooksSection(main, rerender) {
  const hk = S().hooks || {};
  const wrap = h('div');
  main.append(wrap);
  wrap.append(
    field(tr('Hooks enabled', 'Хуки включены'), tr('Your shell commands around agent actions — format, lint, block commands, notify. Same JSON format as Claude Code (.claude/settings.json).', 'Свои shell-команды вокруг действий агента — форматирование, линт, запрет команд, уведомления. Формат как в Claude Code (.claude/settings.json).'), toggle(hk.enabled !== false, (v) => save({ hooks: { enabled: v } }))),
    field(tr('Use project hooks', 'Хуки проекта'), '.enide/hooks.json · .claude/settings.json · .claude/settings.local.json', toggle(hk.importClaude !== false, (v) => save({ hooks: { importClaude: v } }))),
    field(tr('Global hooks (JSON)', 'Глобальные хуки (JSON)'), h('span', null, tr('Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop. Exit code 2 blocks / sends stderr to the agent. Env: $ENIDE_FILE, $ENIDE_COMMAND, $ENIDE_PROJECT_DIR.', 'События: PreToolUse, PostToolUse, UserPromptSubmit, Stop. Код выхода 2 — блок / stderr уходит агенту. Переменные: $ENIDE_FILE, $ENIDE_COMMAND, $ENIDE_PROJECT_DIR.')),
      textarea(JSON.stringify((hk.config && hk.config.hooks && Object.keys(hk.config.hooks).length) ? hk.config : HOOK_EXAMPLE, null, 2), (v) => { try { const j = JSON.parse(v || '{}'); save({ hooks: { config: j.hooks ? j : { hooks: j } } }).then(rerender); } catch { toast('Invalid JSON', 'error'); } }, 10), true));
  try {
    const loaded = await api.invoke('hooks:list');
    wrap.append(field(tr('Active hooks', 'Активные хуки'), null, loaded.length ? h('div', null, ...loaded.map((g) => h('div', { class: 'mono', style: { fontSize: '11.5px', padding: '3px 0' } }, `${g.event}${g.matcher ? ` [${g.matcher}]` : ''} · ${g.source}: ${g.hooks.map((x) => x.command).join(' ; ').slice(0, 120)}`))) : h('span', { class: 'muted' }, tr('none', 'нет'))));
  } catch {}
}

const HOOK_EXAMPLE = { hooks: {
  PostToolUse: [{ matcher: 'edit_file|write_file', hooks: [{ type: 'command', command: 'case "$ENIDE_FILE" in *.ts|*.tsx|*.js|*.css) npx --no-install prettier --write "$ENIDE_FILE" >/dev/null 2>&1 || true;; esac' }] }],
  PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'echo "$ENIDE_COMMAND" | grep -qE "rm -rf|DROP TABLE" && { echo "Destructive command blocked by hook" >&2; exit 2; } || exit 0' }] }],
} };
