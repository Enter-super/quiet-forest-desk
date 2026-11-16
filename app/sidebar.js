/* 侧边栏：时钟 / 天气 / 系统 / 正在播放 / 待办 */
const SHELL = window.desktopShell || {};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------------- 高度自适应 ---------------- */
let sbMaxH = 0;

async function initSbMax() {
  try {
    const d = SHELL.display ? await SHELL.display() : null;
    if (d && d.h) {
      sbMaxH = Math.max(420, d.h - 80);       /* 留出上下边距，窗口 = 面板 + 40 */
      document.documentElement.style.setProperty('--sb-max', sbMaxH + 'px');
    }
  } catch { /* 忽略 */ }
}
initSbMax();

let hTimer = 0;
function reportHeight() {
  clearTimeout(hTimer);
  hTimer = setTimeout(() => {
    if (!SHELL.sidebarHeight) return;
    const sb = $('.sb');
    if (!sb) return;
    const h = Math.ceil(Math.min(sb.getBoundingClientRect().height, sbMaxH || 99999)) + 40;
    SHELL.sidebarHeight(h);
  }, 60);
}

/* ---------------- 时钟 ---------------- */
const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
function tickClock() {
  const d = new Date();
  $('#cTime').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  $('#cDate').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日' + WEEK[d.getDay()];
}
tickClock();
setInterval(tickClock, 1000 * 10);

/* ---------------- 天气（wttr.in，失败就保留占位） ---------------- */
const WX_ZH = {
  'sunny': '晴', 'clear': '晴', 'partly cloudy': '局部多云', 'cloudy': '多云', 'overcast': '阴',
  'mist': '薄雾', 'fog': '雾', 'haze': '霾', 'patchy rain nearby': '局部有雨',
  'patchy rain possible': '可能有雨', 'light rain': '小雨', 'moderate rain': '中雨', 'heavy rain': '大雨',
  'light drizzle': '毛毛雨', 'patchy light rain': '零星小雨', 'thundery outbreaks possible': '可能有雷阵雨',
  'light snow': '小雪', 'moderate snow': '中雪', 'heavy snow': '大雪', 'blizzard': '暴雪',
  'patchy light rain with thunder': '雷阵雨', 'moderate or heavy rain with thunder': '雷雨',
  'light rain shower': '阵雨', 'moderate or heavy rain shower': '强阵雨', 'patchy light drizzle': '零星小雨',
};
const wxZh = (s) => WX_ZH[String(s || '').toLowerCase()] || s || '—';

async function loadWeather() {
  try {
    const r = await fetch('https://wttr.in/?format=j1&lang=zh', { cache: 'no-store' });
    const j = await r.json();
    const cur = (j.current_condition || [])[0] || {};
    const t = (j.weather || [])[0] || {};
    const now = Number(cur.temp_C);
    const desc = wxZh((cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '');
    const area = (j.nearest_area && j.nearest_area[0]) || {};
    const city = (area.lang_zh && area.lang_zh[0] && area.lang_zh[0].value)
      || (area.areaName && area.areaName[0] && area.areaName[0].value) || '本地';
    if (Number.isFinite(now)) {
      $('#wxTxt').textContent = now + '°';
      $('#wxNow').textContent = now + '°';
      $('#wxDesc').textContent = desc;
      $('#wxCity').textContent = city + ' 高' + t.maxtempC + '° 低' + t.mintempC + '°';
    }
  } catch { /* 保留占位 */ }
}
loadWeather();
setInterval(loadWeather, 20 * 60 * 1000);

/* ---------------- 系统指标 ---------------- */
const fmtGB = (b) => (b / 1073741824).toFixed(1) + ' GB';
async function loadStats() {
  if (!SHELL.stats) return;
  try {
    const s = await SHELL.stats();
    if (!s) return;
    if (s.memTotal) window.__memTotal = s.memTotal;
    if (typeof memOpen !== 'undefined' && memOpen) {
      try { renderMemTop((SHELL.memTop ? await SHELL.memTop() : []) || []); } catch { /* 忽略 */ }
    }
    $('#cpuCores').textContent = s.cores + ' 核';
    $('#cpuVal').textContent = s.cpu + '%';
    $('#cpuBar').style.width = Math.max(2, s.cpu) + '%';

    $('#memInfo').textContent = s.memPct + '% · ' + (s.memUsed / 1073741824).toFixed(1) + ' GB';
    $('#memVal').textContent = s.memPct + '%';
    $('#memBar').style.width = Math.max(2, s.memPct) + '%';

    if (s.gpu == null) {
      $('#gpuVal').textContent = '—';
      $('#gpuBar').style.width = '0%';
    } else {
      $('#gpuVal').textContent = s.gpu + '%';
      $('#gpuBar').style.width = Math.max(2, s.gpu) + '%';
    }

    if (s.vramTotal) {
      const usedGB = s.vramUsed / 1024;
      const totalGB = s.vramTotal / 1024;
      const pct = Math.round((s.vramUsed / s.vramTotal) * 100);
      $('#vramInfo').textContent = usedGB.toFixed(1) + ' / ' + totalGB.toFixed(0) + ' GB';
      $('#vramVal').textContent = pct + '%';
      $('#vramBar').style.width = Math.max(2, pct) + '%';
    } else {
      $('#vramInfo').textContent = '—';
      $('#vramVal').textContent = '—';
      $('#vramBar').style.width = '0%';
    }

    const kb = s.netKb || 0;
    $('#netVal').textContent = kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB/s' : kb.toFixed(0) + ' KB/s';
    $('#netBar').style.width = Math.min(100, Math.max(2, kb / 20)) + '%';
  } catch { /* 忽略 */ }
}
loadStats();
setInterval(loadStats, 2000);

/* ---------------- 内存占用下拉 ---------------- */
var memOpen = false;   /* var：loadStats 在声明之前就会被调用 */

function renderMemTop(list) {
  const box = $('#memList');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="mem-empty">读取失败</div>';
    return;
  }
  const total = list.reduce((a, x) => Math.max(a, 0), 0); /* 占位，实际按物理内存算 */
  const phys = (window.__memTotal || 0) || 1;
  const max = list[0].ws || 1;
  box.innerHTML = list.map((x) => {
    const gb = x.ws / 1073741824;
    const pct = phys > 1 ? (x.ws / phys) * 100 : 0;
    const w = Math.max(3, Math.round((x.ws / max) * 100));
    const nm = String(x.name || '').replace(/\.exe$/i, '');
    return '<div class="mem-item">'
      + '<span class="mi-name">' + nm.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</span>'
      + '<span class="mi-val">' + gb.toFixed(2) + ' GB · ' + pct.toFixed(1) + '%</span>'
      + '<i class="mi-bar"><b style="width:' + w + '%"></b></i>'
      + '</div>';
  }).join('');
  reportHeight();
}

async function toggleMemTop() {
  const box = $('#memList');
  const chev = $('#memChev');
  if (!box) return;
  memOpen = !memOpen;
  box.hidden = !memOpen;
  if (chev) chev.classList.toggle('is-open', memOpen);
  if (!memOpen) {
    box.innerHTML = '';      /* 收起即清空，之后不再拉取各应用占用 */
    reportHeight();
    return;
  }
  box.innerHTML = '<div class="mem-empty">读取中…</div>';
  try {
    const list = (SHELL.memTop ? await SHELL.memTop() : []) || [];
    renderMemTop(list);
  } catch { box.innerHTML = '<div class="mem-empty">读取失败</div>'; }
}

/* 内存行点击绑定（不放在播放/待办区块里，避免被后续改动连带删除） */
$('#memRow')?.addEventListener('click', toggleMemTop);

/* ---------------- 正在播放 ---------------- */
const fmtT = (sec) => {
  const s = Math.max(0, sec | 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

async function loadMedia() {
  if (!SHELL.media) return;
  const card = $('#mediaCard');
  if (!card) return;
  try {
    const m = await SHELL.media();
    if (!m || !m.title) { card.hidden = true; reportHeight(); return; }
    card.hidden = false;
    $('#mTitle').textContent = m.title;
    $('#mArtist').textContent = m.artist || m.app || '';
    $('#mPos').textContent = fmtT(m.pos);
    $('#mDur').textContent = fmtT(m.dur);
    $('#mBar').style.width = (m.dur ? Math.min(100, (m.pos / m.dur) * 100) : 0) + '%';
    $('#mPlay').textContent = m.playing ? '⏸' : '▶';
    document.body.classList.toggle('is-paused', !m.playing);
    reportHeight();
  } catch { /* 忽略 */ }
}

loadMedia();
setInterval(loadMedia, 3000);

$$('.m-ctl button').forEach((b) => {
  b.addEventListener('click', () => {
    if (SHELL.mediaCtl) SHELL.mediaCtl(b.dataset.act);
    setTimeout(loadMedia, 400);
  });
});

/* ---------------- 邮箱 ---------------- */
const OTP_KEY = /(验证码|校验码|动态码|动态密码|确认码|激活码|安全码|登录码|绑定码|口令|验证|认证|verification\s*code|verify|passcode|\botp\b|\bcode\b)/i;
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function pickOtp(msg) {
  if (!msg) return '';
  const subject = String(msg.subject || '');
  const from = String(msg.from || '');
  if (!OTP_KEY.test(subject) && !OTP_KEY.test(from)) return '';
  const hits = subject.match(/(?<!\d)(\d{4,8})(?!\d)/g) || [];
  return hits.length ? hits[hits.length - 1] : '';
}

async function loadMail() {
  if (!SHELL.mailStatus) return;
  try {
    const st = await SHELL.mailStatus();
    const cache = (st && st.cache) || {};
    const msgs = cache.messages || [];
    const addrEl = $('#mailAddr');
    if (addrEl) addrEl.textContent = (st && st.user) ? st.user : '未绑定';

    let hit = null;
    for (const mm of msgs) {
      const c = pickOtp(mm);
      if (c) { hit = { code: c, msg: mm }; break; }
    }
    const box = $('#otpBox');
    if (box) {
      box.hidden = !hit;
      if (hit) {
        $('#otpCode').textContent = hit.code;
        $('#otpSrc').textContent = '来自 ' + (hit.msg.from || '邮件');
      }
    }

    const list = $('#mailList');
    if (list) {
      if (cache.error) list.innerHTML = '<div class="mail-empty">收取失败：' + esc(cache.error) + '</div>';
      else if (!msgs.length) list.innerHTML = '<div class="mail-empty">收件箱是空的</div>';
      else {
        list.innerHTML = msgs.slice(0, 4).map((mm) => (
          '<div class="mail-row"><b>' + esc((mm.from || '').replace(/<.*?>/, '').trim()) + '</b>'
          + '<span>' + esc(mm.subject || '(无主题)') + '</span></div>'
        )).join('');
      }
    }
    reportHeight();
  } catch { /* 忽略 */ }
}

loadMail();
setInterval(loadMail, 30000);
if (SHELL.onMail) SHELL.onMail(() => loadMail());

/* ---------------- 待办 ---------------- */
const KEY = 'qfd.sidebar.todos';
let todos = [];
let filter = 'open';
try { todos = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch { todos = []; }
const saveTodos = () => localStorage.setItem(KEY, JSON.stringify(todos));

function renderTodos() {
  const list = $('#todos');
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  $('#nOpen').textContent = open.length;
  $('#nDone').textContent = done.length;
  $('#nAll').textContent = todos.length;

  const view = filter === 'open' ? open : filter === 'done' ? done : todos;
  if (!view.length) {
    list.innerHTML = '<div class="todos-empty">' + (filter === 'done' ? '还没有完成的待办' : '今天还没有待办') + '</div>';
    return;
  }
  reportHeight();
  list.innerHTML = view.map((t) => (
    '<div class="todo' + (t.done ? ' is-done' : '') + '" data-id="' + t.id + '">'
    + '<span class="dot" data-toggle="1"></span>'
    + '<span class="txt">' + t.text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</span>'
    + '<button class="del" data-del="1" title="删除">✕</button>'
    + '</div>'
  )).join('');
}

$('#todos').addEventListener('click', (e) => {
  const row = e.target.closest('.todo');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.dataset.del) {
    todos = todos.filter((t) => t.id !== id);
    saveTodos(); renderTodos(); return;
  }
  const t = todos.find((x) => x.id === id);
  if (t) { t.done = !t.done; saveTodos(); renderTodos(); }
});

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('is-on', x === tab));
    filter = tab.dataset.filter;
    renderTodos();
  });
});

$('#todoInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (!v) return;
    todos.unshift({ id: String(Date.now()), text: v, done: false });
    e.target.value = '';
    filter = 'open';
    $$('.tab').forEach((x) => x.classList.toggle('is-on', x.dataset.filter === 'open'));
    saveTodos(); renderTodos();
  }
});

renderTodos();

/* ---------------- 交互 ---------------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.activeElement && document.activeElement.id === 'todoInput') { document.activeElement.blur(); return; }
    if (SHELL.closeSidebar) SHELL.closeSidebar();
  }
});

window.addEventListener('focus', () => { loadStats(); loadMail(); loadMedia(); });
requestAnimationFrame(() => { document.body.classList.add('is-ready'); reportHeight(); });
window.addEventListener('resize', reportHeight);
new ResizeObserver(reportHeight).observe(document.querySelector('.sb'));
