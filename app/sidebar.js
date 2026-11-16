/* 侧边栏：时钟 / 天气 / 系统 / 正在播放 / 待办 */
const SHELL = window.desktopShell || {};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

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

    const kb = s.netKb || 0;
    $('#netVal').textContent = kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB/s' : kb.toFixed(0) + ' KB/s';
    $('#netBar').style.width = Math.min(100, Math.max(2, kb / 20)) + '%';
  } catch { /* 忽略 */ }
}
loadStats();
setInterval(loadStats, 2000);

/* ---------------- 正在播放 ---------------- */
const fmtT = (sec) => {
  const s = Math.max(0, sec | 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
let lastMedia = null;
async function loadMedia() {
  if (!SHELL.media) return;
  try {
    const m = await SHELL.media();
    const card = $('#mediaCard');
    if (!m || !m.title) { card.hidden = true; lastMedia = null; return; }
    card.hidden = false;
    lastMedia = m;
    $('#mTitle').textContent = m.title;
    $('#mArtist').textContent = m.artist || m.app || '';
    $('#mPos').textContent = fmtT(m.pos);
    $('#mDur').textContent = fmtT(m.dur);
    $('#mBar').style.width = (m.dur ? Math.min(100, (m.pos / m.dur) * 100) : 0) + '%';
    $('#mPlay').textContent = m.playing ? '⏸' : '▶';
    document.body.classList.toggle('is-paused', !m.playing);
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

window.addEventListener('focus', () => { loadStats(); loadMedia(); });
requestAnimationFrame(() => document.body.classList.add('is-ready'));
