/* 静林桌面 · Electron 主进程（桌面覆盖层模式）
 *
 * 不是"打开一个应用窗口看页面"，而是像 Rainmeter 那样把部件贴在桌面上：
 *   - 无边框、全屏、透明、不进任务栏
 *   - 空白区域鼠标穿透（桌面图标照常可点），鼠标移到部件上才接管
 *   - 默认走普通窗口层级（会被其它窗口盖住，就是"贴在桌面"），托盘可切换置顶
 */

const {
  app, BrowserWindow, screen, Tray, Menu, ipcMain, shell, nativeImage, globalShortcut,
} = require('electron');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

let win = null;
let tray = null;
let alwaysOnTop = false;
let ignoreMouse = true;

/* 单实例：桌面部件只应有一份 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.quietforest.desk');

/* ---------------------------------------------------------------- 窗口 */

function workAreaBounds() {
  const d = screen.getPrimaryDisplay();
  return { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height };
}

function createOverlay() {
  const b = workAreaBounds();

  win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    autoHideMenuBar: true,
    title: '静林桌面',
    icon: path.join(__dirname, 'app', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'), { query: { overlay: '1' } });

  /* 默认不可聚焦：点击部件不会激活这层窗口，它就一直待在其它窗口下面 */
  win.setFocusable(false);

  /* 默认穿透：只有指针落在部件上时才接管鼠标 */
  win.setIgnoreMouseEvents(true, { forward: true });
  ignoreMouse = true;

  win.once('ready-to-show', () => {
    win.showInactive();
    if (alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  });

  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });

  /* 链接交给系统浏览器 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  /* 显示器分辨率/任务栏变化后重新铺满 */
  const refit = () => {
    if (!win || win.isDestroyed()) return;
    const nb = workAreaBounds();
    win.setBounds(nb);
  };
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
}

/* ---------------------------------------------------------------- 托盘 */

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '静林桌面', enabled: false },
    { type: 'separator' },
    {
      label: '置顶显示（盖在所有窗口上）',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => {
        alwaysOnTop = item.checked;
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(alwaysOnTop, 'floating');
        /* 置顶时停掉"压到底"的循环，否则会互相打架 */
        if (alwaysOnTop) stopZOrderKeeper(); else startZOrderKeeper();
      },
    },
    {
      label: '显示 / 隐藏',
      click: () => {
        if (!win) return;
        if (win.isVisible()) win.hide();
        else { win.showInactive(); if (alwaysOnTop) win.setAlwaysOnTop(true, 'floating'); }
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: ['--autostart'],
        });
      },
    },
    { type: 'separator' },
    { label: '重新载入', click: () => win && win.webContents.reload() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

/* ---------------------------------------------------------------- 侧边栏（Alt+Q）
   一个贴在屏幕右侧的液态玻璃面板：时钟 / 天气 / 系统 / 正在播放 / 待办。
   属于"召之即来"的面板，所以置顶；失焦或 Esc 自动收起。 */
let sbWin = null;

function sidebarBounds() {
  const d = screen.getPrimaryDisplay().workArea;
  const w = 400;
  const h = Math.min(980, d.height - 40);
  return { x: d.x + d.width - w - 20, y: d.y + 20, width: w, height: h };
}

function createSidebar() {
  if (sbWin && !sbWin.isDestroyed()) return;
  sbWin = new BrowserWindow({
    ...sidebarBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    title: '静林 · 侧边栏',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  /* 召之即来的面板：必须压在最前面 */
  sbWin.setAlwaysOnTop(true, 'screen-saver');
  sbWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  sbWin.loadFile(path.join(__dirname, 'app', 'sidebar.html'));
  sbWin.on('blur', () => {
    const t = setTimeout(() => {
      if (!sbWin || sbWin.isDestroyed() || !sbWin.isVisible()) return;
      if (sbWin.isFocused()) return;
      sbWin.hide();
    }, 1200);
    sbWin.once('focus', () => clearTimeout(t));
  });
  sbWin.on('closed', () => { sbWin = null; });
}

function toggleSidebar() {
  if (!sbWin || sbWin.isDestroyed()) createSidebar();
  if (sbWin.isVisible()) { sbWin.hide(); return; }
  sbWin.setBounds(sidebarBounds());
  sbWin.show();
  sbWin.focus();
}

/* ---- 指标采集 ---- */
function runScript(file, args = [], timeout = 6000) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, file), ...args],
        { windowsHide: true, timeout },
        (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
    } catch { resolve(null); }
  });
}

let cpuPrev = null;
function cpuPercent() {
  const now = os.cpus().map((c) => c.times);
  if (!cpuPrev) { cpuPrev = now; return 0; }
  let idle = 0, total = 0;
  for (let i = 0; i < now.length; i++) {
    const a = cpuPrev[i] || now[i], b = now[i];
    const di = b.idle - a.idle;
    const dt = (b.user + b.nice + b.sys + b.idle + b.irq) - (a.user + a.nice + a.sys + a.idle + a.irq);
    idle += di; total += dt;
  }
  cpuPrev = now;
  return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0;
}

const cache = { gpu: { t: 0, v: null }, vram: { t: 0, v: null }, net: { t: 0, v: 0 }, media: { t: 0, v: null } };

ipcMain.handle('sys:stats', async () => {
  const total = os.totalmem(), free = os.freemem();
  const now = Date.now();

  if (now - cache.gpu.t > 2500) {
    cache.gpu.t = now;
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 4000 },
      (err, out) => {
        if (err) { cache.gpu.v = null; cache.vram.v = null; return; }
        const p = String(out).trim().split('\n')[0].split(',').map((x) => Number(String(x).trim()));
        cache.gpu.v = Number.isFinite(p[0]) ? p[0] : null;
        if (Number.isFinite(p[1]) && Number.isFinite(p[2])) cache.vram.v = { used: p[1], total: p[2] };
      });
  }
  if (now - cache.net.t > 3000) {
    cache.net.t = now;
    runScript('net.ps1').then((v) => { const n = Number(v); if (Number.isFinite(n)) cache.net.v = n; });
  }

  return {
    cores: os.cpus().length,
    cpu: cpuPercent(),
    memPct: Math.round(((total - free) / total) * 100),
    memUsed: total - free,
    memTotal: total,
    gpu: cache.gpu.v,
    vramUsed: cache.vram.v ? cache.vram.v.used : null,
    vramTotal: cache.vram.v ? cache.vram.v.total : null,
    netKb: cache.net.v,
  };
});

ipcMain.handle('sys:media', async () => {
  const now = Date.now();
  if (now - cache.media.t < 1500) return cache.media.v;
  cache.media.t = now;
  const raw = await runScript('media.ps1');
  if (!raw || raw === '{}') { cache.media.v = null; return null; }
  try {
    const o = JSON.parse(raw);
    cache.media.v = o && o.title ? o : null;
  } catch { cache.media.v = null; }
  return cache.media.v;
});

ipcMain.on('media:ctl', (_e, action) => {
  const a = ['playpause', 'next', 'prev', 'stop'].includes(action) ? action : 'playpause';
  runScript('mediactl.ps1', [a]);
  cache.media.t = 0;
});

ipcMain.on('sidebar:close', () => { if (sbWin && !sbWin.isDestroyed()) sbWin.hide(); });

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'app', 'icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('静林桌面 · 桌面部件');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (!win) return;
    win.isVisible() ? win.hide() : win.showInactive();
  });
  /* 菜单里的勾选状态每次弹出前刷新 */
  tray.on('right-click', () => tray.setContextMenu(buildTrayMenu()));
}

/* ---------------------------------------------------------------- IPC */

/* 页面把"该接管鼠标的矩形"交过来；主进程每 60ms 读一次真实鼠标位置做命中检测。
   不依赖 Chromium 的鼠标消息转发（在 Windows 上时好时坏），
   命中就在部件上，命中不了就让点击穿到桌面。 */
let zones = { rects: [], full: false };
let cursorTimer = null;

let fullSince = 0;

ipcMain.on('overlay:zones', (_e, rects, full) => {
  zones = { rects: Array.isArray(rects) ? rects : [], full: !!full };
  if (!full) fullSince = 0;
  else if (!fullSince) fullSince = Date.now();
});

function applyIgnore(ignore) {
  if (!win || win.isDestroyed()) return;
  /* 只有"接管鼠标"时才允许跳过；恢复穿透必须真的下发一次。
     原来的 `if (ignore === ignoreMouse) return;` 是单点故障：
     一旦 Windows 侧状态被 setFocusable / focus / 置顶 改掉，
     内部变量与真实状态就永久不一致，覆盖层会一直吃鼠标：
     桌面点不动、右键无菜单、拖放也失效。 */
  if (ignore === ignoreMouse && ignore !== true) return;
  ignoreMouse = ignore;
  try { win.setIgnoreMouseEvents(ignore, { forward: true }); } catch { /* 忽略 */ }
}

function startCursorWatch() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const x = p.x - b.x;
    const y = p.y - b.y;
    /* 看门狗：full 最多生效 3 秒。渲染进程里任何一个状态卡住（抽屉开着、
       拖拽标志没复位、弹窗残留）都会让整屏被覆盖层吃掉，桌面就点不动、右键失效。 */
    const fullAlive = zones.full && fullSince && (Date.now() - fullSince < 3000);
    const inside = fullAlive || zones.rects.some(
      (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
    );
    applyIgnore(!inside);
  }, 60);
}

ipcMain.on('app:quit', () => app.quit());

ipcMain.on('app:setTop', (_e, v) => {
  alwaysOnTop = !!v;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(alwaysOnTop, 'floating');
  if (alwaysOnTop) stopZOrderKeeper(); else startZOrderKeeper();
});

/* 平时不可聚焦 —— 点它不会激活窗口，也就不会被抬到其它窗口前面（第 6 条需求）。
   只有打开设置/弹窗时临时切成可聚焦，好让输入框能打字。 */
ipcMain.on('app:focusable', (_e, on) => {
  if (!win || win.isDestroyed()) return;
  win.setFocusable(!!on);
  if (on) { win.focus(); win.moveTop(); }
});

/* 打开一个本地文件 / 快捷方式（.lnk 交给 shell 解析，等同双击桌面图标）
   "此电脑""回收站"这类是 Shell 命名空间对象，得让 explorer 去开。 */
ipcMain.handle('shell:open', async (_e, target) => {
  if (!target) return { ok: false };
  try {
    if (/^https?:/i.test(target)) { await shell.openExternal(target); return { ok: true }; }
    if (target === 'HOME') { await shell.openPath(app.getPath('home')); return { ok: true }; }
    if (target === 'DOWNLOADS') { await shell.openPath(app.getPath('downloads')); return { ok: true }; }
    if (/^(shell:|::\{)/i.test(target)) {
      const { spawn } = require('node:child_process');
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* 取文件图标（.lnk 会自然解析成目标程序图标），转 dataURL 给页面用 */
const iconCache = new Map();
ipcMain.handle('shell:icon', async (_e, target) => {
  if (!target) return null;
  if (iconCache.has(target)) return iconCache.get(target);
  try {
    const img = await app.getFileIcon(target, { size: 'large' });
    const url = img.isEmpty() ? null : img.toDataURL();
    iconCache.set(target, url);
    return url;
  } catch {
    return null;
  }
});

/* 右键菜单：按"资源管理器里右键"的语义给 */
ipcMain.handle('shell:menu', async (_e, target) => {
  return new Promise((resolve) => {
    if (!target) { resolve(null); return; }
    const name = path.basename(target);
    const menu = Menu.buildFromTemplate([
      { label: '打开', click: () => shell.openPath(target) },
      {
        label: '以管理员身份运行',
        click: () => {
          const { spawn } = require('node:child_process');
          try {
            spawn('powershell.exe',
              ['-NoProfile', '-Command', `Start-Process -FilePath "${target.replace(/"/g, '""')}" -Verb RunAs`],
              { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          } catch { /* 用户取消 UAC 就算了 */ }
        },
      },
      { type: 'separator' },
      { label: '打开文件所在位置', click: () => shell.showItemInFolder(target) },
      {
        label: '属性',
        click: () => {
          const { spawn } = require('node:child_process');
          try {
            spawn('powershell.exe',
              ['-NoProfile', '-Command', `Start-Process -FilePath "${target.replace(/"/g, '""')}" -Verb properties`],
              { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          } catch { /* 忽略 */ }
        },
      },
      { type: 'separator' },
      {
        label: '从桌面上移除这个图标（移到回收站）',
        click: () => shell.trashItem(target),
      },
      { type: 'separator' },
      { label: name, enabled: false },
    ]);
    menu.popup({ window: win, callback: () => resolve(true) });
  });
});

/* 解析 .lnk 的真实目标：getFileIcon 对快捷方式只会给"白色小箭头"，
   要拿到程序自己的图标必须先拿到 TargetPath。一次批量问 PowerShell。
   结果走临时文件（UTF-8），避免控制台代码页把中文路径搞坏。 */
ipcMain.handle('shell:resolveLinks', async (_e, paths) => {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => /\.lnk$/i.test(String(p)));
  if (!list.length) return {};
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const dir = app.getPath('temp');
  const inFile = path.join(dir, `qfd-in-${process.pid}.json`);
  const outFile = path.join(dir, `qfd-out-${process.pid}.json`);
  try {
    fs.writeFileSync(inFile, JSON.stringify(list), 'utf8');
    try { fs.unlinkSync(outFile); } catch { /* 没有就算了 */ }
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = Get-Content -LiteralPath '${inFile.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json
$sh = New-Object -ComObject WScript.Shell
$res = @{}
foreach ($p in $paths) {
  try {
    $t = $sh.CreateShortcut([string]$p).TargetPath
    if ($t) { $res[[string]$p] = $t }
  } catch { }
}
$json = $res | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText('${outFile.replace(/'/g, "''")}', $json, (New-Object System.Text.UTF8Encoding $false))
`;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000 });
    const raw = fs.readFileSync(outFile, 'utf8');
    const trimmed = raw.replace(/^\uFEFF/, '').trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed);
  } catch {
    return {};
  } finally {
    try { fs.unlinkSync(inFile); } catch { /* 忽略 */ }
    try { fs.unlinkSync(outFile); } catch { /* 忽略 */ }
  }
});

/* 系统位置：桌面上的"此电脑""回收站"不是文件，拖不进来，这里直接给一份 */
ipcMain.handle('shell:listPlaces', async () => ([
  { name: '此电脑', path: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}' },
  { name: '回收站', path: '::{645FF040-5081-101B-9F08-00AA002F954E}' },
  { name: '网络', path: '::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}' },
  { name: '控制面板', path: 'shell:ControlPanelFolder' },
  { name: '用户文件夹', path: app.getPath('home') },
]));

/* 列出桌面上的 .lnk / .url，供"管理 → 多选添加"用 */
ipcMain.handle('shell:listDesktop', async () => {
  const fs = require('node:fs');
  const dirs = [
    app.getPath('desktop'),                                        /* 会跟随"桌面"重定向 */
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
  ];
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/\.(lnk|url|exe)$/i.test(n)) continue;
      if (/^静林桌面\.(lnk|url)$/i.test(n)) continue;   /* 别把自己塞进自己 */
      const full = path.join(dir, n);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({ path: full, name: n.replace(/\.(lnk|url|exe)$/i, '') });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
});



/* 控制中心：常用目录路径 */
ipcMain.handle('sys:paths', async () => ({ home: app.getPath('home'), downloads: app.getPath('downloads') }));

/* 控制中心：网络状态 + 音量/亮度 */
ipcMain.handle('sys:net', async () => {
  const { execFile } = require('node:child_process');
  return new Promise((resolve) => {
    execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) { resolve({ ssid: '' }); return; }
      const m = stdout.match(/^\s*SSID\s*:\s*(.+)$/m);
      resolve({ ssid: m ? m[1].trim() : '' });
    });
  });
});

/* 亮度 / 音量：滑杆 → 系统 */
let volLevel = 50;

function runPs(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      const { execFile } = require('node:child_process');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { windowsHide: true, timeout }, (err, stdout, stderr) => {
          resolve({ ok: !err, out: (stdout || '').trim(), err: err ? String(stderr || err.message).trim() : '' });
        });
    } catch (e) { resolve({ ok: false, err: String(e) }); }
  });
}

function logLevel(msg) {
  try {
    const fsx = require('node:fs');
    const px = require('node:path');
    fsx.appendFileSync(px.join(app.getPath('temp'), 'qfd-level.log'), new Date().toISOString() + '  ' + msg + '\n');
  } catch { /* 忽略 */ }
}

ipcMain.on('sys:level', async (_e, kind, value) => {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  if (kind === 'bri') {
    const script = '$m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue;'
      + ' if ($m) { $m | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=' + v + '} }';
    const r = await runPs(script);
    logLevel('bri ' + v + ' -> ' + (r.ok ? 'ok' : 'ERR ' + r.err));
    return;
  }
  if (kind === 'vol') {
    const delta = v - volLevel;
    volLevel = v;
    const steps = Math.round(delta / 2);
    if (!steps) { logLevel('vol ' + v + ' (no change)'); return; }
    const scriptPath = require('node:path').join(__dirname, 'vol.ps1');
    const r = await new Promise((resolve) => {
      try {
        const { execFile } = require('node:child_process');
        execFile('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, steps > 0 ? 'up' : 'down', String(Math.abs(steps))],
          { windowsHide: true, timeout: 8000 },
          (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '').trim(), err: err ? String(stderr || err.message).trim() : '' }));
      } catch (err) { resolve({ ok: false, err: String(err) }); }
    });
    logLevel('vol ' + v + ' x' + Math.abs(steps) + (steps > 0 ? ' up' : ' down') + ' -> ' + (r.ok ? r.out : 'ERR ' + r.err));
  }
});

ipcMain.handle('sys:getLevel', async () => {
  const r = await runPs('(Get-CimInstance -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness');
  const bri = r.ok && /^\d+$/.test(r.out) ? Number(r.out) : null;
  return { bri, vol: volLevel };
});





/* ---------------------------------------------------------------- 永远贴在桌面 */
/* 用 SetWindowPos(HWND_BOTTOM) 把窗口压到所有普通窗口之下（Rainmeter 的"在桌面"）。
   没有原生模块可用，所以交给一个常驻 PowerShell 循环，每 700ms 压一次。 */
let zKeeper = null;

function startZOrderKeeper() {
  if (process.platform !== 'win32' || !win) return;
  try {
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
    const script = `
$sig = '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);'
$t = Add-Type -MemberDefinition $sig -Name Win -Namespace Qfd -PassThru
$h = [IntPtr]${hwnd}
$bottom = [IntPtr]1
$flags = 0x0002 -bor 0x0001 -bor 0x0010
while ($true) {
  $t::SetWindowPos($h, $bottom, 0, 0, 0, 0, $flags) | Out-Null
  Start-Sleep -Milliseconds 700
}`;
    const { spawn } = require('node:child_process');
    zKeeper = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, stdio: 'ignore' });
    zKeeper.on('error', () => { zKeeper = null; });
  } catch { /* 失败就保持普通层级 */ }
}

function stopZOrderKeeper() {
  if (!zKeeper) return;
  try { zKeeper.kill(); } catch { /* ignore */ }
  zKeeper = null;
}

/* ---------------------------------------------------------------- 邮箱 */
const mailer = require('./mailer');
let mailTimer = null;
let mailCache = { count: 0, messages: [], error: '' };

function pushMail() {
  if (win && !win.isDestroyed()) win.webContents.send('mail:update', mailCache);
}

async function pollMail(silent = true) {
  const cfg = mailer.loadConfig(app.getPath('userData'));
  if (!cfg || !cfg.host || !cfg.user) return;
  try {
    const res = await mailer.fetchInbox(cfg);
    mailCache = { count: res.count, messages: res.messages || [], error: '' };
  } catch (e) {
    mailCache = { ...mailCache, error: String(e.message || e) };
  }
  pushMail();
}

function startMailPoll() {
  if (mailTimer) clearInterval(mailTimer);
  mailTimer = setInterval(() => pollMail(), 60000);   /* 每分钟收一次 */
  pollMail();
}

ipcMain.handle('mail:status', async () => {
  const cfg = mailer.loadConfig(app.getPath('userData'));
  return {
    bound: !!(cfg && cfg.user),
    user: cfg ? cfg.user : '',
    host: cfg ? cfg.host : '',
    port: cfg ? cfg.port : 993,
    cache: mailCache,
  };
});

ipcMain.handle('mail:bind', async (_e, cfg) => {
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) return { ok: false, error: '四项都要填' };
  try {
    const res = await mailer.fetchInbox({ ...cfg, limit: 3 });
    mailer.saveConfig(app.getPath('userData'), {
      host: cfg.host.trim(), port: Number(cfg.port) || 993,
      user: cfg.user.trim(), pass: cfg.pass,
    });
    mailCache = { count: res.count, messages: res.messages || [], error: '' };
    pushMail();
    startMailPoll();
    return { ok: true, count: res.count };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('mail:unbind', async () => {
  mailer.clearConfig(app.getPath('userData'));
  if (mailTimer) { clearInterval(mailTimer); mailTimer = null; }
  mailCache = { count: 0, messages: [], error: '' };
  pushMail();
  return { ok: true };
});

ipcMain.handle('mail:refresh', async () => { await pollMail(false); return mailCache; });

/* ---------------------------------------------------------------- 生命周期 */

app.on('second-instance', () => {
  if (!win) return;
  win.showInactive();
});

app.whenReady().then(() => {
  createOverlay();
  createSidebar();
  globalShortcut.register('Alt+Q', toggleSidebar);
  startZOrderKeeper();
  startMailPoll();
  createTray();
  startCursorWatch();
  app.on('activate', () => { if (!win) createOverlay(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('before-quit', () => {
  stopZOrderKeeper();
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
  if (tray) { tray.destroy(); tray = null; }
});
