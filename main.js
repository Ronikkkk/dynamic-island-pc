const { app, BrowserWindow, globalShortcut, screen, ipcMain, shell, net, dialog, nativeImage, desktopCapturer, Tray, Menu, powerMonitor, clipboard, session } = require('electron');
// Экономия памяти: V8 в режиме «поменьше памяти» и без запасного процесса рендерера про запас.
app.commandLine.appendSwitch('js-flags', '--optimize-for-size');
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess');
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
const H = 540; // высоты окна хватает с запасом под самую высокую вкладку (Кастом, ~500px) — иначе низ панели обрезается
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
// Файл команд для моста музыки — в папке данных, а не во временной папке Windows: при русском имени
// пользователя TEMP бывает записан коротким именем (C:\\Users\\12C2~1\\…), которое PowerShell не открывает,
// и кнопки «пауза/следующий трек» переставали работать.
const DATA_DIR_LONG = (() => { try { return fs.realpathSync.native(DATA_DIR); } catch (e) { return DATA_DIR; } })(); // 8.3 → полный путь
const CMD_FILE = path.join(DATA_DIR_LONG, 'media-cmd.txt');

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
// Режим игры: в игре остров показывает FPS, нагрузку ПК и время в игре.
let gameMode = false;      // включён ли режим игры
let gameAutoHide = true;   // прятать ли остров в играх (если режим игры выключен)
let gameSkin = 'red';      // дизайн в игре: red | default | neon
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
  if (st.gameMode === true) gameMode = true;
  if (typeof st.gameAutoHide === 'boolean') gameAutoHide = st.gameAutoHide; else if (st.autoHide === false) gameAutoHide = false;
  if (['red', 'default', 'neon'].indexOf(st.gameSkin) >= 0) gameSkin = st.gameSkin;
} catch (e) {}
// Словарь строк хост-процесса (трей, диалоги, приветствие) — переводится на английский по LANG.
const STR = {
  ru: {
    fullscreen: 'полный экран', game: 'игра', browser: 'браузер', manually: 'вручную',
    hideHint: 'Ctrl+Alt+H — скрыть остров',
    hiddenHintPrefix: 'Остров скрыт (', hiddenHintSuffix: ')  ·  Ctrl+Alt+S — показать',
    morning: 'Доброе утро', afternoon: 'Добрый день', evening: 'Добрый вечер', night: 'Доброй ночи',
    welcomeBack: '👋 С возвращением',
    trayHide: 'Скрыть остров', trayShow: 'Показать остров', trayAutoHide: 'Автоскрытие (браузер, полный экран)',
    trayDnd: 'Не беспокоить', trayShot: 'Скриншот области', trayAutostart: 'Запускать вместе с Windows',
    trayQuit: 'Выход', trayTooltip: 'Island for Windows — клик: показать или скрыть',
    pickAppTitle: 'Выбери приложение или ярлык', pickAppFilter: 'Приложения и ярлыки', allFiles: 'Все файлы',
    pickImageTitle: 'Выбери фото для фона острова', imagesFilter: 'Изображения',
    pickSoundTitle: 'Выбери звук для уведомлений', audioFilter: 'Аудио',
    shotSaveTitle: 'Сохранить скриншот', pngFilter: 'Изображение PNG', shotCopied: 'Скриншот скопирован — вставляй Ctrl+V', shotSaved: 'Скриншот сохранён'
  },
  en: {
    fullscreen: 'fullscreen', game: 'game', browser: 'browser', manually: 'manually',
    hideHint: 'Ctrl+Alt+H — hide the island',
    hiddenHintPrefix: 'Island hidden (', hiddenHintSuffix: ')  ·  Ctrl+Alt+S — show',
    morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Good night',
    welcomeBack: '👋 Welcome back',
    trayHide: 'Hide the island', trayShow: 'Show the island', trayAutoHide: 'Auto-hide (browser, fullscreen)',
    trayDnd: 'Do Not Disturb', trayShot: 'Area screenshot', trayAutostart: 'Start with Windows',
    trayQuit: 'Quit', trayTooltip: 'Island for Windows — click: show or hide',
    pickAppTitle: 'Choose an app or shortcut', pickAppFilter: 'Apps and shortcuts', allFiles: 'All files',
    pickImageTitle: 'Choose a photo for the island background', imagesFilter: 'Images',
    pickSoundTitle: 'Choose a notification sound', audioFilter: 'Audio',
    shotSaveTitle: 'Save screenshot', pngFilter: 'PNG image', shotCopied: 'Screenshot copied — paste with Ctrl+V', shotSaved: 'Screenshot saved'
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
let fg = { proc: '', full: false, path: '' };

// ---- Режим игры ----
// Игра = полноэкранное окно (не браузер и не видеоплеер) или exe из папки игр (Steam, Epic, Riot…), даже в окне.
const GAME_PATH_RE = /\\steamapps\\common\\|\\epic games\\|\\riot games\\|\\ubisoft game launcher\\games\\|\\battle\.net\\|\\gog galaxy\\games\\|\\xboxgames\\|\\ea games\\|\\origin games\\|\\games\\/i;
const NOT_GAMES = ['explorer', 'applicationframehost', 'vlc', 'mpc-hc64', 'mpc-hc', 'mpc-be64', 'mpc-be', 'potplayermini64', 'potplayermini', 'wmplayer', 'video.ui', 'microsoft.media.player', 'powerpnt', 'obs64', 'obs32', 'photos', 'microsoft.photos', 'mspaint', 'code', 'devenv', 'discord', 'telegram', 'steam', 'steamwebhelper', 'epicgameslauncher', 'riotclientux', 'zoom', 'teams', 'ms-teams', 'lockapp', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost', 'taskmgr', 'winword', 'excel', 'acrobat', 'acrord32', 'mstsc', 'vmware', 'virtualboxvm', 'snippingtool', 'screenclippinghost', 'screensketch', 'sharex', 'lightshot', 'nvidia overlay', 'gamebar', 'xboxgamebar', 'claude'];
function isGameFg(f) {
  if (!f || !f.proc) return false;
  if (BROWSERS.indexOf(f.proc) >= 0 || NOT_GAMES.indexOf(f.proc) >= 0 || SELF_PROCS.indexOf(f.proc) >= 0) return false;
  if (GAME_PATH_RE.test(f.path || '')) return true;
  return !!f.full;
}
function gameName(f) {
  const p = String(f.path || '');
  const m = /\\(?:steamapps\\common|epic games|riot games|xboxgames|ea games|gog galaxy\\games)\\([^\\]+)/i.exec(p);
  let n = m ? m[1] : (f.proc || '');
  n = n.replace(/[_-]+/g, ' ').trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Game';
}
function saveSetting(key, val) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (e) {}
  st[key] = val;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(st, null, 1)); } catch (e) { log('settings save error: ' + e.message); }
}
// Время в играх за сегодня: { day, games: { proc: секунды } }
const GAME_FILE = dataPath('game-time.json');
const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
let gameTime = (() => { try { return JSON.parse(fs.readFileSync(GAME_FILE, 'utf8')); } catch (e) { return null; } })() || { day: dayKey(), games: {}, names: {} };
if (!gameTime.games) gameTime.games = {};
if (!gameTime.names) gameTime.names = {};
function gameRoll() { const k = dayKey(); if (gameTime.day !== k) gameTime = { day: k, games: {}, names: {} }; }
function saveGameTime() { try { fs.writeFileSync(GAME_FILE, JSON.stringify(gameTime)); } catch (e) {} }
let gameCur = null;        // текущая игровая сессия { proc, name, acc (мс в игре), left (когда свернул) }
let gameTickLast = Date.now(), gameSaveAt = 0, gameWasActive = false;
let gameStats = { gpu: -1, fps: -1 };
let gps = null;            // PowerShell-мост gamestats.ps1 (GPU и FPS), живёт только пока идёт игра
let gPrev = null;
function gameCpu() {
  let idle = 0, total = 0;
  os.cpus().forEach((c) => { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; });
  let cpu = 0;
  if (gPrev && total > gPrev.total) cpu = Math.round((1 - (idle - gPrev.idle) / (total - gPrev.total)) * 100);
  gPrev = { idle, total };
  return Math.max(0, Math.min(100, cpu));
}
function startGameBridge() {
  if (gps || process.platform !== 'win32') return;
  try {
    gps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resPath('gamestats.ps1'), '-ParentPid', String(process.pid)], { windowsHide: true });
  } catch (e) { log('game bridge spawn error: ' + e.message); gps = null; return; }
  log('game bridge started');
  let b = '';
  gps.stdout.setEncoding('utf8');
  gps.stdout.on('data', (c) => {
    b += c; let i;
    while ((i = b.indexOf('\n')) >= 0) {
      const line = b.slice(0, i).trim(); b = b.slice(i + 1);
      if (line[0] !== '{') continue;
      try { const d = JSON.parse(line); gameStats = { gpu: Number(d.gpu), fps: Number(d.fps) }; } catch (e) {}
    }
  });
  gps.stderr.on('data', (c) => log('game bridge stderr: ' + String(c).slice(0, 300)));
  gps.on('error', () => { gps = null; });
  gps.on('exit', () => { gps = null; });
}
function stopGameBridge() {
  if (gps) { try { gps.kill(); } catch (e) {} gps = null; log('game bridge stopped'); }
  gameStats = { gpu: -1, fps: -1 };
}
function gameSummary() {
  gameRoll();
  return Object.keys(gameTime.games).map((k) => ({ name: gameTime.names[k] || k, sec: Math.floor(gameTime.games[k]) }))
    .filter((x) => x.sec >= 60).sort((a, b) => b.sec - a.sec).slice(0, 6);
}
function gameTick() {
  const now = Date.now(), dt = Math.min(5000, Math.max(0, now - gameTickLast));
  gameTickLast = now;
  const inGame = isGameFg(fg);
  if (inGame) {
    if (!gameCur || gameCur.proc !== fg.proc) gameCur = { proc: fg.proc, name: gameName(fg), acc: 0, left: 0 };
    gameCur.left = 0; gameCur.acc += dt;
    gameRoll();
    gameTime.games[fg.proc] = (gameTime.games[fg.proc] || 0) + dt / 1000;
    gameTime.names[fg.proc] = gameCur.name;
    if (now - gameSaveAt > 30000) { gameSaveAt = now; saveGameTime(); }
  } else if (gameCur) {
    if (!gameCur.left) { gameCur.left = now; saveGameTime(); }
    else if (now - gameCur.left > 5 * 60 * 1000) gameCur = null; // вышел из игры больше 5 минут назад — сессия закончилась
  }
  const active = gameMode && inGame;
  if (active) startGameBridge();
  else if (gps && (!gameMode || !gameCur || now - gameCur.left > 30000)) stopGameBridge();
  if (!win || win.isDestroyed()) return;
  if (active) {
    // некоторые игры в режиме «без рамки» сами встают поверх всего — раз в 3 сек поднимаем остров обратно
    if (visible && (gameCur.acc % 3000) < 1000) { try { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); } catch (e) {} }
    const tm = os.totalmem(), fm = os.freemem();
    win.webContents.send('game', {
      active: true, name: gameCur.name, cpu: gameCpu(), ram: Math.round((tm - fm) / tm * 100),
      gpu: gameStats.gpu, fps: gameStats.fps, sess: Math.floor(gameCur.acc / 1000),
      today: Math.floor(gameTime.games[fg.proc] || 0)
    });
    if (!gameWasActive) { try { log('game on: ' + gameCur.name + ' full=' + fg.full + ' visible=' + visible + ' winVisible=' + win.isVisible() + ' onTop=' + win.isAlwaysOnTop() + ' bounds=' + JSON.stringify(win.getBounds())); } catch (e) {} }
    gameWasActive = true;
  } else if (gameWasActive) {
    log('game off');
    gameWasActive = false;
    win.webContents.send('game', { active: false });
  }
}
setInterval(gameTick, 1000);
function gameSettings() { return { gameMode, gameAutoHide, gameSkin, today: gameSummary(), playing: gameCur && !gameCur.left ? gameCur.name : '' }; }
function setGame(patch) {
  patch = patch || {};
  if (typeof patch.gameMode === 'boolean') { gameMode = patch.gameMode; saveSetting('gameMode', gameMode); if (!gameMode) stopGameBridge(); }
  if (typeof patch.gameAutoHide === 'boolean') { gameAutoHide = patch.gameAutoHide; saveSetting('gameAutoHide', gameAutoHide); }
  if (['red', 'default', 'neon'].indexOf(patch.gameSkin) >= 0) { gameSkin = patch.gameSkin; saveSetting('gameSkin', gameSkin); }
  applyVisibility(false);
  return gameSettings();
}
let mediaPlaying = false; // играет ли сейчас трек (в т.ч. в браузере)
let override = null; // 'show' | 'hide' | null
let visible = true;
let hideTimer = null;

function hideReason() {
  // Игры — отдельная настройка «Автоскрытие в играх»; в режиме игры остров в игре не прячется.
  if (isGameFg(fg)) return (gameAutoHide && !gameMode) ? L('game') : '';
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
    win.setIgnoreMouseEvents(true);
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
  try { fxApply(); } catch (e) {}
}
function handleFg(d) {
  const proc = String(d.proc || '');
  if (SELF_PROCS.indexOf(proc) >= 0) return; // сам остров
  trackApp(proc, String(d.path || ''));
  setTimeout(() => captureBlur(false), 300);
  if (focus) { focusAccrue(); focus.cur = proc; }
  if (proc !== fg.proc && override === 'show') override = null;
  fg = { proc, full: !!d.full, path: String(d.path || '') };
  applyVisibility(false);
  if (customSettings.position === 'bottom') raiseOverTaskbar();
  try { fxApply(); } catch (e) {}
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
    const out = dataPath('icon-' + Math.random().toString(36).slice(2) + '.png'); // не во временной папке — см. CMD_FILE
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

// ---- Кастомизация (позиция и размер острова, своё приветствие, порядок вкладок) ----
const CUSTOM_FILE = dataPath('custom.json');
const TABS_ALL = ['home', 'timer', 'focus', 'day', 'apps', 'notes', 'game', 'design', 'custom'];
// Виджеты внутри вкладки «Главная» — единственная вкладка с несколькими независимыми блоками,
// поэтому именно для неё даём порядок/видимость (остальные вкладки — один сплошной экран).
const HOME_WIDGETS_ALL = ['clock', 'app', 'media'];
// Масштаб (small/medium/large): окно физически меняет размер (а не только CSS-transform --iscale
// в рендерере), иначе увеличенный остров обрезался бы границами окна.
const SIZE_SCALE = { small: 0.85, medium: 1, large: 1.15 };
function cleanCustom(d) {
  d = d || {};
  const position = ['center', 'left', 'right', 'custom', 'bottom'].indexOf(d.position) >= 0 ? d.position : 'center';
  const size = ['small', 'medium', 'large'].indexOf(d.size) >= 0 ? d.size : 'medium';
  const greeting = String(d.greeting || '').slice(0, 60);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
  let order = Array.isArray(d.tabOrder) ? d.tabOrder.filter((x) => TABS_ALL.indexOf(x) >= 0) : [];
  order = order.filter((x, i) => order.indexOf(x) === i); // без дублей, первое вхождение побеждает
  TABS_ALL.forEach((x) => { if (order.indexOf(x) === -1) order.push(x); }); // недостающие — в конец
  let homeOrder = Array.isArray(d.homeOrder) ? d.homeOrder.filter((x) => HOME_WIDGETS_ALL.indexOf(x) >= 0) : [];
  homeOrder = homeOrder.filter((x, i) => homeOrder.indexOf(x) === i);
  HOME_WIDGETS_ALL.forEach((x) => { if (homeOrder.indexOf(x) === -1) homeOrder.push(x); });
  const homeHidden = Array.isArray(d.homeHidden) ? d.homeHidden.filter((x) => HOME_WIDGETS_ALL.indexOf(x) >= 0) : [];
  const rng = (v, lo, hi, def) => { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  return { position, size, greeting, posX: num(d.posX), posY: num(d.posY), tabOrder: order, homeOrder, homeHidden,
    // плавный размер (ползунок) — точнее, чем S/M/L; null = взять из size
    scale: d.scale == null ? null : Math.round(rng(d.scale, 0.8, 1.25, 1) * 100) / 100,
    radius: Math.round(rng(d.radius, 6, 26, 18)), // скругление свёрнутого острова
    outline: d.outline === true, shadow: Math.round(rng(d.shadow, 0, 100, 45)),
    font: ['system', 'geo', 'mono'].indexOf(d.font) >= 0 ? d.font : 'system',
    clip: d.clip !== false, // показывать скопированное в буфер обмена
    preset: String(d.preset || '').slice(0, 20)
  };
}
let customSettings = cleanCustom((() => { try { return JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); } catch (e) { return null; } })());
// Реальные пиксельные размеры окна под выбранный пресет размера — считаются от базовых W×H,
// поэтому «L» не обрезается собственной рамкой окна при любом разрешении экрана.
function islandDims(cs) {
  const s = cs && typeof cs.scale === 'number' ? cs.scale : (SIZE_SCALE[cs && cs.size] || 1);
  return { w: Math.round(W * s), h: Math.round(H * s) };
}
// Позиция + размер окна под текущие настройки, всегда прижаты к границам ТЕКУЩЕГО экрана —
// работает одинаково на любом разрешении/мониторе и пересчитывается заново при каждом вызове.
function computeIslandBounds(b, cs) {
  const dims = islandDims(cs);
  const clampX = (x) => Math.max(b.x, Math.min(b.x + b.width - dims.w, x));
  const clampY = (y) => Math.max(b.y, Math.min(b.y + b.height - dims.h, y));
  let x, y;
  if (cs.position === 'custom' && cs.posX !== null && cs.posY !== null) {
    x = clampX(cs.posX); y = clampY(cs.posY);
  } else if (cs.position === 'left' || cs.position === 'right') {
    // Вплотную к боковой стене, на той высоте, где отпустили (по умолчанию — середина экрана).
    x = cs.position === 'left' ? b.x : b.x + b.width - dims.w;
    y = cs.posY !== null ? clampY(cs.posY) : clampY(Math.round(b.y + (b.height - dims.h) / 2));
  }
  else if (cs.position === 'bottom') {
    // На панели задач: окно прижато к самому низу экрана, остров рисуется снизу и раскрывается вверх.
    // По горизонтали — где отпустили; по умолчанию — в пустой левой части панели (иконки Windows 11 по центру).
    x = cs.posX !== null ? clampX(cs.posX) : clampX(Math.round(b.x + b.width * 0.25 - dims.w / 2));
    y = b.y + b.height - dims.h;
  }
  else { x = Math.round(b.x + (b.width - dims.w) / 2); y = b.y; }
  return { x, y, width: dims.w, height: dims.h };
}
function applyCustomBounds() {
  if (!win || win.isDestroyed()) return;
  const bounds = computeIslandBounds(screen.getPrimaryDisplay().bounds, customSettings);
  win.setBounds(bounds);
  log('applyCustomBounds position=' + customSettings.position + ' -> ' + JSON.stringify(bounds));
}
ipcMain.handle('custom-load', () => customSettings);
ipcMain.handle('custom-save', (_e, d) => {
  customSettings = cleanCustom(d);
  try { fs.writeFileSync(CUSTOM_FILE, JSON.stringify(customSettings, null, 1)); } catch (e) { log('custom save error: ' + e.message); }
  applyCustomBounds();
  return customSettings;
});
// «Сбросить всё» — возвращает положение/размер/приветствие/порядок вкладок и виджетов к значениям по умолчанию.
ipcMain.handle('custom-reset', () => {
  customSettings = cleanCustom(null);
  try { fs.writeFileSync(CUSTOM_FILE, JSON.stringify(customSettings, null, 1)); } catch (e) { log('custom save error: ' + e.message); }
  applyCustomBounds();
  return customSettings;
});
// Свободное перетаскивание мышью из вкладки «Кастом»: рендерер шлёт дельту движения курсора,
// мы двигаем окно в реальном времени, прижимая его к границам текущего экрана.
// ВАЖНО: окно физически (а не только визуально) сжимается на время перетаскивания —
// иначе его настоящие большие границы (как у развёрнутого острова) не долетают до
// краёв/низа экрана, и magnet-прилипание к стенке работает ненадёжно.
const DRAG_W = 130, DRAG_H = 40; // физический размер окна во время перетаскивания, px
// Зона «прилипания» у края экрана — доля ширины экрана, а не фикс. пиксели: на любом разрешении
// отпустить острова «примерно у края» (а не прямо впритык до пикселя) должно хватать, чтобы прилип.
const BOTTOM_SNAP = 70; // отпустили ближе 70px к низу экрана — остров встаёт на панель задач
function dockSnapPx(screenWidth) { return Math.max(130, Math.min(220, Math.round(screenWidth * 0.08))); }
ipcMain.on('custom-drag-start', (_e, sx, sy) => {
  if (!win || win.isDestroyed()) return;
  const b = screen.getPrimaryDisplay().bounds;
  let x = Math.round((typeof sx === 'number' ? sx : b.x) - DRAG_W / 2);
  let y = Math.round((typeof sy === 'number' ? sy : b.y) - DRAG_H / 2);
  x = Math.max(b.x, Math.min(b.x + b.width - DRAG_W, x));
  y = Math.max(b.y, Math.min(b.y + b.height - DRAG_H, y));
  win.setBounds({ x, y, width: DRAG_W, height: DRAG_H });
  log('drag-start sx=' + sx + ' sy=' + sy + ' -> win=' + JSON.stringify({ x, y }) + ' screen=' + JSON.stringify(b));
});
// handle (не on) — рендереру нужен ответ: близко ли сейчас к краю, чтобы показать подсветку
// «вот-вот прилипнет» прямо во время перетаскивания, а не только после отпускания.
ipcMain.handle('custom-drag-move', (_e, dx, dy) => {
  if (!win || win.isDestroyed()) return null;
  const b = screen.getPrimaryDisplay().bounds, wb = win.getBounds();
  const nx = Math.max(b.x, Math.min(b.x + b.width - wb.width, wb.x + dx));
  const ny = Math.max(b.y, Math.min(b.y + b.height - wb.height, wb.y + dy));
  win.setPosition(nx, ny);
  const snap = dockSnapPx(b.width);
  let near = null;
  if ((b.y + b.height) - (ny + wb.height) <= BOTTOM_SNAP) near = 'bottom';
  else if (nx - b.x <= snap) near = 'left';
  else if ((b.x + b.width) - (nx + wb.width) <= snap) near = 'right';
  return { near };
});
ipcMain.handle('custom-drag-end', () => {
  if (win && !win.isDestroyed()) {
    const b = screen.getPrimaryDisplay().bounds, wb = win.getBounds();
    const SNAP = dockSnapPx(b.width); // «магнитная» зона у края экрана — та же, что подсвечивалась во время перетаскивания
    let position = 'custom';
    if ((b.y + b.height) - (wb.y + wb.height) <= BOTTOM_SNAP) position = 'bottom';
    else if (wb.x - b.x <= SNAP) position = 'left';
    else if ((b.x + b.width) - (wb.x + wb.width) <= SNAP) position = 'right';
    log('drag-end wb=' + JSON.stringify(wb) + ' screen=' + JSON.stringify(b) + ' snap=' + SNAP + ' -> position=' + position);
    // У стены: ставим окно так, чтобы середина вертикальной полоски (top 36px, высота 200px) оказалась там, где отпустили.
    const posY = position === 'custom' ? wb.y : Math.round(wb.y + wb.height / 2 - 136);
    // На панели задач центр острова — там, где отпустили.
    const posX = position === 'bottom' ? Math.round(wb.x + wb.width / 2 - islandDims(customSettings).w / 2) : wb.x;
    customSettings = cleanCustom(Object.assign({}, customSettings, { position, posX, posY }));
    try { fs.writeFileSync(CUSTOM_FILE, JSON.stringify(customSettings, null, 1)); } catch (e) { log('custom save error: ' + e.message); }
    applyCustomBounds(); // возвращаем окно к настоящему размеру острова в итоговой (возможно прилипшей) позиции
  }
  return customSettings;
});
// ---- Загрузки из браузера: кружок возле часов в острове ----
// Браузеры качают во временный файл (.crdownload — Chrome/Edge/Яндекс/Opera GX, .part — Firefox, .opdownload — Opera),
// а в конце переименовывают его в нормальное имя. Следим за папкой «Загрузки»: пока такие файлы растут — идёт загрузка.
// Общий размер файла браузер в них не пишет, поэтому видно сколько уже скачано и скорость, но не проценты.
const DL_EXT = /\.(crdownload|part|opdownload|partial)$/i;
let dlDir = '';
try { dlDir = app.getPath('downloads'); } catch (e) {}
const dlTrack = {};          // имя файла -> { size, first, lastGrow, grows, speed, temp }
const dlPending = new Set();  // имена, про которые Windows сообщила «что-то изменилось»
let dlTimer = null, dlWasActive = false;
function dlSend(ch, d) { if (win && !win.isDestroyed()) win.webContents.send(ch, d); }
function dlDone(name) {
  const fp = path.join(dlDir, name);
  if (fs.existsSync(fp)) { dlSend('dl-done', { name, path: fp }); log('download done: ' + name); }
}
// Загрузка = временный файл браузера (.crdownload/.part/...) ИЛИ любой файл в «Загрузках», который прямо сейчас растёт
// (некоторые браузеры, в т.ч. Яндекс в части случаев, пишут сразу в итоговый файл).
function dlScan() {
  dlTimer = null;
  if (!dlDir) return;
  const now = Date.now();
  const names = new Set([...dlPending, ...Object.keys(dlTrack)]);
  dlPending.clear();
  names.forEach((n) => {
    if (!n) return;
    let st = null;
    try { st = fs.statSync(path.join(dlDir, n)); } catch (e) {}
    const tr = dlTrack[n];
    if (!st || !st.isFile()) {
      if (tr) {
        delete dlTrack[n];
        if (tr.temp) { const fin = n.replace(DL_EXT, ''); if (!/^unconfirmed \d+/i.test(fin)) dlDone(fin); }
      }
      return;
    }
    const temp = DL_EXT.test(n);
    if (!tr) {
      if (!temp && now - st.mtimeMs > 15000) return; // старый файл просто переименовали/потрогали — не загрузка
      dlTrack[n] = { size: st.size, first: now, lastGrow: temp ? now : 0, grows: 0, speed: 0, temp, t: now };
      if (temp) log('download started: ' + n + ' in ' + dlDir);
      return;
    }
    if (st.size > tr.size) {
      const sp = (st.size - tr.size) / Math.max(0.2, (now - tr.t) / 1000);
      tr.speed = tr.speed ? tr.speed * 0.6 + sp * 0.4 : sp; tr.lastGrow = now; tr.grows++;
      if (!tr.temp && tr.grows === 2) log('download (growing file): ' + n);
    }
    tr.size = st.size; tr.t = now;
    if (!tr.temp && tr.grows >= 2 && now - tr.lastGrow > 4000) { delete dlTrack[n]; dlDone(n); return; } // перестал расти — докачался
    if (!tr.temp && tr.grows < 2 && now - tr.first > 10000) { delete dlTrack[n]; return; }
    if (tr.temp && now - st.mtimeMs > 120000) { delete dlTrack[n]; } // брошенная недокачка
  });
  const act = [];
  Object.keys(dlTrack).forEach((n) => {
    const tr = dlTrack[n];
    if (!(tr.temp || tr.grows >= 2)) return;
    const nm = n.replace(DL_EXT, '');
    act.push({ name: /^unconfirmed \d+(\.\w+)?$/i.test(nm) ? '' : nm, size: tr.size, speed: now - tr.lastGrow < 3000 ? Math.round(tr.speed) : 0 });
  });
  if (act.length || dlWasActive) dlSend('dl', { items: act });
  dlWasActive = act.length > 0;
  if (Object.keys(dlTrack).length || dlPending.size) dlTimer = setTimeout(dlScan, 1000);
}
function dlKick() { if (!dlTimer) dlTimer = setTimeout(dlScan, 300); }
function dlWatch() {
  if (!dlDir) return;
  log('downloads folder: ' + dlDir);
  try { fs.watch(dlDir, { persistent: false }, (_ev, fn) => { if (fn) dlPending.add(String(fn)); dlKick(); }); }
  catch (e) { log('downloads watch error: ' + e.message); }
  // уже идущие загрузки на момент запуска
  try { fs.readdirSync(dlDir).forEach((n) => { if (DL_EXT.test(n)) dlPending.add(n); }); } catch (e) {}
  dlKick();
}
ipcMain.on('dl-open', (_e, p) => {
  p = String(p || '');
  if (dlDir && path.dirname(p) === dlDir && fs.existsSync(p)) shell.showItemInFolder(p);
});

// ---- Эффекты экрана: трава вдоль верхнего края и волна под музыку внизу ----
// Два отдельных прозрачных окна-полоски (сквозь них проходят клики), создаются только когда эффект включён.
const FX_FILE = dataPath('fx.json');
const FX_GRASS_COLORS = ['green', 'autumn', 'sakura', 'ice', 'neon', 'custom'];
const FX_WAVE_PALETTES = ['neon', 'rainbow', 'fire', 'ocean', 'sunset', 'mint', 'white', 'custom'];
function cleanFx(d) {
  d = d || {}; const g = d.grass || {}, w = d.wave || {}, ly = d.lyrics || {};
  const hex = (v, def) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : def);
  const num = (v, a, b, def) => (typeof v === 'number' && isFinite(v) ? Math.max(a, Math.min(b, Math.round(v))) : def);
  return {
    pulse: d.pulse === true, // (выключено) остров «дышит» в такт музыке
    lyrics: { on: ly.on === true, mini: ly.mini !== false }, // текст песни: в раскрытом острове и строкой в свёрнутом
    pure: d.pure === true, // «только эффекты»: маленький остров без времени и текста — одна трава/волна
    grass: {
      on: g.on === true,
      color: FX_GRASS_COLORS.indexOf(g.color) >= 0 ? g.color : 'green',
      custom: hex(g.custom, '#5fd35f'),
      pos: ['top', 'bottom', 'screen'].indexOf(g.pos) >= 0 ? g.pos : 'top', // screen — по верхнему краю экрана, без острова
      wind: ['calm', 'breeze', 'storm'].indexOf(g.wind) >= 0 ? g.wind : 'breeze',
      height: num(g.height, 20, 90, 44),
      density: ['low', 'mid', 'high'].indexOf(g.density) >= 0 ? g.density : 'mid',
      music: g.music !== false
    },
    wave: {
      on: w.on === true,
      style: ['wave', 'line', 'bars', 'mirror'].indexOf(w.style) >= 0 ? w.style : 'wave',
      palette: FX_WAVE_PALETTES.indexOf(w.palette) >= 0 ? w.palette : 'neon',
      custom: hex(w.custom, '#4ea1ff'),
      height: num(w.height, 30, 160, 70),
      sens: num(w.sens, 0, 100, 60),
      len: w.len === 'track' ? 'track' : 'full' // track — ширина волны растёт по ходу трека
    }
  };
}
let fxSettings = cleanFx((() => { try { return JSON.parse(fs.readFileSync(FX_FILE, 'utf8')); } catch (e) { return null; } })());
const fxWins = { top: null, bottom: null };
function fxBounds(kind) {
  const wa = screen.getPrimaryDisplay().workArea;
  // запас по высоте — трава под курсором вырастает примерно в 2.6 раза
  if (kind === 'top') { const h = Math.round(fxSettings.grass.height * 1.35 * 2.6) + 10; return { x: wa.x, y: wa.y, width: wa.width, height: h }; }
  const h = fxSettings.wave.height + 24;
  return { x: wa.x, y: wa.y + wa.height - h, width: wa.width, height: h };
}
function fxCreate(kind) {
  const w = new BrowserWindow(Object.assign(fxBounds(kind), {
    frame: false, transparent: true, resizable: false, movable: false, focusable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'fx-preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false, autoplayPolicy: 'no-user-gesture-required' }
  }));
  w.setIgnoreMouseEvents(true);
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true);
  w.loadFile('fx.html', { query: { kind } });
  w.on('closed', () => { if (fxWins[kind] === w) fxWins[kind] = null; });
  fxWins[kind] = w;
  return w;
}
// Эффекты прячутся в играх и полноэкранных окнах и вместе со скрытым островом.
function fxApply() {
  // Волна и трава «Сверху/Снизу» рисуются внутри острова (index.html).
  // Отдельное окно-полоска нужно только для травы «Над экраном» — по всему верхнему краю, без овала острова.
  if (win && !win.isDestroyed()) win.webContents.send('fx-media', mediaPlaying);
  const allowed = visible && !fg.full && !isGameFg(fg);
  ['top', 'bottom'].forEach((kind) => {
    const on = false; // «Над экраном» теперь — прозрачный остров с травой внутри (index.html), окна-полоски не нужны
    let w = fxWins[kind];
    if (!on) { if (w && !w.isDestroyed()) { w.destroy(); fxWins[kind] = null; } return; }
    if (!w || w.isDestroyed()) w = fxCreate(kind);
    try { w.setBounds(fxBounds(kind)); } catch (e) {}
    w.webContents.send('fx-settings', fxSettings);
    w.webContents.send('fx-media', mediaPlaying);
    w.webContents.send('fx-run', allowed);
    if (allowed) { if (!w.isVisible()) w.showInactive(); } else if (w.isVisible()) w.hide();
  });
  fxHoverWatch();
  if (win && !win.isDestroyed() && fxWins.top) { try { win.moveTop(); } catch (e) {} } // остров остаётся над травой
}
// Курсор над травой: окно травы пропускает клики, поэтому положение мыши смотрим сами (~11 раз/с, только пока трава на экране).
let fxHoverTimer = null, fxHoverWas = false;
function fxHoverWatch() {
  const w = fxWins.top, need = !!(w && !w.isDestroyed() && w.isVisible());
  if (!need) { if (fxHoverTimer) { clearInterval(fxHoverTimer); fxHoverTimer = null; } fxHoverWas = false; return; }
  if (fxHoverTimer) return;
  fxHoverTimer = setInterval(() => {
    const ww = fxWins.top;
    if (!ww || ww.isDestroyed() || !ww.isVisible()) { fxHoverWatch(); return; }
    const pt = screen.getCursorScreenPoint(), b = ww.getBounds();
    const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
    if (inside) { ww.webContents.send('fx-hover', { x: pt.x - b.x, y: pt.y - b.y }); fxHoverWas = true; }
    else if (fxHoverWas) { ww.webContents.send('fx-hover', null); fxHoverWas = false; }
  }, 90);
}
ipcMain.on('fx-ready', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  w.webContents.send('fx-settings', fxSettings);
  w.webContents.send('fx-media', mediaPlaying);
  const allowed = visible && !fg.full && !isGameFg(fg);
  w.webContents.send('fx-run', allowed);
  if (allowed) w.showInactive();
});
ipcMain.handle('fx-get', () => fxSettings);
// ---- Текст песни: открытая база LRCLIB (lrclib.net), строки с таймингом. Ничего не хранится на диске. ----
const lyrCache = new Map();
ipcMain.handle('lyrics-get', async (_e, q) => {
  q = q || {};
  const artist = String(q.artist || '').slice(0, 200).trim(), title = String(q.title || '').slice(0, 200).trim();
  const dur = Math.round((+q.dur || 0) / 1000);
  if (!title) return null;
  const key = (artist + '|' + title + '|' + dur).toLowerCase();
  if (lyrCache.has(key)) return lyrCache.get(key);
  const headers = { 'User-Agent': 'IslandForWindows/' + app.getVersion() + ' (https://github.com/Ronikkkk/dynamic-island-pc)' };
  const getJson = async (u) => {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
      const r = await net.fetch(u, { headers, signal: ctl.signal }); clearTimeout(tm);
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };
  let d = null;
  if (artist) {
    const p = { artist_name: artist, track_name: title }; if (dur) p.duration = String(dur);
    d = await getJson('https://lrclib.net/api/get?' + new URLSearchParams(p));
  }
  if (!d || (!d.syncedLyrics && !d.plainLyrics)) {
    const arr = await getJson('https://lrclib.net/api/search?' + new URLSearchParams({ q: (artist + ' ' + title).trim() }));
    if (Array.isArray(arr) && arr.length) {
      const near = (x) => !dur || !x.duration || Math.abs(x.duration - dur) <= 4;
      d = arr.find((x) => x.syncedLyrics && near(x)) || arr.find((x) => x.syncedLyrics) || arr[0];
    }
  }
  const res = d ? { synced: String(d.syncedLyrics || ''), plain: String(d.plainLyrics || ''), inst: !!d.instrumental } : { synced: '', plain: '', inst: false };
  lyrCache.set(key, res);
  if (lyrCache.size > 80) lyrCache.delete(lyrCache.keys().next().value);
  return res;
});
ipcMain.handle('fx-set', (_e, d) => {
  fxSettings = cleanFx(Object.assign({}, fxSettings, d, { grass: Object.assign({}, fxSettings.grass, d && d.grass), wave: Object.assign({}, fxSettings.wave, d && d.wave), lyrics: Object.assign({}, fxSettings.lyrics, d && d.lyrics) }));
  try { fs.writeFileSync(FX_FILE, JSON.stringify(fxSettings, null, 1)); } catch (e) { log('fx save error: ' + e.message); }
  fxApply();
  return fxSettings;
});
try { screen.on('display-metrics-changed', () => fxApply()); } catch (e) {}

// ---- Буфер обмена: что скопировали — коротко показываем на острове ----
// Ничего не пишется на диск: последние 12 записей живут только в памяти, пока работает программа.
// Пароли из менеджеров паролей помечаются особыми форматами — такие копирования пропускаем.
let clipLast = null, clipFmts = '', clipImgAt = 0;
const clipHist = [];
function clipTick() {
  if (!win || win.isDestroyed() || !customSettings.clip) return;
  let fm = [];
  try { fm = clipboard.availableFormats(); } catch (e) { return; }
  const fmS = fm.join('|');
  if (/ExcludeClipboardContentFromMonitorProcessing|Clipboard Viewer Ignore|CanIncludeInClipboardHistory/i.test(fmS)) { clipLast = 'secret'; clipFmts = fmS; return; }
  let txt = '';
  try { txt = clipboard.readText() || ''; } catch (e) {}
  let key = '', img = null;
  if (txt.trim()) key = 't:' + txt.length + ':' + txt.slice(0, 300) + '|' + txt.slice(-80);
  else if (fm.some((f) => /^image\//.test(f))) {
    // картинку читаем только когда сменился набор форматов или раз в 4 с — чтение большой картинки не бесплатное
    if (fmS === clipFmts && Date.now() - clipImgAt < 4000) return;
    clipImgAt = Date.now();
    try { img = clipboard.readImage(); } catch (e) { img = null; }
    if (!img || img.isEmpty()) { clipFmts = fmS; return; }
    const sz = img.getSize(), bmp = img.toBitmap();
    let h = 0; const step = Math.max(4, Math.floor(bmp.length / 4000) * 4);
    for (let i = 0; i < bmp.length; i += step) h = (h * 31 + bmp[i] + bmp[i + 1] * 7 + bmp[i + 2] * 13) >>> 0;
    key = 'i:' + sz.width + 'x' + sz.height + ':' + h;
  } else { clipFmts = fmS; return; }
  clipFmts = fmS;
  if (clipLast === null) { clipLast = key; return; } // при запуске не показываем то, что уже было в буфере
  if (key === clipLast) return;
  clipLast = key;
  let item;
  if (txt.trim()) item = { kind: 'text', text: txt.slice(0, 600), len: txt.length };
  else {
    const sz = img.getSize();
    let th = '';
    try { th = img.resize({ height: Math.min(96, sz.height) }).toDataURL(); } catch (e) {}
    item = { kind: 'image', thumb: th, w: sz.width, h: sz.height };
  }
  item.at = Date.now(); item.key = key;
  for (let i = clipHist.length - 1; i >= 0; i--) if (clipHist[i].key === key) clipHist.splice(i, 1);
  clipHist.unshift(item);
  if (clipHist.length > 12) clipHist.length = 12;
  win.webContents.send('clip', item);
}
setInterval(clipTick, 800);
ipcMain.handle('clip-list', () => clipHist.map((x) => Object.assign({}, x)));
ipcMain.handle('clip-use', (_e, i) => {
  const it = clipHist[Number(i)];
  if (!it || it.kind !== 'text') return false;
  try { clipboard.writeText(it.text); clipLast = 't:' + it.text.length + ':' + it.text.slice(0, 300) + '|' + it.text.slice(-80); } catch (e) { return false; }
  return true;
});
ipcMain.handle('clip-clear', () => { clipHist.length = 0; return true; });

// ---- Наведение на остров без глобального хука мыши ----
// Раз в 50 мс смотрим, где курсор (GetCursorPos — очень дёшево), и сообщаем окну «над островом / нет».
let islandRect = null, hoverWas = false;
setInterval(() => {
  if (!win || win.isDestroyed() || !visible || !islandRect) { hoverWas = false; return; }
  let inside = false;
  try {
    const pt = screen.getCursorScreenPoint(), b = win.getBounds(), r = islandRect;
    inside = pt.x >= b.x + r.x - 2 && pt.x <= b.x + r.x + r.w + 2 && pt.y >= b.y + r.y - 2 && pt.y <= b.y + r.y + r.h + 2;
  } catch (e) { return; }
  if (inside !== hoverWas) { hoverWas = inside; win.webContents.send('hover-pt', inside); }
}, 50);

// На панели задач: панель Windows сама «всегда сверху», и после клика по ней встаёт над островом.
// Поэтому в режиме «Снизу» сразу после смены активного окна и дальше раз в ~0.7 сек поднимаем остров обратно.
function raiseOverTaskbar() {
  if (!win || win.isDestroyed() || !visible || customSettings.position !== 'bottom') return;
  try { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); } catch (e) {}
}
setInterval(raiseOverTaskbar, 700);
// Смена разрешения, подключение/отключение монитора и т.п. — остров не должен улетать за экран.
try { screen.on('display-metrics-changed', () => applyCustomBounds()); } catch (e) {}

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
    const tw = Math.round(b.width * d.scaleFactor * 0.25), th = Math.round(b.height * d.scaleFactor * 0.25); // всё равно размывается — четверти разрешения хватает
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: tw, height: th } });
    win.setContentProtection(false);
    const src = srcs.find((s) => String(s.display_id) === String(d.id)) || srcs[0];
    if (!src) return;
    const img = src.thumbnail, ts = img.getSize();
    const f = ts.width / b.width;
    const wb = win.getBounds(); // реальные текущие границы окна — остров можно двигать/изменять
    const crop = img.crop({
      x: Math.max(0, Math.round((wb.x - b.x) * f)), y: Math.max(0, Math.round((wb.y - b.y) * f)),
      width: Math.min(ts.width, Math.round(wb.width * f)), height: Math.min(ts.height, Math.round(wb.height * f))
    });
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
// Путь берём в кавычки: Electron записывает аргументы автозапуска в реестр как есть, и путь с пробелом
// («Мои проекты») обрезался — при входе в Windows выскакивало «Unable to find Electron app at C:\\Users\\…\\Мои».
function autoArgs() { return app.isPackaged ? [] : ['"' + app.getAppPath() + '"']; }
function legacyAutoArgs() { return app.isPackaged ? [] : [app.getAppPath()]; } // старая запись — без кавычек
function autoGet() {
  try {
    return !!app.getLoginItemSettings({ path: process.execPath, args: autoArgs() }).openAtLogin ||
      !!app.getLoginItemSettings({ path: process.execPath, args: legacyAutoArgs() }).openAtLogin;
  } catch (e) { return false; }
}
// Если автозапуск был включён старой версией (путь без кавычек) — перезаписываем правильно.
function fixLegacyAutostart() {
  if (app.isPackaged || process.platform !== 'win32') return;
  try {
    const legacy = !!app.getLoginItemSettings({ path: process.execPath, args: legacyAutoArgs() }).openAtLogin;
    const ok = !!app.getLoginItemSettings({ path: process.execPath, args: autoArgs() }).openAtLogin;
    if (legacy && !ok && app.getAppPath().indexOf(' ') >= 0) {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: autoArgs() });
      log('autostart: fixed unquoted path');
    }
  } catch (e) { log('autostart fix error: ' + e.message); }
}
function autoSet(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: autoArgs() }); }
  catch (e) { log('autostart error: ' + e.message); }
}
function greetingText() {
  if (customSettings.greeting) return customSettings.greeting;
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
    { label: L('trayShot'), accelerator: 'Ctrl+Alt+X', click: () => openScreenshotTool() },
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
    // таймаут 6 с: если сервер недоступен (медленная сеть, блокировка) — не висим, лицензию не трогаем
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
    const r = await net.fetch(VERIFY_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, machine: LIC.machine() }), signal: ctl.signal
    });
    clearTimeout(tm);
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

// ---- Свой скриншотер: выделение области экрана + рисование поверх + «Сохранить как» ----
let shotUntil = 0;
let shotWin = null;
let shotImage = ''; // data:image/png;base64,... — полноразмерный снимок экрана, только пока открыт редактор
let shotDoneHint = '';
let shotLastDir = '';
function restoreAfterShot() {
  shotUntil = 0;
  shotImage = ''; // снимок экрана (несколько МБ) больше не нужен — отдаём память
  log('screenshot: restore');
  applyVisibility(false);
  if (shotDoneHint && visible && win && !win.isDestroyed()) win.webContents.send('vis', { visible: true, hint: shotDoneHint, hintMs: 2200 });
  shotDoneHint = '';
}
async function openScreenshotTool() {
  if (process.platform !== 'win32' || shotWin) return;
  log('screenshot: start');
  statsRoll(); stats.shots++;
  try {
    const d = screen.getPrimaryDisplay(), b = d.bounds;
    // Остров не прячем с анимацией (это было +0.4 c ожидания) — просто исключаем его окно из захвата.
    if (win && !win.isDestroyed()) win.setContentProtection(true);
    await sleep(60);
    const tw = Math.round(b.width * d.scaleFactor), th = Math.round(b.height * d.scaleFactor);
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: tw, height: th } });
    if (win && !win.isDestroyed()) win.setContentProtection(false);
    const src = srcs.find((s) => String(s.display_id) === String(d.id)) || srcs[0];
    if (!src) return;
    shotImage = 'data:image/png;base64,' + src.thumbnail.toPNG().toString('base64');
    // Пока открыт редактор, остров убираем мгновенно, чтобы не висел поверх выделения.
    shotUntil = Date.now() + 10 * 60 * 1000;
    visible = false;
    clearTimeout(hideTimer);
    if (win && !win.isDestroyed()) { win.webContents.send('vis', { visible: false, hint: '', hintMs: 0 }); win.hide(); }
    shotWin = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, transparent: false, resizable: false, movable: false, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, show: false, backgroundColor: '#111318',
      webPreferences: { preload: path.join(__dirname, 'shot-preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
    });
    shotWin.setAlwaysOnTop(true, 'screen-saver');
    shotWin.setVisibleOnAllWorkspaces(true);
    shotWin.once('ready-to-show', () => { shotWin && !shotWin.isDestroyed() && (shotWin.show(), shotWin.focus()); });
    shotWin.on('closed', () => { shotWin = null; restoreAfterShot(); });
    shotWin.loadFile('shot.html', { query: { lang: LANG } });
  } catch (e) {
    log('screenshot error: ' + e.message);
    try { if (win && !win.isDestroyed()) win.setContentProtection(false); } catch (x) {}
    shotWin = null; restoreAfterShot();
  }
}

function createWindow() {
  const b = screen.getPrimaryDisplay().bounds;
  const pos0 = computeIslandBounds(b, customSettings);
  win = new BrowserWindow({
    width: pos0.width,
    height: pos0.height,
    x: pos0.x,
    y: pos0.y,
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
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  // Пока курсор не над островом, клики проходят сквозь окно.
  // Без { forward: true }: в Windows эта опция ставит глобальный хук мыши, и любая пауза
  // в программе вызывает подёргивание курсора во всей системе. Наведение отслеживаем сами (hoverPoll).
  win.setIgnoreMouseEvents(true);
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
    '-CmdFile', CMD_FILE,
    '-ParentPid', String(process.pid),
    '-LogPath', dataPath('media-bridge.log')
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
          if (mp !== mediaPlaying) {
            mediaPlaying = mp; applyVisibility(false);
            if (win && !win.isDestroyed()) win.webContents.send('fx-media', mp);
          }
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
    nps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resPath('notif.ps1'), '-ParentPid', String(process.pid)], { windowsHide: true });
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

// Если прошлый остров закрылся аварийно (или его сняли в диспетчере задач), его PowerShell-мосты
// могли остаться висеть в памяти. Закрываем только наши скрипты и только не от текущего процесса.
function killOrphanBridges() {
  if (process.platform !== 'win32') return;
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'media\\.ps1|notif\\.ps1|gamestats\\.ps1' -and $_.ParentProcessId -ne " + process.pid + " } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true, timeout: 15000 }, (err, out) => {
    const n = String(out || '').trim().split(/\s+/).filter(Boolean).length;
    if (n) log('killed orphan bridges: ' + n);
  });
}
// Раз в несколько минут просим окно острова сбросить кэши картинок (обложки, фон блюра и т.п.).
setInterval(() => { if (win && !win.isDestroyed()) win.webContents.send('mem-trim'); }, 2 * 60 * 1000);

function stopMedia() {
  if (ps) { try { ps.kill(); } catch (e) {} ps = null; }
  try { fs.unlinkSync(CMD_FILE); } catch (e) {}
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  log('=== Island for Windows started, version ' + app.getVersion() + ' ===');
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
  killOrphanBridges();
  fixLegacyAutostart();
  // Волна под музыку слушает звук компьютера: окну эффектов отдаём «захват экрана» со звуком системы (loopback).
  // Видео окно сразу останавливает — нужен только звук, ничего никуда не записывается и не отправляется.
  try {
    session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((src) => cb(src[0] ? { video: src[0], audio: 'loopback' } : {})).catch(() => cb({}));
    });
  } catch (e) { log('display media handler error: ' + e.message); }
  createWindow();
  setTimeout(() => { try { fxApply(); } catch (e) {} }, 1500);
  setTimeout(dlWatch, 2000);
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
    if (win) win.setIgnoreMouseEvents(!over);
  });
  // Где на окне сейчас остров (присылает index.html при изменении размера/положения).
  ipcMain.on('island-rect', (_e, r) => {
    if (r && isFinite(r.x) && isFinite(r.y) && isFinite(r.w) && isFinite(r.h)) islandRect = { x: +r.x, y: +r.y, w: +r.w, h: +r.h };
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
    // Ключ проверяется офлайн по подписи — Pro включается сразу. Проверка на сервере идёт в фоне
    // и не держит окно (раньше при плохой сети активация «зависала» на десятки секунд).
    if (r && r.ok) licVerify(true);
    return r;
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
  ipcMain.handle('game-get', () => gameSettings());
  ipcMain.handle('game-set', (_e, patch) => setGame(patch));
  ipcMain.handle('autohide-set', (_e, on) => { setAutoHide(on); return autoHide; });
  ipcMain.handle('autostart-get', () => autoGet());
  ipcMain.handle('autostart-set', (_e, on) => { autoSet(on); return autoGet(); });
  // Язык интерфейса: синхронное чтение (нужно до первой отрисовки, чтобы не мигало русским),
  // и смена языка «на лету» из вкладки «Дизайн» без перезапуска.
  ipcMain.on('lang-get-sync', (e) => { e.returnValue = LANG; });
  ipcMain.handle('lang-set', (_e, l) => setLang(l));
  ipcMain.on('screenshot', () => openScreenshotTool());
  ipcMain.handle('shot-get', () => shotImage);
  ipcMain.on('shot-cancel', () => { if (shotWin && !shotWin.isDestroyed()) shotWin.close(); });
  ipcMain.handle('shot-save', async (_e, dataUrl) => {
    if (!shotWin || shotWin.isDestroyed()) return { ok: false };
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `Screenshot_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.png`;
    let r;
    try {
      r = await dialog.showSaveDialog(shotWin, { title: L('shotSaveTitle'), defaultPath: path.join(shotLastDir || app.getPath('pictures'), name), filters: [{ name: L('pngFilter'), extensions: ['png'] }] });
    } catch (e) { log('shot save dialog error: ' + e.message); return { ok: false }; }
    if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      const b64 = String(dataUrl || '').split(',')[1] || '';
      fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
    } catch (e) { log('shot write error: ' + e.message); return { ok: false }; }
    shotLastDir = path.dirname(r.filePath); // в следующий раз диалог откроется в этой же папке
    try { clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); } catch (e) {} // и сразу в буфер — удобно
    shotDoneHint = L('shotSaved');
    if (shotWin && !shotWin.isDestroyed()) shotWin.close();
    return { ok: true, path: r.filePath };
  });
  ipcMain.handle('shot-copy', (_e, dataUrl) => {
    try {
      const img = nativeImage.createFromDataURL(String(dataUrl || ''));
      if (img.isEmpty()) return { ok: false };
      clipboard.writeImage(img);
    } catch (e) { log('shot copy error: ' + e.message); return { ok: false }; }
    shotDoneHint = L('shotCopied');
    if (shotWin && !shotWin.isDestroyed()) shotWin.close();
    return { ok: true };
  });
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
  try { globalShortcut.register('Control+Alt+X', () => openScreenshotTool()); } catch (e) {} // скриншот области
  // Диагностика: открыть консоль разработчика острова (посмотреть ошибки в консоли при багах).
  globalShortcut.register('Control+Alt+D', () => { if (win && !win.isDestroyed()) win.webContents.toggleDevTools(); });
});

app.on('before-quit', () => { usageSave(); statsSave(); log('before-quit'); });
app.on('second-instance', () => log('second-instance -> quit'));
app.on('render-process-gone', (_e, _wc, d) => log('render-process-gone: ' + (d && d.reason)));
app.on('child-process-gone', (_e, d) => log('child-process-gone: ' + (d && d.type) + ' ' + (d && d.reason)));
app.on('will-quit', () => { try { if (tray) tray.destroy(); } catch (e) {} globalShortcut.unregisterAll(); stopMedia(); stopNotif(); if (focus) { clearInterval(focus.timer); focus = null; } dndOff(); });
app.on('window-all-closed', () => { log('window-all-closed'); if (gotLock) app.quit(); });
