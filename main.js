const { app, BrowserWindow, globalShortcut, screen, ipcMain, shell, net, dialog, nativeImage, desktopCapturer, Tray, Menu, powerMonitor } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
// username бота продаж без @ (см. tools/bot/README.txt). Пусто — «Купить» открывает личку автора.
const BUY_BOT = 'IslandForWindowsBot';
const LIC = require('./license').create(app.getPath('userData'));
// Серверная проверка ключа (тот же Cloudflare Worker, что и бот продаж) — защита от локального
// взлома license.js: если ключ отозван автором через /revoke в боте, Pro снимется в течение суток
// у всех, кто не отключил себе интернет совсем.
const VERIFY_URL = 'https://proud-morning-91a0.korzyy52.workers.dev/verify';

const W = 440;
const H = 500; // высоты окна хватает с запасом под самую высокую вкладку (Дизайн, 480px) — иначе низ панели обрезается
// Данные (заметки, настройки, лог) храним в папке профиля пользователя — при установке
// файлы программы лежат в Program Files, куда без прав администратора нельзя писать.
const DATA_DIR = app.getPath('userData');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
// .ps1-скрипты и иконки после упаковки лежат рядом с app.asar, а не внутри него
// (spawn не может запустить файл из архива), поэтому берём их оттуда.
const RES_DIR = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : __dirname;
function dataPath(name) { return path.join(DATA_DIR, name); }
function resPath(name) { return path.join(RES_DIR, name); }
let win = null;
let ps = null;
const LOG = dataPath('media.log');
function log(m) {
  try { fs.appendFileSync(LOG, new Date().toLocaleTimeString('ru-RU') + ' ' + m + '\n'); } catch (e) {}
}
process.on('uncaughtException', (e) => { try { fs.appendFileSync(LOG, new Date().toLocaleTimeString('ru-RU') + ' UNCAUGHT: ' + (e && e.stack || e) + '\n'); } catch (x) {} });
process.on('unhandledRejection', (e) => { try { fs.appendFileSync(LOG, new Date().toLocaleTimeString('ru-RU') + ' UNHANDLED: ' + (e && e.stack || e) + '\n'); } catch (x) {} });
let lastKey = '';
const CMD_FILE = path.join(os.tmpdir(), 'dynamic-island-media-cmd.txt');

// Повторный запуск (например, start.bat) закрывает старый остров и стартует заново.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  if (process.argv.indexOf('--retry') === -1) {
    setTimeout(() => {
      app.relaunch({ args: process.argv.slice(1).concat('--retry') });
      app.exit(0);
    }, 1500);
  } else {
    app.exit(0);
  }
} else {
  app.on('second-instance', () => app.quit());
}


// ---- Видимость: автоскрытие в браузерах и полноэкранных окнах ----
const BROWSERS = ['chrome', 'msedge', 'firefox', 'opera', 'opera_gx', 'brave', 'vivaldi', 'browser', 'iexplore', 'arc', 'zen', 'librewolf', 'waterfox', 'tor'];
let extraHide = [];
let autoHide = true;
let notifOn = true; // показывать сообщения Discord/Telegram в острове
let LANG = 'ru'; // 'ru' | 'en' — текущий язык интерфейса
let langChosen = false; // true, если язык уже был выбран (ключ lang есть в settings.json)
const SETTINGS_FILE = dataPath('settings.json');
try {
  const st = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (Array.isArray(st.hideApps)) extraHide = st.hideApps.map((x) => String(x).toLowerCase());
  if (st.autoHide === false) autoHide = false;
  if (st.notifOn === false) notifOn = false;
  if (st.lang === 'en' || st.lang === 'ru') { LANG = st.lang; langChosen = true; }
} catch (e) {}
// Словарь строк хост-процесса (трей, диалоги, приветствие) — переводится на английский по LANG.
const STR = {
  ru: {
    fullscreen: 'полный экран', browser: 'браузер', manually: 'вручную',
    hideHint: 'Ctrl+Alt+H — скрыть остров',
    hiddenHintPrefix: 'Остров скрыт (', hiddenHintSuffix: ')  ·  Ctrl+Alt+S — показать',
    morning: 'Доброе утро', afternoon: 'Добрый день', evening: 'Добрый вечер', night: 'Доброй ночи',
    welcomeBack: '👋 С возвращением',
    trayHide: 'Скрыть остров', trayShow: 'Показать остров', trayAutoHide: 'Автоскрытие (браузер, полный экран)',
    trayDnd: 'Не беспокоить', trayShot: 'Скриншот области', trayAutostart: 'Запускать вместе с Windows',
    trayQuit: 'Выход', trayTooltip: 'Island for Windows — клик: показать или скрыть',
    pickAppTitle: 'Выбери приложение или ярлык', pickAppFilter: 'Приложения и ярлыки', allFiles: 'Все файлы',
    pickImageTitle: 'Выбери фото для фона острова', imagesFilter: 'Изображения',
    pickSoundTitle: 'Выбери звук для уведомлений', audioFilter: 'Аудио'
  },
  en: {
    fullscreen: 'fullscreen', browser: 'browser', manually: 'manually',
    hideHint: 'Ctrl+Alt+H — hide the island',
    hiddenHintPrefix: 'Island hidden (', hiddenHintSuffix: ')  ·  Ctrl+Alt+S — show',
    morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Good night',
    welcomeBack: '👋 Welcome back',
    trayHide: 'Hide the island', trayShow: 'Show the island', trayAutoHide: 'Auto-hide (browser, fullscreen)',
    trayDnd: 'Do Not Disturb', trayShot: 'Area screenshot', trayAutostart: 'Start with Windows',
    trayQuit: 'Quit', trayTooltip: 'Island for Windows — click: show or hide',
    pickAppTitle: 'Choose an app or shortcut', pickAppFilter: 'Apps and shortcuts', allFiles: 'All files',
    pickImageTitle: 'Choose a photo for the island background', imagesFilter: 'Images',
    pickSoundTitle: 'Choose a notification sound', audioFilter: 'Audio'
  }
};
function L(key) { return (STR[LANG] && STR[LANG][key]) || STR.ru[key] || key; }
function setLang(l) {
  LANG = l === 'en' ? 'en' : 'ru';
  langChosen = true;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (e) {}
  st.lang = LANG;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(st, null, 1)); } catch (e) { log('settings save error: ' + e.message); }
  return LANG;
}
function setAutoHide(on) {
  autoHide = !!on;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (e) {}
  st.autoHide = autoHide;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(st, null, 1)); } catch (e) { log('settings save error: ' + e.message); }
  if (!autoHide && override === 'hide') override = null; // ручное скрытие не снимаем, только автоматику
  applyVisibility(false);
}
let fg = { proc: '', full: false };
let mediaPlaying = false; // играет ли сейчас трек (в т.ч. в браузере)
let override = null; // 'show' | 'hide' | null
let visible = true;
let hideTimer = null;

function hideReason() {
  if (!autoHide) return '';
  if (fg.full) return L('fullscreen');
  if (BROWSERS.indexOf(fg.proc) >= 0 && !mediaPlaying) return L('browser');
  if (extraHide.indexOf(fg.proc) >= 0) return fg.proc;
  return '';
}
function applyVisibility(byUser) {
  if (!win || win.isDestroyed()) return;
  const want = override === 'show' ? true : override === 'hide' ? false : !hideReason();
  if (want === visible) return;
  if (want && !byUser && Date.now() < shotUntil) return;
  visible = want;
  clearTimeout(hideTimer);
  if (visible) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.showInactive();
    win.moveTop();
    setTimeout(() => { if (win && !win.isDestroyed()) win.moveTop(); }, 300);
    win.webContents.send('vis', { visible: true, hint: L('hideHint'), hintMs: 3500 });
  } else {
    const why = override === 'hide' ? L('manually') : hideReason();
    win.webContents.send('vis', { visible: false, hint: L('hiddenHintPrefix') + why + L('hiddenHintSuffix'), hintMs: 5000 });
    hideTimer = setTimeout(() => { if (!visible && win && !win.isDestroyed()) win.hide(); }, 6000);
  }
  log('visible=' + visible + ' override=' + override + ' fg=' + fg.proc + ' full=' + fg.full);
}
function handleFg(d) {
  const proc = String(d.proc || '');
  if (SELF_PROCS.indexOf(proc) >= 0) return; // сам остров
  trackApp(proc, String(d.path || ''));
  setTimeout(() => captureBlur(false), 300);
  if (focus) { focusAccrue(); focus.cur = proc; }
  if (proc !== fg.proc && override === 'show') override = null;
  fg = { proc, full: !!d.full };
  applyVisibility(false);
}

// ---- «Не беспокоить»: уведомления Windows + учёт времени в приложениях ----
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';
const REG_VAL = 'NOC_GLOBAL_SETTING_TOASTS_ENABLED';
const FSTATE = dataPath('focus-state.json');
let focus = null; // { cur, since, apps: {proc: sec}, timer }
let dndPrev = 1;
let dndSet = false;

function regQuerySync() {
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', REG_VAL], { windowsHide: true, encoding: 'utf8' });
    const mm = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(out || '');
    return mm ? parseInt(mm[1], 16) : 1;
  } catch (e) { return 1; }
}
const TOAST_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';
function toastSetSync(v) {
  try { execFileSync('reg', ['add', TOAST_KEY, '/v', 'ToastEnabled', '/t', 'REG_DWORD', '/d', String(v), '/f'], { windowsHide: true }); }
  catch (e) { log('toast reg error: ' + e.message); }
}
function regSetSync(v) {
  toastSetSync(v);
  try { execFileSync('reg', ['add', REG_KEY, '/v', REG_VAL, '/t', 'REG_DWORD', '/d', String(v), '/f'], { windowsHide: true }); }
  catch (e) { log('reg add error: ' + e.message); }
}
function dndOn() {
  if (process.platform !== 'win32' || dndSet) return;
  dndPrev = regQuerySync();
  if (dndPrev !== 0) {
    try { fs.writeFileSync(FSTATE, JSON.stringify({ restore: true })); } catch (e) {}
    regSetSync(0);
    dndSet = true;
  }
  log('dnd on, previous=' + dndPrev);
}
function dndOff() {
  if (process.platform !== 'win32') return;
  if (dndSet) { regSetSync(1); dndSet = false; }
  try { fs.unlinkSync(FSTATE); } catch (e) {}
  log('dnd off');
}
// Если остров упал во время фокуса, возвращаем уведомления при следующем запуске.
try { if (process.platform === 'win32' && fs.existsSync(FSTATE)) { regSetSync(1); fs.unlinkSync(FSTATE); } } catch (e) {}

const PRETTY_RU = { chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', opera: 'Opera', opera_gx: 'Opera GX', brave: 'Brave', vivaldi: 'Vivaldi', browser: 'Яндекс Браузер',
  explorer: 'Проводник', code: 'VS Code', discord: 'Discord', telegram: 'Telegram', spotify: 'Spotify', steam: 'Steam', notepad: 'Блокнот', claude: 'Claude',
  yandexmusic: 'Яндекс Музыка', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', cmd: 'Командная строка', windowsterminal: 'Терминал', taskmgr: 'Диспетчер задач',
  obs64: 'OBS', slack: 'Slack', whatsapp: 'WhatsApp' };
// Английские варианты только для русскоязычных названий выше — остальные (бренды) совпадают.
const PRETTY_EN = Object.assign({}, PRETTY_RU, {
  browser: 'Yandex Browser', explorer: 'Explorer', notepad: 'Notepad', cmd: 'Command Prompt', windowsterminal: 'Terminal', taskmgr: 'Task Manager'
});
const SELF_PROCS = ['electron', 'dynamic-island-pc', 'dynamic island', 'island for windows', 'island-for-windows'];
const SKIP = ['desktop', 'electron', 'dynamic-island-pc', 'dynamic island', 'island for windows', 'island-for-windows', 'searchhost', 'searchapp', 'shellexperiencehost', 'startmenuexperiencehost', 'lockapp', 'textinputhost', 'screenclippinghost', 'snippingtool', 'applicationframehost'];
function prettyName(p) { const M = LANG === 'en' ? PRETTY_EN : PRETTY_RU; return M[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : '?'); }

function focusAccrue() {
  if (!focus) return;
  const now = Date.now();
  if (focus.cur && SKIP.indexOf(focus.cur) < 0) focus.apps[focus.cur] = (focus.apps[focus.cur] || 0) + (now - focus.since) / 1000;
  focus.since = now;
}
function focusList() {
  return Object.keys(focus.apps).map((k) => ({ name: prettyName(k), sec: focus.apps[k] })).filter((a) => a.sec >= 3).sort((a, b) => b.sec - a.sec);
}
function startFocus() {
  if (focus) return;
  dndOn();
  focus = { cur: fg.proc, since: Date.now(), t0: Date.now(), apps: {}, timer: null };
  focus.timer = setInterval(() => {
    focusAccrue();
    if (win && !win.isDestroyed()) win.webContents.send('focus-live', { cur: prettyName(focus.cur), apps: focusList() });
  }, 1000);
}
function stopFocus() {
  if (!focus) return { apps: [] };
  focusAccrue();
  clearInterval(focus.timer);
  const apps = focusList();
  statsRoll(); stats.focusSec += Math.round((Date.now() - (focus.t0 || Date.now())) / 1000); stats.focusRuns++;
  focus = null;
  dndOff();
  return { apps };
}

// ---- Текущее приложение: время в нём и иконка ----
let appCur = null; // { proc, path, since }
const usage = {}; // сколько секунд за сегодня в каждом приложении
const USAGE_FILE = dataPath('usage.json');
function todayKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
let usageDate = todayKey();
try {
  const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  if (u && u.date === usageDate && u.apps) Object.assign(usage, u.apps);
} catch (e) {}
function usageRoll() {
  const k = todayKey();
  if (k !== usageDate) { Object.keys(usage).forEach((p) => delete usage[p]); usageDate = k; }
}
function usageSave() { try { fs.writeFileSync(USAGE_FILE, JSON.stringify({ date: usageDate, apps: usage })); } catch (e) {} }
const STATS_FILE = dataPath('stats.json');
function freshStats() { return { date: todayKey(), shots: 0, tracks: {}, focusSec: 0, focusRuns: 0, timers: 0 }; }
let stats = freshStats();
try { const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); if (s && s.date === todayKey()) stats = Object.assign(freshStats(), s); } catch (e) {}
function statsRoll() { if (stats.date !== todayKey()) stats = freshStats(); }
function statsSave() { try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch (e) {} }
setInterval(() => { usageSave(); statsSave(); }, 20000);
const iconCache = {};
let iconSent = '';
const HOME_PROCS = ['desktop', 'searchhost', 'searchapp', 'shellexperiencehost', 'startmenuexperiencehost', 'lockapp', 'textinputhost'];
let appNoneSent = false;
function trackApp(proc, p) {
  if (HOME_PROCS.indexOf(proc) >= 0) { appCur = null; appNoneSent = false; return; } // рабочий стол / меню Пуск
  if (!proc || SKIP.indexOf(proc) >= 0) return;
  if (!appCur || appCur.proc !== proc) appCur = { proc, path: p, since: Date.now() };
  else if (!appCur.path && p) appCur.path = p;
  if (iconCache[proc] === undefined && appCur.path) {
    iconCache[proc] = null;
    app.getFileIcon(appCur.path, { size: 'large' }).then((img) => {
      iconCache[proc] = img.isEmpty() ? '' : img.toDataURL();
    }).catch((e) => { iconCache[proc] = ''; log('icon error: ' + e.message); });
  }
}
setInterval(() => {
  if (!appCur) {
    if (!appNoneSent && win && !win.isDestroyed()) { win.webContents.send('app-live', { none: true }); appNoneSent = true; }
    return;
  }
  usageRoll();
  usage[appCur.proc] = (usage[appCur.proc] || 0) + 1;
  if (!win || win.isDestroyed()) return;
  const ic = iconCache[appCur.proc];
  const msg = { proc: appCur.proc, name: prettyName(appCur.proc), sess: Math.floor((Date.now() - appCur.since) / 1000), today: usage[appCur.proc] };
  if (ic && iconSent !== appCur.proc) { msg.icon = ic; iconSent = appCur.proc; }
  win.webContents.send('app-live', msg);
}, 1000);

// ---- Закреплённые программы (группы) ----
const APPS_FILE = dataPath('apps.json');
let appsData = { groups: [] };
try { appsData = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8')); } catch (e) {}
const pinIcons = {};
function pinnedPaths() {
  const set = new Set();
  (appsData.groups || []).forEach((g) => (g.apps || []).forEach((a) => set.add(a.path)));
  return set;
}
function cleanApps(d) {
  const groups = (d && Array.isArray(d.groups) ? d.groups : []).slice(0, 30).map((g) => ({
    id: String(g.id || '').slice(0, 20),
    name: String(g.name || (LANG === 'en' ? 'Group' : 'Группа')).slice(0, 30),
    apps: (Array.isArray(g.apps) ? g.apps : []).slice(0, 200).map((a) => ({
      id: String(a.id || '').slice(0, 20), name: String(a.name || '').slice(0, 60), path: String(a.path || '').slice(0, 500)
    })).filter((a) => a.path)
  }));
  return { groups };
}
function imgToUrl(img) { return img && !img.isEmpty() ? img.resize({ width: 64, quality: 'best' }).toDataURL() : ''; }
function fileToUrl(f) {
  try {
    const buf = fs.readFileSync(f);
    const ext = path.extname(f).toLowerCase();
    return 'data:image/' + (ext === '.png' ? 'png' : 'jpeg') + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; }
}
// Иконка файла: для .url (Steam и др.) берём IconFile из ярлыка или картинку из кэша Steam.
async function urlShortcutIcon(p) {
  let txt = '';
  try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
  const iconM = /^IconFile=(.+)$/mi.exec(txt);
  const urlM = /^URL=(.+)$/mi.exec(txt);
  const iconFile = iconM ? iconM[1].trim() : '';
  if (iconFile && fs.existsSync(iconFile)) {
    try {
      if (/\.(ico|png|jpg|jpeg)$/i.test(iconFile)) {
        const u = imgToUrl(nativeImage.createFromPath(iconFile));
        if (u) return u;
      } else {
        const u = imgToUrl(await app.getFileIcon(iconFile, { size: 'large' }));
        if (u) return u;
      }
    } catch (e) { log('url icon error: ' + e.message); }
  }
  const idM = urlM ? /rungameid\/(\d+)/i.exec(urlM[1]) : null;
  if (idM) {
    const id = idM[1];
    const roots = [];
    const sm = iconFile ? /^(.*?\\steam)\\/i.exec(iconFile) : null;
    if (sm) roots.push(sm[1]);
    roots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
    for (const r of roots) {
      const lc = path.join(r, 'appcache', 'librarycache');
      const old = path.join(lc, id + '_icon.jpg');
      if (fs.existsSync(old)) { const u = fileToUrl(old); if (u) return u; }
      const dir = path.join(lc, id);
      try {
        const files = [];
        const walk = (d, depth) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
          const fp = path.join(d, e.name);
          if (e.isDirectory() && depth < 2) walk(fp, depth + 1);
          else if (/\.(jpg|png)$/i.test(e.name)) files.push({ fp, size: fs.statSync(fp).size });
        });
        walk(dir, 0);
        files.sort((x, y) => x.size - y.size);
        const pick = files.find((f) => f.size > 1500) || files[0];
        if (pick) { const u = fileToUrl(pick.fp); if (u) return u; }
      } catch (e) {}
      const flat = path.join(lc, id + '_library_600x900.jpg');
      if (fs.existsSync(flat)) { const u = fileToUrl(flat); if (u) return u; }
    }
  }
  return '';
}
// У ярлыков приложений из Microsoft Store (Claude, Telegram и др.) нет обычной иконки: берём её по AppUserModelID.
function aumidFromLnk(p) {
  try {
    const buf = fs.readFileSync(p);
    const re = /([A-Za-z0-9.\-]+_[a-z0-9]{13}![A-Za-z0-9._\-]+)/;
    for (const s of [buf.toString('utf16le'), buf.slice(1).toString('utf16le')]) {
      const mm = re.exec(s);
      if (mm) return mm[1];
    }
  } catch (e) {}
  return '';
}
function shellIcon(parse) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), 'dynamic-island-icon-' + Math.random().toString(36).slice(2) + '.png');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resPath('icon.ps1'), '-Parse', parse, '-Out', out],
      { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        log('icon.ps1 ' + parse + ' -> ' + String(stdout || '').trim().slice(0, 120) + (err ? ' err=' + err.message : ''));
        let url = '';
        try { url = fileToUrl(out); fs.unlinkSync(out); } catch (e) {}
        resolve(url);
      });
  });
}
async function pinIcon(p) {
  if (pinIcons[p] !== undefined) return pinIcons[p];
  let url = '';
  if (/\.lnk$/i.test(p)) {
    const id = aumidFromLnk(p);
    if (id) url = await shellIcon('shell:AppsFolder\\' + id);
  }
  if (/\.url$/i.test(p)) url = await urlShortcutIcon(p);
  if (!url) {
    let target = p;
    if (/\.lnk$/i.test(p)) {
      try {
        const sl = shell.readShortcutLink(p);
        if (sl.icon && fs.existsSync(sl.icon)) target = sl.icon;
        else if (sl.target) target = sl.target;
      } catch (e) {}
    }
    try { url = imgToUrl(await app.getFileIcon(target, { size: 'large' })); } catch (e) { log('icon error: ' + e.message); }
  }
  pinIcons[p] = url;
  log('pin icon ' + p + ' -> ' + (url ? url.length + ' bytes' : 'none'));
  return url;
}

// ---- Заметки и напоминания ----
const NOTES_FILE = dataPath('notes.json');
let notesData = { notes: [] };
try { notesData = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch (e) {}
function cleanNotes(d) {
  const arr = d && Array.isArray(d.notes) ? d.notes : [];
  return { notes: arr.slice(0, 300).map((n) => ({
    id: String(n.id || '').slice(0, 20), text: String(n.text || '').slice(0, 300),
    body: String(n.body || '').slice(0, 5000),
    due: Number(n.due) > 0 ? Number(n.due) : 0, done: !!n.done, n30: !!n.n30, nd: !!n.nd, created: Number(n.created) || 0
  })).filter((n) => n.text || n.body) };
}

// ---- Избранные треки ----
const FAVS_FILE = dataPath('favorites.json');
let favsData = { items: [] };
try { favsData = JSON.parse(fs.readFileSync(FAVS_FILE, 'utf8')); } catch (e) {}
function cleanFavs(d) {
  const arr = d && Array.isArray(d.items) ? d.items : [];
  return { items: arr.slice(0, 200).map((f) => ({
    key: String(f.key || '').slice(0, 300), title: String(f.title || '').slice(0, 200),
    artist: String(f.artist || '').slice(0, 200), app: String(f.app || '').slice(0, 400),
    cover: typeof f.cover === 'string' ? f.cover.slice(0, 300000) : '', added: Number(f.added) || Date.now()
  })).filter((f) => f.title || f.key) };
}

// ---- Звук уведомлений (таймер/напоминания) ----
const SOUND_META = dataPath('sound.json');
function loadSoundMeta() { try { return JSON.parse(fs.readFileSync(SOUND_META, 'utf8')); } catch (e) { return null; } }
function soundDataUrl() {
  const meta = loadSoundMeta();
  if (!meta || !meta.file) return { url: '', name: '' };
  try {
    const buf = fs.readFileSync(dataPath(meta.file));
    const ext = path.extname(meta.file).toLowerCase();
    const mt = ext === '.mp3' ? 'audio/mpeg' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav';
    return { url: 'data:' + mt + ';base64,' + buf.toString('base64'), name: meta.name || '' };
  } catch (e) { return { url: '', name: '' }; }
}

// ---- Дизайн (тема, фон, фото) ----
const DESIGN_FILE = dataPath('design.json');
const BG_FILE = dataPath('bg.jpg');
function hexOk(s, d) { return /^#[0-9a-f]{6}$/i.test(String(s)) ? String(s) : d; }
function cleanDesign(d) {
  d = d || {};
  const num = (v, lo, hi, def) => { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  return {
    preset: String(d.preset || 'classic').slice(0, 20), mode: d.mode === 'image' ? 'image' : (d.mode === 'blur' ? 'blur' : 'color'),
    color: hexOk(d.color, '#000000'), alpha: num(d.alpha, 15, 100, 100), txt: hexOk(d.txt, '#ffffff'),
    dim: num(d.dim, 0, 85, 35), blur: num(d.blur, 0, 12, 0), bblur: num(d.bblur, 4, 30, 16),
    info: ['pc', 'rem', 'time', 'weather'].indexOf(d.info) >= 0 ? d.info : 'pc'
  };
}
ipcMain.handle('design-load', () => {
  let settings = null, image = '';
  try { settings = cleanDesign(JSON.parse(fs.readFileSync(DESIGN_FILE, 'utf8'))); } catch (e) {}
  try { if (fs.existsSync(BG_FILE)) image = 'data:image/jpeg;base64,' + fs.readFileSync(BG_FILE).toString('base64'); } catch (e) {}
  return { settings, image };
});
ipcMain.handle('design-save', (_e, d) => {
  try { fs.writeFileSync(DESIGN_FILE, JSON.stringify(cleanDesign(d), null, 1)); } catch (e) { log('design save error: ' + e.message); }
  return true;
});
ipcMain.handle('design-image', async () => {
  if (!win || win.isDestroyed()) return '';
  win.setAlwaysOnTop(false);
  let r;
  try {
    r = await dialog.showOpenDialog(win, { title: L('pickImageTitle'), properties: ['openFile'],
      filters: [{ name: L('imagesFilter'), extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }] });
  } finally { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver'); }
  if (!r || r.canceled || !r.filePaths[0]) return '';
  try {
    let img = nativeImage.createFromPath(r.filePaths[0]);
    if (img.isEmpty()) { log('design image: cannot decode'); return ''; }
    const sz = img.getSize();
    if (sz.width > 1000) img = img.resize({ width: 1000, quality: 'good' });
    const buf = img.toJPEG(88);
    fs.writeFileSync(BG_FILE, buf);
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) { log('design image error: ' + e.message); return ''; }
});
ipcMain.handle('design-image-clear', () => { try { fs.unlinkSync(BG_FILE); } catch (e) {} return true; });

// ---- Стекло с блюром: снимаем экран позади острова и размываем в окне ----
// Само окно на время снимка скрывается от захвата, чтобы остров не попал в собственный фон.
let blurOn = false, blurBusy = false, blurLast = 0, blurTimer = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function captureBlur(force) {
  if (!blurOn || blurBusy || !win || win.isDestroyed() || !visible || process.platform !== 'win32') return;
  if (!force && Date.now() - blurLast < 700) return;
  blurBusy = true; blurLast = Date.now();
  try {
    const d = screen.getPrimaryDisplay(), b = d.bounds;
    win.setContentProtection(true);
    await sleep(90);
    const tw = Math.round(b.width * d.scaleFactor * 0.5), th = Math.round(b.height * d.scaleFactor * 0.5);
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: tw, height: th } });
    win.setContentProtection(false);
    const src = srcs.find((s) => String(s.display_id) === String(d.id)) || srcs[0];
    if (!src) return;
    const img = src.thumbnail, ts = img.getSize();
    const f = ts.width / b.width;
    const crop = img.crop({ x: Math.max(0, Math.round((b.width - W) / 2 * f)), y: 0, width: Math.min(ts.width, Math.round(W * f)), height: Math.min(ts.height, Math.round(H * f)) });
    if (win && !win.isDestroyed()) win.webContents.send('blur-bg', crop.toJPEG(72).toString('base64'));
  } catch (e) { log('blur capture error: ' + e.message); }
  finally { try { if (win && !win.isDestroyed()) win.setContentProtection(false); } catch (e) {} blurBusy = false; }
}
function setBlurActive(on) {
  blurOn = !!on;
  clearInterval(blurTimer);
  if (blurOn) { blurTimer = setInterval(() => captureBlur(false), 4000); captureBlur(true); }
}

// ---- Автозапуск с Windows и приветствие ----
const AUTO_FLAG = dataPath('autostart-init.json');
// В собранном .exe двойной клик по иконке и так запускает именно его, аргументы не нужны;
// при запуске из исходников (npm start) Electron нужно указать, какую папку открывать.
function autoArgs() { return app.isPackaged ? [] : [app.getAppPath()]; }
function autoGet() {
  try { return !!app.getLoginItemSettings({ path: process.execPath, args: autoArgs() }).openAtLogin; } catch (e) { return false; }
}
function autoSet(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: autoArgs() }); }
  catch (e) { log('autostart error: ' + e.message); }
}
function greetingText() {
  const h = new Date().getHours();
  let g, e;
  if (h >= 5 && h < 12) { g = L('morning'); e = '☀️'; }
  else if (h >= 12 && h < 17) { g = L('afternoon'); e = '🌤️'; }
  else if (h >= 17 && h < 23) { g = L('evening'); e = '🌆'; }
  else { g = L('night'); e = '🌙'; }
  let n = '';
  try { n = os.userInfo().username || ''; } catch (x) {}
  if (n) n = n.charAt(0).toUpperCase() + n.slice(1);
  return e + ' ' + g + (n ? ', ' + n : '');
}

// ---- Значок в трее (рядом с часами): остров живёт в фоне, управлять можно отсюда ----
let tray = null;
function toggleIsland() {
  override = visible ? 'hide' : 'show';
  applyVisibility(true);
}
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: visible ? L('trayHide') : L('trayShow'), accelerator: 'Ctrl+Alt+H', click: toggleIsland },
    { label: L('trayAutoHide'), type: 'checkbox', checked: autoHide, click: (it) => setAutoHide(it.checked) },
    { label: L('trayDnd'), accelerator: 'Ctrl+Alt+F', click: () => { if (!visible) { override = 'show'; applyVisibility(true); } win && win.webContents.send('focus'); } },
    { label: L('trayShot'), click: () => takeScreenshot() },
    { type: 'separator' },
    { label: L('trayAutostart'), type: 'checkbox', checked: autoGet(), click: (it) => autoSet(it.checked) },
    { type: 'separator' },
    { label: L('trayQuit'), accelerator: 'Ctrl+Alt+Q', click: () => app.quit() }
  ]);
}
function createTray() {
  if (process.platform !== 'win32' || tray) return;
  try {
    const img = nativeImage.createFromPath(resPath(path.join('assets', 'tray.png')));
    tray = new Tray(img);
    tray.setToolTip(L('trayTooltip'));
    tray.on('click', toggleIsland);
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  } catch (e) { log('tray error: ' + e.message); }
}

// ---- Серверная проверка ключа (см. VERIFY_URL выше) ----
// Шлём текущий ключ и код ПК на Cloudflare Worker при активации и раз в сутки, пока включён Pro.
// Если автор отозвал ключ (/revoke в боте) или KV говорит revoked — сбрасываем лицензию локально.
async function licVerify(force) {
  try {
    const key = LIC.currentKey();
    if (!key) return;
    const r = await net.fetch(VERIFY_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, machine: LIC.machine() })
    });
    const j = await r.json();
    if (j && j.ok === false) {
      log('license verify: revoked (' + (j.error || '') + ')');
      LIC.revoke();
      if (win && !win.isDestroyed()) win.webContents.send('lic-revoked');
    }
  } catch (e) { log('license verify error: ' + e.message); } // нет сети — не трогаем лицензию
}

let sysPrev = null;
// ---- Погода (Open-Meteo, местоположение по IP) ----
let wxCache = null, wxAt = 0, wxLoc = null;
async function getWeather() {
  if (wxCache && Date.now() - wxAt < 10 * 60 * 1000) return wxCache;
  try {
    if (!wxLoc) {
      const r = await net.fetch('https://ipwho.is/');
      const j = await r.json();
      if (!j || j.success === false) throw new Error('geo failed');
      wxLoc = { lat: j.latitude, lon: j.longitude, city: j.city || '' };
    }
    const r2 = await net.fetch('https://api.open-meteo.com/v1/forecast?latitude=' + wxLoc.lat + '&longitude=' + wxLoc.lon + '&current=temperature_2m,weather_code,is_day&timezone=auto');
    const j2 = await r2.json();
    const c = j2.current;
    wxCache = { ok: true, temp: c.temperature_2m, code: c.weather_code, isDay: c.is_day === 1, city: wxLoc.city };
    wxAt = Date.now();
    return wxCache;
  } catch (e) {
    log('weather error: ' + e.message);
    return wxCache || { ok: false };
  }
}

// ---- Скриншот области (то же, что Win + Shift + S) ----
let shotUntil = 0;
let shotTimer = null;
function takeScreenshot() {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  log('screenshot: start');
  statsRoll(); stats.shots++;
  shotUntil = Date.now() + 20000;
  visible = false;
  clearTimeout(hideTimer);
  win.webContents.send('vis', { visible: false, hint: '', hintMs: 0 });
  setTimeout(() => {
    shell.openExternal('ms-screenclip:').then(() => log('screenshot: overlay launched')).catch((e) => log('screenclip error: ' + e.message));
  }, 400);
  clearTimeout(shotTimer);
  shotTimer = setTimeout(() => { shotUntil = 0; log('screenshot: restore'); applyVisibility(false); }, 20500);
}

function createWindow() {
  const b = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(b.x + (b.width - W) / 2),
    y: b.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  // Пока курсор не над островом, клики проходят сквозь окно.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on('closed', () => log('window closed'));
  win.webContents.once('did-finish-load', () => setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('greet', greetingText()); }, 900));
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.showInactive());
}

// Медиа: читаем системную медиа-сессию Windows через PowerShell.
function startMedia() {
  if (process.platform !== 'win32') return;
  try { fs.unlinkSync(CMD_FILE); } catch (e) {}
  log('--- start, script: ' + resPath('media.ps1'));
  ps = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', resPath('media.ps1'),
    '-CmdFile', CMD_FILE
  ], { windowsHide: true });

  let buf = '';
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || line[0] !== '{') continue;
      try {
        const data = JSON.parse(line);
        if (data.kind === 'thumb') {
          log('thumb for [' + data.key + '] data length: ' + (data.data ? data.data.length : 0) + (data.data ? ' head=' + data.data.slice(0, 30) : '') + ' why=' + data.why);
        } else if (data.key && data.key !== lastKey) {
          lastKey = data.key;
          if (data.status === 'Playing' && data.title) { statsRoll(); if (!stats.tracks[data.key]) stats.tracks[data.key] = data.artist || ''; }
          log('track [' + data.key + '] status=' + data.status + ' dur=' + data.dur + ' shuffle=' + data.shuffle + ' repeat=' + data.repeat);
        }
        if (data.kind === 'fg') { handleFg(data); continue; }
        if (data.kind === 'info') {
          const mp = !!(data.ok && data.status === 'Playing');
          if (mp !== mediaPlaying) { mediaPlaying = mp; applyVisibility(false); }
        }
        if (win && !win.isDestroyed()) win.webContents.send('media', data);
      } catch (e) {}
    }
  });
  ps.stderr.setEncoding('utf8');
  ps.stderr.on('data', (c) => log('powershell stderr: ' + String(c).slice(0, 500)));
  ps.on('error', (e) => log('spawn error: ' + e.message));
  ps.on('exit', (code) => { log('powershell exited, code ' + code); ps = null; });
}

// Уведомления и звонки Discord/Telegram: читаем системную базу уведомлений Windows (только эти два приложения).
let nps = null;
function startNotif() {
  if (process.platform !== 'win32' || !notifOn || nps) return;
  try {
    nps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resPath('notif.ps1')], { windowsHide: true });
    let buf = '';
    nps.stdout.setEncoding('utf8');
    nps.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || line[0] !== '{') continue;
        try {
          const d = JSON.parse(line);
          if (d.kind === 'diag') log('notif: ' + d.msg);
          else if (d.kind === 'call' && win && !win.isDestroyed()) { log('call ' + d.app + ' active=' + d.active); win.webContents.send('callstate', { app: d.app, active: !!d.active, start: Number(d.start) || 0, who: String(d.who || '') }); }
          else if (d.kind === 'notif' && win && !win.isDestroyed()) win.webContents.send('notif', { app: d.app, title: d.title, text: d.text, avatar: d.avatar || '' });
        } catch (e) {}
      }
    });
    nps.stderr.setEncoding('utf8');
    nps.stderr.on('data', (c) => log('notif stderr: ' + String(c).slice(0, 400)));
    nps.on('error', (e) => log('notif spawn error: ' + e.message));
    nps.on('exit', (code) => { log('notif exited, code ' + code); nps = null; });
  } catch (e) { log('notif start error: ' + e.message); nps = null; }
}
function stopNotif() { if (nps) { try { nps.kill(); } catch (e) {} nps = null; } }
function setNotif(on) {
  notifOn = !!on;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (e) {}
  st.notifOn = notifOn;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(st, null, 1)); } catch (e) { log('settings save error: ' + e.message); }
  if (notifOn) startNotif(); else stopNotif();
}

function stopMedia() {
  if (ps) { try { ps.kill(); } catch (e) {} ps = null; }
  try { fs.unlinkSync(CMD_FILE); } catch (e) {}
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  // Первый запуск (ключа lang ещё нет в settings.json): спрашиваем язык интерфейса —
  // это замена шагу выбора языка в установщике, которого у нас нет (запуск через start.bat).
  if (!langChosen) {
    try {
      const r = await dialog.showMessageBox(null, {
        type: 'none', buttons: ['Русский', 'English'], defaultId: 0, cancelId: 0,
        title: 'Island for Windows', message: 'Выберите язык / Choose your language'
      });
      setLang(r && r.response === 1 ? 'en' : 'ru');
    } catch (e) { setLang('ru'); }
  }
  createWindow();
  // После разблокировки компьютера остров возвращается на экран и здоровается.
  try {
    powerMonitor.on('unlock-screen', () => {
      if (!win || win.isDestroyed()) return;
      win.setAlwaysOnTop(true, 'screen-saver');
      if (visible) {
        win.showInactive(); win.moveTop();
        let n = ''; try { n = os.userInfo().username || ''; } catch (e) {}
        if (n) n = n.charAt(0).toUpperCase() + n.slice(1);
        setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('greet', L('welcomeBack') + (n ? ', ' + n : '')); }, 700);
      }
      log('unlock-screen');
    });
  } catch (e) { log('powerMonitor error: ' + e.message); }
  createTray();
  startMedia();
  setTimeout(startNotif, 2500);
  setTimeout(licVerify, 8000);
  setInterval(licVerify, 24 * 3600 * 1000); // раз в сутки, пока Pro включён
  // При первом запуске включаем автозапуск вместе с Windows (потом его можно выключить во вкладке «Дизайн»).
  if (process.platform === 'win32' && !fs.existsSync(AUTO_FLAG)) {
    autoSet(true);
    try { fs.writeFileSync(AUTO_FLAG, '{"init":true}'); } catch (e) {}
  }

  ipcMain.on('hover', (_e, over) => {
    if (over) captureBlur(false);
    if (win) win.setIgnoreMouseEvents(!over, { forward: true });
  });
  ipcMain.on('media-cmd', (_e, cmd) => {
    if (!/^(toggle|next|prev|shuffle|repeat|seek:\d{1,9})$/.test(cmd)) return;
    try { fs.writeFileSync(CMD_FILE, cmd); } catch (e) {}
  });
  ipcMain.handle('focus', (_e, on) => (on ? (startFocus(), { apps: [] }) : stopFocus()));
  ipcMain.handle('weather', () => getWeather());
  // Нагрузка ПК: процессор (по разнице счётчиков) и память
  ipcMain.handle('sys-stats', () => {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    cpus.forEach((c) => { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; });
    let cpu = 0;
    if (sysPrev && total > sysPrev.total) cpu = Math.round((1 - (idle - sysPrev.idle) / (total - sysPrev.total)) * 100);
    sysPrev = { idle, total };
    cpu = Math.max(0, Math.min(100, cpu));
    const tm = os.totalmem(), fm = os.freemem();
    return { cpu, memTotal: tm, memUsed: tm - fm };
  });
  ipcMain.handle('apps-load', () => appsData);
  ipcMain.handle('apps-save', (_e, d) => {
    appsData = cleanApps(d);
    try { fs.writeFileSync(APPS_FILE, JSON.stringify(appsData, null, 1)); } catch (e) { log('apps save error: ' + e.message); }
    return true;
  });
  ipcMain.handle('apps-pick', async () => {
    if (!win || win.isDestroyed()) return [];
    win.setAlwaysOnTop(false);
    let r;
    try {
      r = await dialog.showOpenDialog(win, {
        title: L('pickAppTitle'), properties: ['openFile', 'multiSelections'],
        filters: [{ name: L('pickAppFilter'), extensions: ['exe', 'lnk', 'bat', 'cmd', 'url'] }, { name: L('allFiles'), extensions: ['*'] }]
      });
    } finally { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver'); }
    if (!r || r.canceled) return [];
    return r.filePaths.map((p) => ({ name: path.basename(p).replace(/\.[^.]+$/, ''), path: p }));
  });
  ipcMain.handle('app-icon', (_e, p) => pinIcon(String(p)));
  ipcMain.handle('app-launch', async (_e, p) => {
    if (!pinnedPaths().has(String(p))) return false;
    if (/\.lnk$/i.test(String(p))) {
      const id = aumidFromLnk(String(p));
      if (id) { spawn('explorer.exe', ['shell:AppsFolder\\' + id], { detached: true, stdio: 'ignore' }).unref(); return true; }
    }
    const err = await shell.openPath(String(p));
    if (err) log('launch error: ' + err);
    return !err;
  });
  ipcMain.handle('notes-load', () => notesData);
  ipcMain.handle('notes-save', (_e, d) => {
    notesData = cleanNotes(d);
    try { fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 1)); } catch (e) { log('notes save error: ' + e.message); }
    return true;
  });
  ipcMain.handle('favs-load', () => favsData);
  ipcMain.handle('favs-save', (_e, d) => {
    favsData = cleanFavs(d);
    try { fs.writeFileSync(FAVS_FILE, JSON.stringify(favsData, null, 1)); } catch (e) { log('favs save error: ' + e.message); }
    return true;
  });
  ipcMain.handle('sound-load', () => soundDataUrl());
  ipcMain.handle('sound-pick', async () => {
    if (!win || win.isDestroyed()) return null;
    win.setAlwaysOnTop(false);
    let r;
    try {
      r = await dialog.showOpenDialog(win, { title: L('pickSoundTitle'), properties: ['openFile'],
        filters: [{ name: L('audioFilter'), extensions: ['mp3', 'wav', 'ogg'] }] });
    } finally { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver'); }
    if (!r || r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const ext = path.extname(src).toLowerCase() || '.mp3';
    const fname = 'alert-sound' + ext;
    try {
      fs.copyFileSync(src, dataPath(fname));
      fs.writeFileSync(SOUND_META, JSON.stringify({ file: fname, name: path.basename(src) }));
    } catch (e) { log('sound pick error: ' + e.message); return null; }
    return soundDataUrl();
  });
  ipcMain.handle('sound-clear', () => {
    const meta = loadSoundMeta();
    try { if (meta && meta.file) fs.unlinkSync(dataPath(meta.file)); } catch (e) {}
    try { fs.unlinkSync(SOUND_META); } catch (e) {}
    return true;
  });
  // «Перейти к треку»: разворачиваем окно приложения-источника или запускаем его.
  ipcMain.handle('media-focus', async (_e, appId) => {
    appId = String(appId || '');
    if (!appId) return false;
    if (appId.indexOf('!') >= 0) {
      try { spawn('explorer.exe', ['shell:AppsFolder\\' + appId], { detached: true, stdio: 'ignore' }).unref(); return true; } catch (e) { return false; }
    }
    const base = path.basename(appId).replace(/\.exe$/i, '').replace(/["'$`]/g, '');
    if (!base) return false;
    const script = 'Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class DIWin{[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int n);}\n"@\n$p = Get-Process -Name "' + base + '" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1\nif ($p) { [DIWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [DIWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; "ok" } else { "none" }';
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        const ok = String(stdout || '').indexOf('ok') >= 0;
        if (!ok && /\.exe$/i.test(appId) && fs.existsSync(appId)) { shell.openPath(appId).then(() => {}); }
        resolve(ok);
      });
    });
  });
  ipcMain.on('stat-add', (_e, name) => { statsRoll(); if (name === 'timer') stats.timers++; });
  // Итоги дня: топ приложений по времени за сегодня
  ipcMain.handle('day-summary', () => {
    usageRoll();
    const list = Object.keys(usage).filter((p) => SKIP.indexOf(p) < 0 && HOME_PROCS.indexOf(p) < 0 && usage[p] >= 5)
      .map((p) => ({ proc: p, name: prettyName(p), sec: usage[p], icon: iconCache[p] || '' }))
      .sort((a, b) => b.sec - a.sec);
    const total = list.reduce((s, a) => s + a.sec, 0);
    statsRoll();
    const ac = {}; Object.keys(stats.tracks).forEach((k) => { const a = stats.tracks[k]; if (a) ac[a] = (ac[a] || 0) + 1; });
    const topArtist = Object.keys(ac).sort((x, y) => ac[y] - ac[x])[0] || '';
    return { date: usageDate, total, apps: list.slice(0, 8), count: list.length,
      shots: stats.shots, tracks: Object.keys(stats.tracks).length, topArtist, focusSec: stats.focusSec + (focus ? Math.round((Date.now() - (focus.t0 || Date.now())) / 1000) : 0), focusRuns: stats.focusRuns + (focus ? 1 : 0), timers: stats.timers };
  });
  // Громкость системы (Windows Core Audio через PowerShell)
  ipcMain.handle('vol', (_e, mode, level) => new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resPath('volume.ps1'), '-Mode', mode === 'set' ? 'set' : 'get'];
    if (mode === 'set') args.push('-Level', String(Math.max(0, Math.min(100, Math.round(Number(level) || 0)))));
    execFile('powershell.exe', args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      const n = parseInt(String(stdout || '').trim(), 10);
      if (err || isNaN(n) || n < 0) log('vol ' + mode + ' ' + level + ' -> ' + String(stdout || '').trim().slice(0, 200) + (err ? ' err=' + String(err.message).slice(0, 300) : '') + ' stderr=' + String(stderr || '').slice(0, 300));
      resolve(isNaN(n) ? -1 : n);
    });
  }));
  ipcMain.handle('lic-status', () => LIC.status());
  ipcMain.handle('lic-machine', () => LIC.machine());
  ipcMain.handle('lic-activate', async (_e, k) => {
    const r = LIC.activate(String(k || '').slice(0, 300));
    if (r && r.ok) await licVerify(true);
    return LIC.status().pro ? r : (r.ok ? { ok: false, error: 'revoked' } : r);
  });
  ipcMain.on('open-buy', () => {
    const u = BUY_BOT ? 'https://t.me/' + BUY_BOT + '?start=' + encodeURIComponent(LIC.machine()) : 'https://t.me/corzyyy';
    shell.openExternal(u).catch((e) => log('open buy error: ' + e.message));
  });
  ipcMain.on('open-tg', () => { shell.openExternal('https://t.me/corzyyy').catch((e) => log('open tg error: ' + e.message)); });
  // Открыть лайкнутый трек: поиск по названию в сервисе, где он играл.
  ipcMain.handle('media-open-track', async (_e, t) => {
    t = t || {};
    const q = [t.artist, t.title].filter(Boolean).join(' ').trim();
    const app_ = String(t.app || '').toLowerCase();
    if (!q) return false;
    try {
      if (app_.indexOf('spotify') >= 0) { await shell.openExternal('spotify:search:' + encodeURIComponent(q)); return true; }
      if (app_.indexOf('yandex') >= 0 || app_.indexOf('яндекс') >= 0) { await shell.openExternal('https://music.yandex.ru/search?text=' + encodeURIComponent(q)); return true; }
    } catch (e) { log('open track error: ' + e.message); }
    return false;
  });
  ipcMain.on('focus-window', () => { try { if (win && !win.isDestroyed()) win.focus(); } catch (e) {} });
  ipcMain.on('blur-active', (_e, on) => setBlurActive(on));
  ipcMain.handle('notif-act', (_e, act, app) => new Promise((resolve) => {
    act = ['accept', 'decline', 'open'].indexOf(act) >= 0 ? act : 'open';
    app = app === 'Discord' ? 'Discord' : 'Telegram';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resPath('toastact.ps1'), '-Action', act, '-App', app],
      { windowsHide: true, timeout: 9000 }, (err, out) => {
        const r = String(out || '').trim();
        log('notif-act ' + act + ' ' + app + ' -> ' + r + (err ? ' err ' + err.message : ''));
        resolve(r);
      });
  }));
  ipcMain.handle('notif-get', () => notifOn);
  ipcMain.handle('notif-set', (_e, on) => { setNotif(on); return notifOn; });
  ipcMain.handle('autohide-get', () => autoHide);
  ipcMain.handle('autohide-set', (_e, on) => { setAutoHide(on); return autoHide; });
  ipcMain.handle('autostart-get', () => autoGet());
  ipcMain.handle('autostart-set', (_e, on) => { autoSet(on); return autoGet(); });
  // Язык интерфейса: синхронное чтение (нужно до первой отрисовки, чтобы не мигало русским),
  // и смена языка «на лету» из вкладки «Дизайн» без перезапуска.
  ipcMain.on('lang-get-sync', (e) => { e.returnValue = LANG; });
  ipcMain.handle('lang-set', (_e, l) => setLang(l));
  ipcMain.on('screenshot', () => takeScreenshot());
  ipcMain.on('hide', () => { override = 'hide'; applyVisibility(true); });
  ipcMain.on('quit', () => app.quit());

  globalShortcut.register('Control+Alt+I', () => {
    if (!visible) { override = 'show'; applyVisibility(true); return; }
    if (win) win.webContents.send('toggle');
  });
  globalShortcut.register('Control+Alt+H', () => { override = visible ? 'hide' : 'show'; applyVisibility(true); });
  globalShortcut.register('Control+Alt+S', () => { override = 'show'; applyVisibility(true); });
  globalShortcut.register('Control+Alt+F', () => {
    if (!visible) { override = 'show'; applyVisibility(true); }
    win && win.webContents.send('focus');
  });
  globalShortcut.register('Control+Alt+T', () => win && win.webContents.send('timer'));
  globalShortcut.register('Control+Alt+Q', () => app.quit());
});

app.on('before-quit', () => { usageSave(); statsSave(); log('before-quit'); });
app.on('second-instance', () => log('second-instance -> quit'));
app.on('render-process-gone', (_e, _wc, d) => log('render-process-gone: ' + (d && d.reason)));
app.on('child-process-gone', (_e, d) => log('child-process-gone: ' + (d && d.type) + ' ' + (d && d.reason)));
app.on('will-quit', () => { try { if (tray) tray.destroy(); } catch (e) {} globalShortcut.unregisterAll(); stopMedia(); stopNotif(); if (focus) { clearInterval(focus.timer); focus = null; } dndOff(); });
app.on('window-all-closed', () => { log('window-all-closed'); if (gotLock) app.quit(); });
