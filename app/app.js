/* ==========================================================================
   静林桌面 · 桌面部件
   本地 .lnk 的 Dock + 分区的 Deskbox 抽屉 + Rainmeter 式时钟
   ========================================================================== */
(() => {
  'use strict';

  const SHELL = window.desktopShell || null;
  const OVERLAY = !!(SHELL && SHELL.overlay);
  if (OVERLAY) {
    document.documentElement.classList.add('overlay');
    document.body.classList.add('overlay');
  }

  /* 任何脚本错误都要看得见，不能悄悄把界面弄没 */
  window.addEventListener('error', (e) => {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;max-width:70%;'
      + 'background:rgba(120,30,30,.92);color:#ffd9d2;font:12px/1.5 ui-monospace,monospace;'
      + 'padding:8px 12px;border-radius:10px;white-space:pre-wrap';
    bar.textContent = `脚本出错：${e.message}${e.lineno ? ` (行 ${e.lineno})` : ''}`;
    document.body.appendChild(bar);
  });

  /* ---------------------------------------------------------------------- */
  /* 0. utils                                                               */
  /* ---------------------------------------------------------------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  class Spring {
    constructor({ value = 0, response = 0.34, damping = 1, onUpdate }) {
      this.value = value; this.target = value; this.velocity = 0;
      this.onUpdate = onUpdate; this.running = false;
      this.setParams(response, damping);
    }
    setParams(response, damping = 1) {
      const omega = (2 * Math.PI) / Math.max(0.05, response);
      this.stiffness = omega * omega;
      this.dampingC = 2 * damping * omega;
    }
    set(target, velocity) {
      this.target = target;
      if (typeof velocity === 'number') this.velocity = velocity;
      this.run();
    }
    jump(v) { this.value = this.target = v; this.velocity = 0; this.onUpdate(v); }
    run() {
      if (this.running) return;
      this.running = true; this.last = performance.now();
      this.tick = this.tick.bind(this);
      requestAnimationFrame(this.tick);
    }
    tick(now) {
      let dt = clamp((now - this.last) / 1000, 0, 1 / 30);
      this.last = now;
      const steps = Math.max(1, Math.ceil(dt / 0.004));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const a = -this.stiffness * (this.value - this.target) - this.dampingC * this.velocity;
        this.velocity += a * h; this.value += this.velocity * h;
      }
      if (Math.abs(this.velocity) < 0.6 && Math.abs(this.value - this.target) < 0.08) {
        this.value = this.target; this.velocity = 0; this.onUpdate(this.value);
        this.running = false; return;
      }
      this.onUpdate(this.value);
      requestAnimationFrame(this.tick);
    }
  }

  function project(v, decel = 0.998) { return (v / 1000) * decel / (1 - decel); }

  /* ---------------------------------------------------------------------- */
  /* 1. state                                                               */
  /* ---------------------------------------------------------------------- */
  const KEY = 'deskshell.v3';
  const LEGACY = 'deskshell.v2';

  const defaultState = () => ({
    v: 3,
    wallpaper: { preset: 'forest', custom: null, cover: false },
    clock: { x: null, y: null, visible: true, weather: { now: 16, low: 9, wind: 14, hum: 68 } },
    dock: [],
    sections: [{ id: uid(), name: '常用', items: [] }],
    mailboxes: [],
    seeded: false,
  });

  let state = load();

  function load() {
    try {
      if (location.search.includes('reset')) { localStorage.removeItem(KEY); return defaultState(); }
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const d = defaultState();
        return {
          ...d, ...s,
          wallpaper: { ...d.wallpaper, ...(s.wallpaper || {}) },
          clock: { ...d.clock, ...(s.clock || {}), weather: { ...d.clock.weather, ...(s.clock?.weather || {}) } },
          dock: Array.isArray(s.dock) ? s.dock : d.dock,
          sections: Array.isArray(s.sections) && s.sections.length ? s.sections : d.sections,
        };
      }
      /* 从 v2（emoji 版）迁移 */
      const old = localStorage.getItem(LEGACY);
      if (old) {
        const s = JSON.parse(old);
        const conv = (i) => ({ id: i.id || uid(), path: i.url || '', name: i.name || '?' });
        const d = defaultState();
        d.dock = (s.dock || []).map(conv);
        d.sections = [{ id: uid(), name: '常用', items: (s.deskbox || []).map(conv) }];
        d.wallpaper = { ...d.wallpaper, ...(s.wallpaper || {}) };
        d.clock = { ...d.clock, ...(s.clock || {}) };
        d.seeded = true;
        return d;
      }
    } catch { /* 坏数据就当没有 */ }
    return defaultState();
  }

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(state)); }
      catch { toast('本地存储写入失败（自定义壁纸可能太大）'); }
    }, 120);
  }

  const allSections = () => state.sections;

  /* ---------------------------------------------------------------------- */
  /* 2. 图标（真实 exe / lnk 图标由主进程给）                                 */
  /* ---------------------------------------------------------------------- */
  const iconCache = new Map();
  const targetCache = new Map();     /* .lnk -> 真实 exe */

  function iconSource(item) {
    return targetCache.get(item.path) || item.path;
  }

  async function ensureLinks() {
    if (!SHELL || !SHELL.resolveLinks) return false;
    const paths = [...state.dock, ...state.sections.flatMap((s) => s.items)]
      .map((i) => i.path).filter((p) => p && /\.lnk$/i.test(p) && !targetCache.has(p));
    if (!paths.length) return false;
    try {
      const map = await SHELL.resolveLinks(paths);
      let changed = false;
      for (const [k, v] of Object.entries(map || {})) {
        if (v) { targetCache.set(k, String(v)); changed = true; }
      }
      return changed;
    } catch { return false; }
  }

  function paintIcon(box, item) {
    const src = iconSource(item);
    const cached = src ? iconCache.get(src) : null;
    if (cached) {
      box.innerHTML = `<img src="${cached}" alt="" draggable="false">`;
      return;
    }
    box.innerHTML = `<span class="icon-letter">${esc((item.name || '?').trim().slice(0, 1).toUpperCase())}</span>`;
    box.classList.add('is-fallback');
    if (!src || !SHELL || !SHELL.icon) return;
    SHELL.icon(src).then((url) => {
      if (!url) return;
      iconCache.set(src, url);
      if (!box.isConnected) return;
      box.classList.remove('is-fallback');
      box.innerHTML = `<img src="${url}" alt="" draggable="false">`;
    }).catch(() => {});
  }

  /* ---------------------------------------------------------------------- */
  /* 3. 壁纸                                                                */
  /* ---------------------------------------------------------------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function spruce(x, baseY, h, w, rnd) {
    const tiers = 10 + ((rnd() * 5) | 0);
    const topY = baseY - h;
    const lean = (rnd() - .5) * .1;
    let d = `M${(x - w * .028).toFixed(1)},${baseY} L${(x + w * .028).toFixed(1)},${baseY}`
          + ` L${(x + w * .02).toFixed(1)},${(baseY - h * .38).toFixed(1)}`
          + ` L${(x - w * .02).toFixed(1)},${(baseY - h * .38).toFixed(1)} Z `;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const yTip = topY + h * .04 + t * h * .80;
      const yBase = yTip + h * (.13 + rnd() * .07);
      const half = w * (.05 + .95 * Math.pow(t, .68)) * (.86 + rnd() * .3);
      const tipX = x + lean * h * t + (rnd() - .5) * w * .065;
      d += `M${tipX.toFixed(1)},${yTip.toFixed(1)} L${(x + half).toFixed(1)},${yBase.toFixed(1)} L${(x - half).toFixed(1)},${yBase.toFixed(1)} Z `;
    }
    return d;
  }

  function forestURL({ seed, count, color, w = 2600, h = 1000, minH = .5, maxH = 1 }) {
    const rnd = mulberry32(seed);
    let d = '';
    for (let i = 0; i < count; i++) {
      const x = rnd() * w;
      const th = h * (minH + rnd() * (maxH - minH));
      const tw = th * (.15 + rnd() * .10);
      d += spruce(x, h + 4, th, tw, rnd);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path fill="${color}" d="${d}"/></svg>`;
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  }

  function buildForest() {
    const layers = [
      ['#wpFar',  { seed: 11, count: 120, color: '#809086', minH: .30, maxH: .58 }],
      ['#wpMid',  { seed: 27, count: 88,  color: '#65746c', minH: .38, maxH: .74 }],
      ['#wpNear', { seed: 43, count: 56,  color: '#465450', minH: .48, maxH: .92 }],
      ['#wpFore', { seed: 59, count: 32,  color: '#212b29', minH: .60, maxH: 1.06 }],
      ['#wpHaze', { seed: 71, count: 20,  color: '#dbe4dd', minH: .26, maxH: .44 }],
    ];
    for (const [sel, cfg] of layers) {
      const el = $(sel);
      if (el) el.style.backgroundImage = forestURL(cfg);
    }
  }

  const wallImage = document.createElement('div');
  wallImage.className = 'wp-image';
  $('.wallpaper').appendChild(wallImage);

  function applyWallpaper() {
    const { preset, custom, cover } = state.wallpaper;
    document.body.dataset.wall = preset;
    document.body.classList.toggle('wall-on', !!cover);
    if (preset === 'custom' && custom) {
      wallImage.style.backgroundImage = `url("${custom}")`;
      wallImage.style.display = '';
    } else {
      wallImage.style.backgroundImage = 'none';
      wallImage.style.display = 'none';
    }
    $$('#wallSwatches .swatch').forEach(b => b.classList.toggle('is-on', b.dataset.preset === preset && !!cover));
    const cb = $('#wallCover');
    if (cb) cb.checked = !!cover;
  }

  /* ---------------------------------------------------------------------- */
  /* 4. 时钟                                                                */
  /* ---------------------------------------------------------------------- */
  const clockEl = $('#clock');
  const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function renderClock() {
    const now = new Date();
    $('#clockTime').textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    $('#clockScript').textContent = WEEK[now.getDay()];
    $('#clockDate').textContent = `${now.getDate()} ${MONTH[now.getMonth()]}`;
    const w = state.clock.weather;
    const capT = $('#capTime');
    if (capT) capT.textContent = $('#clockTime').textContent;
    const capTemp = $('#capTemp');
    if (capTemp) capTemp.textContent = `${w.now}°`;
    $('#clockTemps').textContent = `${w.now}° / ${w.low}°C`;
    $('#clockWind').textContent = `Wind ${w.wind} km/h`;
    $('#clockHum').textContent = `Humidity ${w.hum}%`;
  }

  function placeClock() {
    const c = state.clock;
    document.body.classList.toggle('clock-hidden', !c.visible);
    if (c.x == null || c.y == null) { clockEl.style.left = '50%'; clockEl.style.top = '30%'; }
    else { clockEl.style.left = `${c.x}px`; clockEl.style.top = `${c.y}px`; }
  }

  function initClock() {
    renderClock();
    setInterval(renderClock, 1000);
    placeClock();

    let drag = null;
    clockEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = clockEl.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, moved: false };
      try { clockEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      clockEl.classList.add('is-dragging');
    });
    clockEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      const r = clockEl.getBoundingClientRect();
      clockEl.style.left = `${clamp(drag.cx + dx, r.width / 2 - 20, innerWidth - r.width / 2 + 20)}px`;
      clockEl.style.top = `${clamp(drag.cy + dy, r.height / 2 - 10, innerHeight - r.height / 2 + 10)}px`;
      scheduleZones();
    });
    const end = () => {
      if (!drag) return;
      clockEl.classList.remove('is-dragging');
      if (drag.moved) {
        const r = clockEl.getBoundingClientRect();
        state.clock.x = Math.round(r.left + r.width / 2);
        state.clock.y = Math.round(r.top + r.height / 2);
        save();
      }
      drag = null;
    };
    clockEl.addEventListener('pointerup', end);
    clockEl.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { if (state.clock.x == null) placeClock(); });
  }

  async function refreshWeather(silent) {
    const note = $('#weatherNote');
    note.textContent = '正在读取…';
    try {
      const res = await fetch('https://wttr.in/?format=j1', { mode: 'cors', cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const j = await res.json();
      const cur = j.current_condition?.[0] || {};
      const today = j.weather?.[0] || {};
      state.clock.weather = {
        now: Number(cur.temp_C ?? 16), low: Number(today.mintempC ?? 9),
        wind: Number(cur.windspeedKmph ?? 14), hum: Number(cur.humidity ?? 68),
      };
      save(); renderClock();
      note.textContent = '天气来自 wttr.in。';
      if (!silent) toast('天气已更新');
    } catch {
      note.textContent = '联网不可用，保留模拟值。';
      if (!silent) toast('天气读取失败，保留模拟值');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 5. 覆盖层：热区上报                                                     */
  /* ---------------------------------------------------------------------- */
  const HIT_SELECTOR = '.clock, .dock, .dock-tip, .capsule, .apps-pop, .cc, .panel, .dialog-root, .ctx';
  let dragPinned = false;
  let dragPinnedTimer = 0;
  /* 拖动期间整屏接管鼠标；万一 pointerup 丢了会永远接管，这里加自动过期 */
  function pinDrag(on) {
    dragPinned = !!on;
    clearTimeout(dragPinnedTimer);
    if (on) dragPinnedTimer = setTimeout(() => { dragPinned = false; scheduleZones(); }, 3000);
    scheduleZones();
  }
  let zonesQueued = false;

  function publishZones() {
    if (!OVERLAY || !SHELL || !SHELL.setZones) return;
    const rects = [];
    for (const el of $$(HIT_SELECTOR)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    const dlg = $('#dialogRoot'), pick = $('#pickerRoot'), panel = $('#settingsPanel');
    const full = dragPinned
      || (dlg && !dlg.hidden) || (pick && !pick.hidden) || (panel && panel.classList.contains('is-open'))
      || isOpen;
    try { SHELL.setZones(rects, full); } catch { /* 忽略 */ }
  }

  function scheduleZones() {
    if (zonesQueued) return;
    zonesQueued = true;
    requestAnimationFrame(() => { zonesQueued = false; publishZones(); });
  }

  function initOverlay() {
    if (!OVERLAY) return;
    window.addEventListener('resize', scheduleZones);
    setInterval(scheduleZones, 800);
    scheduleZones();
  }

  /* ---------------------------------------------------------------------- */
  /* 6. Dock                                                                */
  /* ---------------------------------------------------------------------- */
  const dockEl = $('#dock');
  const dockItems = $('#dockItems');
  let dockGeom = { centers: [], pitch: 66, w: 54, n: 0 };
  let dockScales = [];
  let dockSprings = [];
  let pointerX = null;

  function dockNode(item) {
    const el = document.createElement('div');
    el.className = 'dock-item';
    el.dataset.id = item.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', item.name);
    el.title = item.name;
    el.innerHTML = `<span class="dock-icon"></span><span class="run-dot"></span>`;
    paintIcon(el.firstElementChild, item);
    return el;
  }

  function renderDock() {
    dockItems.textContent = '';
    state.dock.forEach((it) => dockItems.appendChild(dockNode(it)));
    measureDock();
    scheduleZones();
  }

  function measureDock() {
    const items = $$('.dock-item', dockItems);
    const n = items.length;
    dockGeom.n = n;
    if (!n) { dockGeom.centers = []; dockScales = []; dockSprings = []; return; }
    const prev = dockItems.style.transform;
    dockItems.style.transform = 'none';
    $$('.dock-icon', dockItems).forEach((i) => { i.style.transform = ''; });
    const rects = items.map((el) => el.getBoundingClientRect());
    dockGeom.centers = rects.map((r) => r.left + r.width / 2);
    dockGeom.w = rects[0].width;
    dockGeom.pitch = n > 1 ? (rects[1].left - rects[0].left) : rects[0].width + 10;
    dockItems.style.transform = prev;
    dockScales = new Array(n).fill(1);
    dockSprings = items.map((_, i) => new Spring({
      value: 1, response: 0.22, damping: 0.9,
      onUpdate: (v) => { dockScales[i] = v; scheduleDockPaint(); },
    }));
  }

  let paintQueued = false;
  function scheduleDockPaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paintDock(); });
  }

  function paintDock() {
    const items = $$('.dock-item', dockItems);
    const n = items.length;
    if (!n) { dockItems.style.transform = ''; return; }
    const W = dockGeom.w;
    let dx = 0;
    const dxs = [];
    let maxScale = 1;
    for (let i = 0; i < n; i++) {
      dxs[i] = dx;
      dx += (dockScales[i] - 1) * W;
      if (dockScales[i] > maxScale) maxScale = dockScales[i];
    }
    const total = dx;
    let anchor = total / 2;
    if (pointerX != null && dockGeom.pitch > 0) {
      const k = clamp((pointerX - dockGeom.centers[0]) / dockGeom.pitch, 0, n - 1);
      const i0 = Math.floor(k), t = k - i0;
      anchor = dxs[i0] * (1 - t) + dxs[Math.min(i0 + 1, n - 1)] * t;
    }
    dockItems.style.transform = `translate3d(${-anchor.toFixed(2)}px,0,0)`;
    const padL = Math.max(0, anchor), padR = Math.max(0, total - anchor);
    dockEl.style.setProperty('--pad-l', `${padL.toFixed(2)}px`);
    dockEl.style.setProperty('--pad-r', `${padR.toFixed(2)}px`);
    dockEl.style.setProperty('--pad-t', `${((maxScale - 1) * W * 0.5).toFixed(2)}px`);
    for (let i = 0; i < n; i++) {
      items[i].style.transform = `translate3d(${dxs[i].toFixed(2)}px,0,0)`;
      items[i].firstElementChild.style.transform = `scale(${dockScales[i].toFixed(3)})`;
      items[i].style.zIndex = dockScales[i] > 1.02 ? String(10 + Math.round(dockScales[i] * 10)) : '';
    }
  }

  function updateDockTargets(x) {
    pointerX = x;
    if (drag && drag.moved) return;
    const sigma = 96;
    dockGeom.centers.forEach((c, i) => {
      const d = Math.abs(x - c);
      const g = Math.exp(-(d * d) / (2 * sigma * sigma));
      if (dockSprings[i]) dockSprings[i].set(1 + 0.44 * g);
    });
  }

  function releaseDock() {
    pointerX = null;
    dockSprings.forEach((s) => s.set(1));
  }

  /* 悬停提示 */
  const tip = document.createElement('div');
  tip.className = 'dock-tip';
  document.body.appendChild(tip);

  function showTip(el) {
    const item = state.dock.find((i) => i.id === el.dataset.id);
    if (!item) return;
    const r = el.getBoundingClientRect();
    const plateTop = dockEl.getBoundingClientRect().top;
    tip.textContent = item.name;
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${Math.min(r.top, plateTop) - 32}px`;
    tip.classList.add('is-on');
  }
  function hideTip() { tip.classList.remove('is-on'); }

  /* ---------------------------------------------------------------------- */
  /* 7. 抽屉分区                                                            */
  /* ---------------------------------------------------------------------- */
  const drawer = $('#drawer');
  const scrim = $('#drawerScrim');
  const sectionList = $('#sectionList');
  const PEEK = 34;

  let drawerH = 0;
  let isOpen = false;
  const drawerSpring = new Spring({ value: 0, response: 0.32, damping: 0.82, onUpdate: (v) => paintDrawer(v) });

  function closedOffset() {
    drawerH = drawer.offsetHeight || 0;
    return -(Math.max(drawerH - PEEK, 0));
  }

  function paintDrawer(ty) {
    drawer.style.transform = `translate3d(0, ${ty}px, 0)`;
    const span = Math.max(Math.abs(closedOffset()) || 1, 1);
    const p = clamp((ty - closedOffset()) / span, 0, 1);
    scrim.style.opacity = String(p);
    scrim.style.pointerEvents = p > 0.02 ? 'auto' : 'none';
    drawer.classList.toggle('is-open', p > 0.35);
    document.body.classList.toggle('drawer-open', p > 0.35);
    scheduleZones();
  }

  function openDrawer(spring = true) {
    if (isOpen) return;
    isOpen = true;
    drawer.setAttribute('aria-hidden', 'false');
    if (spring) { drawerSpring.setParams(0.32, 0.82); drawerSpring.set(0); }
    else drawerSpring.jump(0);
  }

  function closeDrawer(velocity = 0) {
    if (!isOpen) return;
    isOpen = false;
    drawer.setAttribute('aria-hidden', 'true');
    drawerSpring.setParams(0.32, 0.92);
    drawerSpring.set(closedOffset(), velocity);
  }

  function tileNode(item, sid) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.id = item.id;
    el.dataset.sid = sid;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', item.name);
    el.innerHTML = `<span class="tile-icon"></span><span class="tile-label">${esc(item.name)}</span>`;
    paintIcon(el.firstElementChild, item);
    return el;
  }

  function sectionNode(sec) {
    const wrap = document.createElement('section');
    wrap.className = 'sect';
    wrap.dataset.sid = sec.id;
    wrap.innerHTML = `
      <header class="sect-head">
        <span class="sect-title" contenteditable="false" spellcheck="false">${esc(sec.name)}</span>
        <span class="sect-count">${sec.items.length}</span>
        <button class="sect-del" title="删除这个分区">✕</button>
      </header>
      <div class="sect-grid" data-sid="${sec.id}"></div>`;
    const grid = wrap.querySelector('.sect-grid');
    sec.items.forEach((it) => grid.appendChild(tileNode(it, sec.id)));
    return wrap;
  }

  function renderSections() {
    sectionList.textContent = '';
    state.sections.forEach((sec) => sectionList.appendChild(sectionNode(sec)));
    $('#drawerCount').textContent = `${state.sections.reduce((n, s) => n + s.items.length, 0)} 个`;
    $('#gridEmpty').hidden = state.sections.some((s) => s.items.length > 0);
    drawerH = drawer.offsetHeight || drawerH;
    if (!isOpen) drawerSpring.jump(closedOffset());
    scheduleZones();
  }

  /* 标题改名 */
  sectionList.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.sect-title');
    if (!t) return;
    t.contentEditable = 'true';
    t.focus();
    document.execCommand?.('selectAll', false, null);
  });
  sectionList.addEventListener('blur', (e) => {
    const t = e.target.closest?.('.sect-title');
    if (!t) return;
    t.contentEditable = 'false';
    const sid = t.closest('.sect').dataset.sid;
    const sec = state.sections.find((s) => s.id === sid);
    if (!sec) return;
    const name = (t.textContent || '').trim() || '未命名';
    if (name !== sec.name) { sec.name = name; save(); }
    t.textContent = name;
  }, true);
  sectionList.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('.sect-title');
    if (!t) return;
    if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
  });

  sectionList.addEventListener('click', (e) => {
    const del = e.target.closest('.sect-del');
    if (!del) return;
    const sid = del.closest('.sect').dataset.sid;
    const sec = state.sections.find((s) => s.id === sid);
    if (!sec) return;
    if (sec.items.length && !window.confirm(`删除分区「${sec.name}」和里面的 ${sec.items.length} 个图标？（不会删桌面文件）`)) return;
    state.sections = state.sections.filter((s) => s.id !== sid);
    if (!state.sections.length) state.sections.push({ id: uid(), name: '常用', items: [] });
    save(); renderSections();
  });

  /* ---------------------------------------------------------------------- */
  /* 8. 拖拽（排序 + 跨分区 + 从桌面拖入）                                   */
  /* ---------------------------------------------------------------------- */
  let drag = null;

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('.dock-item, .tile');
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag = {
      el, kind: el.classList.contains('dock-item') ? 'dock' : 'tile',
      sx: e.clientX, sy: e.clientY, offX: r.left - e.clientX, offY: r.top - e.clientY,
      moved: false, pointerId: e.pointerId,
    };
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 7) return;
      drag.moved = true;
      pinDrag(true);
      drag.el.classList.add('is-dragging');
      if (drag.kind === 'dock') { releaseDock(); hideTip(); }
      closeCtx();
      try { drag.el.setPointerCapture(drag.pointerId); } catch { /* 忽略 */ }
    }
    const tr = drag.el.style.transform;
    drag.el.style.transform = 'none';
    const base = drag.el.getBoundingClientRect();
    drag.el.style.transform = tr;
    const s = drag.kind === 'dock' ? 1.08 : 1.05;
    drag.el.style.transform =
      `translate3d(${((e.clientX + drag.offX) - base.left).toFixed(2)}px, ${((e.clientY + drag.offY) - base.top).toFixed(2)}px, 0) scale(${s})`;

    const under = document.elementFromPoint(e.clientX, e.clientY);
    const targetItem = under?.closest(drag.kind === 'dock' ? '.dock-item' : '.tile');
    const targetGrid = under?.closest('.sect-grid');

    if (drag.kind === 'tile' && targetGrid && drag.el.parentElement !== targetGrid) {
      targetGrid.appendChild(drag.el);
    }
    if (targetItem && targetItem !== drag.el) {
      const parent = targetItem.parentElement;
      const items = [...parent.children];
      const from = items.indexOf(drag.el);
      const to = items.indexOf(targetItem);
      const before = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
      if (from === -1 || from < to) parent.insertBefore(drag.el, targetItem.nextSibling);
      else parent.insertBefore(drag.el, targetItem);
      items.forEach((el) => {
        if (el === drag.el) return;
        const b = before.get(el);
        const a = el.getBoundingClientRect();
        const ddx = b.left - a.left, ddy = b.top - a.top;
        if (Math.abs(ddx) < 1 && Math.abs(ddy) < 1) return;
        el.animate([{ transform: `translate(${ddx}px,${ddy}px)` }, { transform: 'none' }],
          { duration: 190, easing: 'cubic-bezier(0.32,0.72,0,1)' });
      });
    }
  });

  function commitOrder() {
    /* Dock */
    const dockOrder = $$('.dock-item', dockItems).map((n) => n.dataset.id);
    if (dockOrder.length === state.dock.length) {
      const next = dockOrder.map((id) => state.dock.find((i) => i.id === id)).filter(Boolean);
      if (next.length === state.dock.length) state.dock = next;
    }
    /* 每个分区 */
    for (const grid of $$('.sect-grid', sectionList)) {
      const sec = state.sections.find((s) => s.id === grid.dataset.sid);
      if (!sec) continue;
      const ids = $$('.tile', grid).map((n) => n.dataset.id);
      const pool = state.sections.flatMap((s) => s.items);
      const next = ids.map((id) => pool.find((i) => i.id === id)).filter(Boolean);
      if (next.length === ids.length) sec.items = next;
    }
    /* 丢掉不在任何网格里的条目 */
    const alive = new Set($$('.tile', sectionList).map((n) => n.dataset.id));
    state.sections.forEach((s) => { s.items = s.items.filter((i) => alive.has(i.id)); });
    save();
  }

  function endDrag() {
    if (!drag) return;
    const { el, moved } = drag;
    dragPinned = false;
    try { el.releasePointerCapture?.(drag.pointerId); } catch { /* 忽略 */ }
    drag = null;
    scheduleZones();
    if (!moved) return;
    el.style.transition = 'transform 230ms cubic-bezier(0.32,0.72,0,1)';
    el.style.transform = 'none';
    setTimeout(() => { el.style.transition = ''; el.classList.remove('is-dragging'); }, 240);
    commitOrder();
    if (el.classList.contains('dock-item')) measureDock();
    else {
      /* 分区计数刷新 */
      state.sections.forEach((sec) => {
        const node = sectionList.querySelector(`.sect[data-sid="${sec.id}"] .sect-count`);
        if (node) node.textContent = String(sec.items.length);
      });
    }
  }

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  /* 从桌面拖文件进来 */
  function normalizeItems(list) {
    return list.map((it) => {
      if (it && typeof it === 'object' && it.path) return { path: it.path, name: it.name || it.path };
      const p = String(it || '');
      return { path: p, name: p.split(/[\\/]/).pop().replace(/\.(lnk|url|exe)$/i, '') };
    }).filter((it) => it.path);
  }

  function addPaths(list, target) {
    const items = normalizeItems(list);
    if (!items.length) return;
    if (target === 'dock') { addPathsToDock(items); return; }
    const sec = state.sections.find((s) => s.id === target) || state.sections[0];
    if (!sec) return;
    let n = 0;
    for (const it of items) {
      if (state.sections.some((s) => s.items.some((i) => i.path === it.path))) continue;
      if (state.dock.some((i) => i.path === it.path)) continue;
      sec.items.push({ id: uid(), path: it.path, name: it.name });
      n++;
    }
    if (!n) { toast('都已经在里面了'); return; }
    save(); renderSections(); renderDock();
    toast(`已加入 ${n} 个到「${sec.name}」`);
    refreshIcons();
  }

  function addPathsToDock(list) {
    const items = normalizeItems(list);
    if (!items.length) return;
    let n = 0;
    for (const it of items) {
      if (state.dock.some((i) => i.path === it.path)) continue;
      state.dock.push({ id: uid(), path: it.path, name: it.name });
      n++;
    }
    if (!n) { toast('Dock 里已经有了'); return; }
    save(); renderDock();
    toast(`Dock +${n}`);
    refreshIcons();
  }

  function initDrop() {
    const clearHL = () => {
      dockEl.classList.remove('is-drop');
      $$('.sect-grid', sectionList).forEach((g) => g.classList.remove('is-drop'));
      $('#dockDrop').hidden = true;
    };
    document.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const overDock = e.target.closest('#dock');
      const overGrid = e.target.closest('.sect-grid');
      clearHL();
      if (overDock) { dockEl.classList.add('is-drop'); $('#dockDrop').hidden = false; }
      else if (overGrid) overGrid.classList.add('is-drop');
    });
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearHL(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      clearHL();
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      const paths = files.map((f) => (SHELL && SHELL.pathForFile ? SHELL.pathForFile(f) : '')).filter(Boolean);
      if (!paths.length) return;
      if (e.target.closest('#dock')) addPathsToDock(paths);
      else {
        const grid = e.target.closest('.sect-grid');
        addPaths(paths, grid?.dataset.sid);
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 9. 点击 / 右键                                                          */
  /* ---------------------------------------------------------------------- */
  function openItem(item) {
    if (!item || !item.path) { toast('这一项还没有指向文件'); return; }
    if (SHELL && SHELL.open) SHELL.open(item.path);
    else if (/^https?:/i.test(item.path)) window.open(item.path, '_blank');
  }

  function initItemEvents() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('.dock-item, .tile');
      if (!el || drag) return;
      const id = el.dataset.id;
      const item = [...state.dock, ...state.sections.flatMap((s) => s.items)].find((i) => i.id === id);
      if (item) openItem(item);
    });

    document.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('.dock-item, .tile');
      if (!el) return;
      e.preventDefault();
      const id = el.dataset.id;
      const inDock = el.classList.contains('dock-item');
      const item = (inDock ? state.dock : state.sections.flatMap((s) => s.items)).find((i) => i.id === id);
      if (item) openCtx(e.clientX, e.clientY, inDock, item);
    });

    dockItems.addEventListener('pointermove', (e) => {
      if (!matchMedia('(pointer: fine)').matches) return;
      updateDockTargets(e.clientX);
    });
    dockEl.addEventListener('pointerleave', () => { if (!drag) releaseDock(); hideTip(); });

    dockItems.addEventListener('pointerover', (e) => {
      const el = e.target.closest('.dock-item');
      if (!el || (drag && drag.moved)) return;
      if (!matchMedia('(pointer: fine)').matches) return;
      showTip(el);
    });
    dockItems.addEventListener('pointerout', (e) => {
      if (e.target.closest('.dock-item')) hideTip();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 10. 右键菜单                                                           */
  /* ---------------------------------------------------------------------- */
  const ctxEl = $('#ctx');
  let ctxTarget = null;

  function ensureCtxEl() {
    /* index.html 里不再内置菜单，第一次用时建一个 */
    if ($('#ctx')) return;
    const d = document.createElement('div');
    d.id = 'ctx';
    d.className = 'ctx';
    d.hidden = true;
    d.innerHTML = `
      <button data-act="open">打开</button>
      <button data-act="system">更多系统操作…</button>
      <button data-act="rename">重命名</button>
      <button data-act="unpin">从部件移除</button>
      <button data-act="delete" class="danger">删掉桌面上的快捷方式</button>`;
    document.body.appendChild(d);
  }

  function openCtx(x, y, inDock, item) {
    ensureCtxEl();
    const el = $('#ctx');
    ctxTarget = { inDock, item };
    el.hidden = false;
    const r = el.getBoundingClientRect();
    el.style.left = `${clamp(x, 8, innerWidth - r.width - 8)}px`;
    el.style.top = `${clamp(y, 8, innerHeight - r.height - 8)}px`;
    el.style.transformOrigin = 'top left';
    scheduleZones();
  }

  function closeCtx() {
    const el = $('#ctx');
    if (el) el.hidden = true;
    ctxTarget = null;
    scheduleZones();
  }

  function initCtx() {
    ensureCtxEl();
    document.addEventListener('click', (e) => {
      if (e.target.closest('#ctx')) return;
      closeCtx();
    }, true);
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('#ctx button');
      if (!btn || !ctxTarget) return;
      const act = btn.dataset.act;
      const { inDock, item } = ctxTarget;
      closeCtx();
      if (act === 'open') openItem(item);
      else if (act === 'system') { if (SHELL && SHELL.contextMenu) await SHELL.contextMenu(item.path); }
      else if (act === 'rename') openDialog(item, inDock);
      else if (act === 'unpin') removeItem(item.id, inDock);
      else if (act === 'delete' && SHELL && SHELL.contextMenu) {
        toast('请在「更多系统操作…」里选移到回收站');
      }
    });
  }

  function removeItem(id, inDock) {
    if (inDock) state.dock = state.dock.filter((i) => i.id !== id);
    else state.sections.forEach((s) => { s.items = s.items.filter((i) => i.id !== id); });
    save(); renderDock(); renderSections();
    toast('已移除');
  }

  /* ---------------------------------------------------------------------- */
  /* 11. 重命名弹窗                                                          */
  /* ---------------------------------------------------------------------- */
  const dialogRoot = $('#dialogRoot');
  let editing = null;

  function openDialog(item, inDock) {
    editing = { item, inDock };
    $('#dialogTitle').textContent = '重命名';
    $('#fName').value = item.name;
    $('#fPath').value = item.path || '（没有指向文件）';
    dialogRoot.hidden = false;
    if (SHELL && SHELL.setFocusable) SHELL.setFocusable(true);
    setTimeout(() => $('#fName').select(), 60);
    scheduleZones();
  }

  function closeDialog() {
    dialogRoot.hidden = true;
    editing = null;
    if (SHELL && SHELL.setFocusable) SHELL.setFocusable(false);
    scheduleZones();
  }

  function initDialog() {
    $('#dialogScrim').addEventListener('click', closeDialog);
    $('#dialogCancel').addEventListener('click', closeDialog);
    $('#dialogDelete').addEventListener('click', () => {
      if (!editing) return;
      const { item, inDock } = editing;
      closeDialog();
      removeItem(item.id, inDock);
    });
    $('#dialog').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!editing) return;
      editing.item.name = $('#fName').value.trim() || editing.item.name;
      save(); closeDialog(); renderDock(); renderSections();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 12. 管理：从桌面多选                                                    */
  /* ---------------------------------------------------------------------- */
  const pickerRoot = $('#pickerRoot');
  let pickerSid = null;

  async function openPicker() {
    if (!SHELL || !SHELL.listDesktop) { toast('这个功能只能在桌面版里用'); return; }
    const items = await SHELL.listDesktop();
    const secSel = $('#pickerSection');
    secSel.innerHTML = `<option value="dock">Dock（底部）</option>`
      + state.sections.map((s) => `<option value="${s.id}">分区：${esc(s.name)}</option>`).join('');
    pickerSid = state.sections[0]?.id || 'dock';
    secSel.value = pickerSid;
    const listEl = $('#pickerList');

    /* 系统位置：此电脑 / 回收站 这些不是文件，拖不进来，这里一键加 */
    const placeRow = $('#placeRow');
    if (SHELL.listPlaces) {
      try {
        const places = await SHELL.listPlaces();
        placeRow.innerHTML = places.map((p) =>
          `<button class="place-chip" data-path="${esc(p.path)}" data-name="${esc(p.name)}">${esc(p.name)}</button>`
        ).join('');
      } catch { placeRow.innerHTML = ''; }
    }

    /* 先把 .lnk 解析成真实 exe，列表里才能显示程序自己的图标 */
    const pending = items.map((i) => i.path).filter((p) => /\.lnk$/i.test(p) && !targetCache.has(p));
    if (pending.length && SHELL.resolveLinks) {
      try {
        const map = await SHELL.resolveLinks(pending);
        for (const [k, v] of Object.entries(map || {})) if (v) targetCache.set(k, String(v));
      } catch { /* 忽略 */ }
    }

    if (!items.length) { listEl.innerHTML = '<p class="set-note">桌面上没有找到 .lnk 快捷方式。</p>'; }
    else {
      listEl.innerHTML = items.map((it) => `
        <label class="pick-row">
          <input type="checkbox" value="${esc(it.path)}">
          <span class="pick-name">${esc(it.name)}</span>
        </label>`).join('');
      listEl.querySelectorAll('input').forEach((cb) => {
        const path = cb.value;
        const src = targetCache.get(path) || path;
        SHELL.icon(src).then((u) => {
          if (!u || !cb.isConnected) return;
          const img = document.createElement('img');
          img.src = u; img.alt = '';
          cb.parentElement.insertBefore(img, cb.nextSibling);
        });
      });
    }
    pickerRoot.hidden = false;
    if (SHELL.setFocusable) SHELL.setFocusable(true);
    scheduleZones();
  }

  function closePicker() {
    pickerRoot.hidden = true;
    if (SHELL.setFocusable) SHELL.setFocusable(false);
    scheduleZones();
  }

  function initPicker() {
    $('#drawerManage').addEventListener('click', openPicker);
    $('#pickerScrim').addEventListener('click', closePicker);
    $('#pickerCancel').addEventListener('click', closePicker);
    $('#pickerSection').addEventListener('change', (e) => { pickerSid = e.target.value; });
    $('#pickerAll').addEventListener('click', () => {
      const boxes = $$('#pickerList input[type="checkbox"]');
      const all = boxes.every((b) => b.checked);
      boxes.forEach((b) => { b.checked = !all; });
    });
    $('#placeRow').addEventListener('click', (e) => {
      const chip = e.target.closest('.place-chip');
      if (!chip) return;
      addPaths([{ path: chip.dataset.path, name: chip.dataset.name }], pickerSid);
    });
    $('#pickerAdd').addEventListener('click', () => {
      const paths = $$('#pickerList input:checked').map((b) => b.value);
      if (!paths.length) { toast('先勾几个'); return; }
      addPaths(paths, pickerSid);
      closePicker();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 12.5 悬停开始按钮 → 所有应用                                           */
  /* ---------------------------------------------------------------------- */
  const appsPop = $('#appsPop');
  let appsTimer = 0;
  let appsLoaded = false;

  async function fillApps() {
    if (!SHELL || !SHELL.listDesktop) return;
    const list = await SHELL.listDesktop();
    const pending = list.map((i) => i.path).filter((p) => /\.lnk$/i.test(p) && !targetCache.has(p));
    if (pending.length && SHELL.resolveLinks) {
      try {
        const map = await SHELL.resolveLinks(pending);
        for (const [k, v] of Object.entries(map || {})) if (v) targetCache.set(k, String(v));
      } catch { /* 忽略 */ }
    }
    const grid = $('#appsGrid');
    grid.innerHTML = list.map((it, i) => `
      <button class="apps-cell" data-i="${i}" title="${esc(it.path)}">
        <img alt="">
        <span>${esc(it.name)}</span>
      </button>`).join('');
    $('#appsCount').textContent = `${list.length} 个`;
    grid.querySelectorAll('.apps-cell').forEach((cell, i) => {
      const it = list[i];
      const src = targetCache.get(it.path) || it.path;
      SHELL.icon(src).then((u) => {
        const img = cell.querySelector('img');
        if (u && img) img.src = u;
      });
    });
    appsLoaded = true;
  }

  function showApps() {
    clearTimeout(appsTimer);
    appsTimer = setTimeout(async () => {
      if (!appsPop) return;
      if (!appsLoaded) await fillApps();
      appsPop.hidden = false;
      scheduleZones();
    }, 170);
  }

  function hideApps(soon = 260) {
    clearTimeout(appsTimer);
    appsTimer = setTimeout(() => {
      if (appsPop) appsPop.hidden = true;
      scheduleZones();
    }, soon);
  }

  function initApps() {
    const start = $('#dockStart');
    if (!start || !appsPop) return;
    start.addEventListener('pointerenter', showApps);
    start.addEventListener('pointerleave', () => hideApps());
    appsPop.addEventListener('pointerenter', () => clearTimeout(appsTimer));
    appsPop.addEventListener('pointerleave', () => hideApps(160));
    appsPop.addEventListener('click', (e) => {
      const cell = e.target.closest('.apps-cell');
      if (!cell) return;
      const path = cell.title;
      hideApps(0);
      if (SHELL && SHELL.open) SHELL.open(path);
    });
  }


  /* ---------------------------------------------------------------------- */
  /* 12.6 控制中心（胶囊展开）                                              */
  /* ---------------------------------------------------------------------- */
  const ccEl = $('#cc');
  let ccTimer = 0;
  let ccOpen = false;

  function openCC() {
    if (!ccEl || ccOpen) return;
    ccOpen = true;
    ccEl.classList.add('is-open');
    ccEl.setAttribute('aria-hidden', 'false');
    renderHome(); renderLiveMail(); refreshCC();
    scheduleZones();
  }

  function closeCC() {
    if (!ccEl || !ccOpen) return;
    ccOpen = false;
    ccEl.classList.remove('is-open');
    ccEl.setAttribute('aria-hidden', 'true');
    scheduleZones();
  }

  async function refreshCC() {
    if (!SHELL) return;
    try {
      const info = await SHELL.netInfo?.();
      const ssid = $('#ccSsid');
      if (ssid && info) ssid.textContent = info.ssid || '未连接';
    } catch { /* 忽略 */ }
  }

  const HOME_TILES = [
    { name: '此电脑', path: 'shell:MyComputerFolder' },
    { name: '用户文件夹', path: 'HOME' },
    { name: '下载', path: 'HOME/DOWNLOADS' },
    { name: '回收站', path: 'shell:RecycleBinFolder' },
  ];

  let sysPaths = null;

  function paintHomeIcons() {
    const map = { '此电脑': HOME_TILES[0].path, '用户文件夹': sysPaths && sysPaths.home, '下载': sysPaths && sysPaths.downloads, '回收站': HOME_TILES[3].path };
    $$('.home-tile').forEach((b) => {
      const name = b.querySelector('span').textContent;
      const p = map[name];
      if (!p || !SHELL || !SHELL.icon) return;
      SHELL.icon(p).then((u) => { if (u) b.querySelector('img').src = u; });
    });
  }

  async function renderHome() {
    const d = new Date();
    const h = d.getHours();
    $('#homeHi').textContent = h < 6 ? '凌晨好' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    $('#homeDate').textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${'日一二三四五六'[d.getDay()]}`;
    const w = state.clock.weather;
    $('#homeTemp').textContent = `${w.now}°`;
    $('#homeWx').textContent = `湿度 ${w.hum}% · 风 ${w.wind} km/h`;

    const tiles = $('#homeTiles');
    if (tiles.childElementCount) return;

    if (!sysPaths && SHELL && SHELL.sysPaths) {
      try { sysPaths = await SHELL.sysPaths(); } catch { /* ignore */ }
    }
    const defs = [
      { name: '此电脑', path: 'shell:MyComputerFolder' },
      { name: '用户文件夹', path: sysPaths && sysPaths.home },
      { name: '下载', path: sysPaths && sysPaths.downloads },
      { name: '回收站', path: 'shell:RecycleBinFolder' },
    ];
    for (const it of defs) {
      if (!it.path) continue;
      const b = document.createElement('button');
      b.className = 'home-tile';
      b.dataset.path = it.path;
      b.innerHTML = `<img alt=""><span>${esc(it.name)}</span>`;
      b.addEventListener('click', () => { if (SHELL && SHELL.open) SHELL.open(it.path); });
      tiles.appendChild(b);
      if (SHELL && SHELL.icon) {
        SHELL.icon(it.path).then((u) => { if (u) b.querySelector('img').src = u; });
      }
    }
  }

  let mailIndex = 0;
  let mailData = { count: 0, messages: [], error: '', bound: false, user: '' };

  /* 验证码识别：必须出现"验证码/校验码/code/verify"这类关键词，
     否则 GitHub 通知里的日期、编号都会被误判成验证码。 */
  /* 关键词要足够宽：像「iTab邮箱验证提醒153402」这种标题里并没有"验证码"三个字 */
  const OTP_KEY = /(验证码|校验码|动态码|动态密码|确认码|激活码|安全码|登录码|绑定码|口令|验证|认证|verification\s*code|verify|passcode|\botp\b|\bcode\b)/i;

  let curOtp = '';

  function pickOtp(msg) {
    if (!msg) return '';
    const subject = String(msg.subject || '');
    const from = String(msg.from || '');
    if (!OTP_KEY.test(subject) && !OTP_KEY.test(from)) return '';
    const hits = subject.match(/(?<!\d)(\d{4,8})(?!\d)/g) || [];
    if (!hits.length) return '';
    return hits[hits.length - 1];
  }

  /* 真实邮件（IMAP）→ 右侧列表 + 左侧大卡的验证码 */
  function renderLiveMail() {
    const side = $('#mailSide');
    if (!side) return;
    if (!mailData.bound) { curOtp = ''; const c0 = $('#mailCard'); if (c0) c0.classList.remove('has-otp'); const l0 = $('.mc-label'); if (l0) l0.textContent = '当前邮箱'; renderMail(); return; }
    const msgs = mailData.messages || [];
    side.innerHTML = mailData.error
      ? `<div class="ms-empty">收取失败：${esc(mailData.error)}</div>`
      : msgs.length
        ? msgs.map((m) => `
          <div class="ms-row">
            <span class="ms-name">${esc(m.from || '(未知发件人)')}</span>
            <span class="ms-time">${esc((m.date || '').slice(0, 16))}</span>
            <span class="ms-addr">${esc(m.subject || '(无主题)')}</span>
          </div>`).join('')
        : '<div class="ms-empty">收件箱是空的</div>';

    /* 从最新往旧找第一条带验证码的邮件 */
    let hit = null;
    for (const m of msgs) {
      const c = pickOtp(m);
      if (c) { hit = { code: c, msg: m }; break; }
    }
    curOtp = hit ? hit.code : '';

    const card = $('#mailCard');
    const label = $('.mc-label');
    const addr = $('#mcAddr');
    const copy = $('#mcCopy');

    if (card) card.classList.toggle('has-otp', !!hit);
    if (label) label.textContent = hit ? '验证码' : '当前邮箱';
    if (addr) {
      addr.textContent = hit ? hit.code : (mailData.user || '');
      addr.style.opacity = '1';
    }
    if (copy) {
      copy.textContent = hit ? ('来自 ' + (hit.msg.from || '邮件') + ' · 点击复制') : '点击邮箱地址复制';
    }
    const dots = $('#mailDots');
    if (dots) dots.innerHTML = '';
  }

  function renderMail() {
    const side = $('#mailSide');
    const dots = $('#mailDots');
    if (!side) return;
    const mails = state.mailboxes || [];
    if (!mails.length) {
      $('#mcAddr').textContent = 'me@qq.com';
      $('#mcAddr').style.opacity = '0.35';
      side.innerHTML = '<div class="ms-empty">还没有邮箱。<br>下面填一个地址，加进来。</div>';
      dots.innerHTML = '';
      return;
    }
    mailIndex = Math.min(mailIndex, mails.length - 1);
    const cur = mails[mailIndex];

    $('#mcAddr').style.opacity = '1';
    $('#mcAddr').textContent = cur.addr;
    $('#mcCopy').textContent = '点击复制地址';
    side.innerHTML = mails.map((m, i) => `
      <div class="ms-row ${i === mailIndex ? 'is-on' : ''}" data-i="${i}">
        <span class="ms-name">${esc(m.name || m.addr.split('@')[0])}</span>
        <span class="ms-time">${i === mailIndex ? '当前' : ''}</span>
        <span class="ms-addr">${esc(m.addr)}</span>
      </div>`).join('') + mails.map((m, i) => `
      <div class="ms-row" data-del="${m.id}" title="删除这个邮箱">
        <span class="ms-addr">✕ 移除 ${esc(m.addr)}</span>
      </div>`).join('');

    dots.innerHTML = mails.map((_, i) => `<i class="${i === mailIndex ? 'is-on' : ''}" data-dot="${i}"></i>`).join('');
    const dot = $('#tabDot');
    if (dot) dot.classList.toggle('is-on', mails.length > 0);
  }

  function initMail() {
    const add = $('#mailAdd');
    if (!add) return;

    add.addEventListener('click', () => {
      const name = ($('#mailName').value || '').trim();
      const addr = ($('#mailAddr').value || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { toast('邮箱地址不对'); return; }
      state.mailboxes = state.mailboxes || [];
      if (state.mailboxes.some((m) => m.addr === addr)) { toast('已经加过了'); return; }
      state.mailboxes.push({ id: uid(), name, addr });
      mailIndex = state.mailboxes.length - 1;
      save(); renderMail();
      $('#mailName').value = ''; $('#mailAddr').value = '';
      toast('邮箱已添加');
    });

    $('#mailSide').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        state.mailboxes = state.mailboxes.filter((m) => m.id !== del.dataset.del);
        mailIndex = 0; save(); renderMail();
        return;
      }
      const row = e.target.closest('[data-i]');
      if (!row) return;
      mailIndex = Number(row.dataset.i);
      renderMail();
    });

    $('#mailDots').addEventListener('click', (e) => {
      const d = e.target.closest('[data-dot]');
      if (!d) return;
      mailIndex = Number(d.dataset.dot);
      renderMail();
    });

    $('#mcCopy').addEventListener('click', async () => {
      if (curOtp) {
        try { await navigator.clipboard.writeText(curOtp); toast('验证码已复制：' + curOtp); }
        catch { toast('复制失败，手动选一下'); }
        return;
      }
      const m = (state.mailboxes || [])[mailIndex];
      if (!m) return;
      try { await navigator.clipboard.writeText(m.addr); toast('地址已复制'); }
      catch { toast('复制失败，手动选一下'); }
    });

    $('#mcOpen').addEventListener('click', () => {
      const m = (state.mailboxes || [])[mailIndex];
      if (!m) { toast('先添加一个邮箱'); return; }
      const url = webmailFor(m.addr);
      if (SHELL && SHELL.open) SHELL.open(url || `mailto:${m.addr}`);
    });
  }

  function initCC() {
    if (!ccEl) return;
    const cap = $('#capsule');
    const armOpen = () => { clearTimeout(ccTimer); ccTimer = setTimeout(openCC, 120); };
    const armClose = (ms) => { clearTimeout(ccTimer); ccTimer = setTimeout(closeCC, ms); };

    cap.addEventListener('pointerenter', armOpen);
    cap.addEventListener('pointerleave', () => { if (ccOpen) armClose(320); });
    cap.addEventListener('click', (e) => { e.preventDefault(); openCC(); });

    ccEl.addEventListener('pointerenter', () => clearTimeout(ccTimer));
    ccEl.addEventListener('pointerleave', () => armClose(260));

    document.addEventListener('pointerdown', (e) => {
      if (!ccOpen) return;
      if (e.target.closest('#cc') || e.target.closest('#capsule')) return;
      closeCC();
    }, true);

    /* 页签：主页 / 消息 / 控制 */
    $('#ccTabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.cc-tab');
      if (!tab) return;
      const pane = tab.dataset.pane;
      $$('.cc-tab', ccEl).forEach((t) => t.classList.toggle('is-on', t === tab));
      $$('.cc-pane', ccEl).forEach((p) => p.classList.toggle('is-on', p.dataset.pane === pane));
    });
    $('#ccGear')?.addEventListener('click', () => { closeCC(); openPanel(); });

    /* 滑杆 */
    $$('.cc-slider', ccEl).forEach((sl) => {
      const track = sl.querySelector('.s-track');
      const fill = sl.querySelector('.s-fill');
      const val = sl.querySelector('.s-val');
      let dragging = false;
      const apply = (clientX) => {
        const r = track.getBoundingClientRect();
        const p = Math.max(2, Math.min(100, Math.round(((clientX - r.left) / r.width) * 100)));
        fill.style.width = `${p}%`;
        val.textContent = String(p);
        if (SHELL && SHELL.setLevel) SHELL.setLevel(sl.dataset.kind, p);
      };
      sl.addEventListener('pointerdown', (e) => { dragging = true; try { sl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ } apply(e.clientX); });
      sl.addEventListener('pointermove', (e) => { if (dragging) apply(e.clientX); });
      sl.addEventListener('pointerup', () => { dragging = false; });
      sl.addEventListener('pointercancel', () => { dragging = false; });
    });

    $('#ccWifi')?.addEventListener('click', () => { if (SHELL?.open) SHELL.open('ms-settings:network-wifi'); });
    $('#ccBt')?.addEventListener('click', () => { if (SHELL?.open) SHELL.open('ms-settings:bluetooth'); });

    renderHome();
    renderMail();
    renderLiveMail();
    initMail();
  }

  /* ---------------------------------------------------------------------- */
  /* 13. 抽屉交互：悬停展开 / 点外收起 / 拖动                                */
  /* ---------------------------------------------------------------------- */
  function initDrawer() {
    const head = $('#drawerHead');
    const capsule = $('#capsule');
    let hoverTimer = 0;

    /* 胶囊：点一下 / 鼠标停一下，抽屉就下来 */
    const armOpen = () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(openDrawer, 140);
    };
    if (capsule) {
      capsule.addEventListener('pointerenter', () => { if (!isOpen) armOpen(); });
      capsule.addEventListener('pointerleave', () => clearTimeout(hoverTimer));
      capsule.addEventListener('click', () => { if (!isOpen) openDrawer(); });
    }

    drawer.addEventListener('pointerenter', () => {
      if (isOpen) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(openDrawer, 160);
    });
    drawer.addEventListener('pointerleave', () => clearTimeout(hoverTimer));

    scrim.addEventListener('pointerdown', () => { if (isOpen) closeDrawer(); });

    /* 拖着抽屉头上下拉动 */
    let g = null;
    const onDown = (e) => {
      if (e.target.closest('button') || e.target.isContentEditable) return;
      if (e.button !== 0) return;
      drawerSpring.running = false;
      g = { sy: e.clientY, start: drawerSpring.value, hist: [], moved: false };
      try { head.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      head.classList.add('is-dragging');
    };
    const onMove = (e) => {
      if (!g) return;
      const dy = e.clientY - g.sy;
      if (!g.moved && Math.abs(dy) < 4) return;
      g.moved = true;
      const lo = closedOffset();
      let ty = g.start + dy;
      if (ty > 0) ty = (ty * 26) / (26 + Math.abs(ty));
      else if (ty < lo) { const over = ty - lo; ty = lo + (over * 26) / (26 + Math.abs(over)); }
      drawerSpring.value = ty;
      paintDrawer(ty);
      g.hist.push({ y: e.clientY, t: performance.now() });
      if (g.hist.length > 6) g.hist.shift();
    };
    const onUp = () => {
      if (!g) return;
      head.classList.remove('is-dragging');
      const lo = closedOffset();
      let v = 0;
      if (g.hist.length > 1) {
        const a = g.hist[0], b = g.hist[g.hist.length - 1];
        const dt = (b.t - a.t) / 1000;
        if (dt > 0.001) v = (b.y - a.y) / dt;
      }
      const projected = drawerSpring.value + project(v);
      if (projected > lo * 0.5) openDrawer(); else closeDrawer(v);
      g = null;
    };
    head.addEventListener('pointerdown', onDown);
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp);
    head.addEventListener('pointercancel', onUp);

    $('#drawerAddSection').addEventListener('click', () => {
      const name = window.prompt('新分区名称', '分区 ' + (state.sections.length + 1));
      if (name == null) return;
      state.sections.push({ id: uid(), name: name.trim() || '未命名', items: [] });
      save(); renderSections();
      const body = $('.drawer-body');
      body.scrollTop = body.scrollHeight;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 14. 设置                                                               */
  /* ---------------------------------------------------------------------- */
  const panel = $('#settingsPanel');
  function openPanel() {
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    if (SHELL && SHELL.setFocusable) SHELL.setFocusable(true);
    scheduleZones();
  }
  function closePanel() {
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    if (SHELL && SHELL.setFocusable) SHELL.setFocusable(false);
    scheduleZones();
  }

  function initSettings() {
    $('#dockStart').addEventListener('click', () => {
      panel.classList.contains('is-open') ? closePanel() : openPanel();
    });
    $('#panelClose').addEventListener('click', closePanel);

    $('#wallSwatches').addEventListener('click', (e) => {
      const b = e.target.closest('.swatch');
      if (!b) return;
      state.wallpaper.preset = b.dataset.preset;
      state.wallpaper.cover = true;
      if (b.dataset.preset === 'custom' && !state.wallpaper.custom) $('#wpFile').click();
      save(); applyWallpaper();
    });
    $('#wallCover').addEventListener('change', (e) => {
      state.wallpaper.cover = e.target.checked;
      save(); applyWallpaper();
    });

    $('#wpFile').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) { toast('图片太大了（上限 8MB）'); return; }
      const fr = new FileReader();
      fr.onload = () => {
        state.wallpaper.custom = String(fr.result);
        state.wallpaper.preset = 'custom';
        state.wallpaper.cover = true;
        $('#wpFileNote').textContent = `已使用：${file.name}`;
        save(); applyWallpaper();
        toast('壁纸已更换');
      };
      fr.readAsDataURL(file);
    });

    $('#clockVisible').addEventListener('change', (e) => {
      state.clock.visible = e.target.checked;
      save(); placeClock(); scheduleZones();
    });
    $('#clockReset').addEventListener('click', () => {
      state.clock.x = null; state.clock.y = null;
      save(); placeClock(); scheduleZones();
      toast('时钟已居中');
    });
    $('#weatherRefresh').addEventListener('click', () => refreshWeather(false));

    $('#dataExport').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `quiet-forest-desk-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    $('#dataImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const next = JSON.parse(String(fr.result));
          if (!next || typeof next !== 'object') throw new Error('bad');
          localStorage.setItem(KEY, JSON.stringify({ ...defaultState(), ...next }));
          location.reload();
        } catch { toast('这个文件读不出来'); }
      };
      fr.readAsText(file);
    });
    $('#dataReset').addEventListener('click', () => {
      if (!window.confirm('恢复默认会清空 Dock 和所有分区（不动桌面文件）。继续？')) return;
      localStorage.removeItem(KEY);
      location.reload();
    });
    $('#appQuit').addEventListener('click', () => { if (SHELL && SHELL.quit) SHELL.quit(); });

    /* 邮箱绑定 */
    const note = $('#mNote');
    if (SHELL && SHELL.mailStatus) {
      SHELL.mailStatus().then((st) => {
        if (!st) return;
        mailData = { ...mailData, bound: st.bound, user: st.user, ...(st.cache || {}) };
        if (st.bound) {
          $('#mHost').value = st.host || '';
          $('#mUser').value = st.user || '';
          note.textContent = `已绑定 ${st.user}，每分钟自动收取。`;
        }
        renderLiveMail();
      });
      SHELL.onMail((d) => { mailData = { ...mailData, ...d }; renderLiveMail(); });
    }
    $('#mBind').addEventListener('click', async () => {
      const cfg = {
        host: $('#mHost').value.trim(),
        port: Number($('#mPort').value) || 993,
        user: $('#mUser').value.trim(),
        pass: $('#mPass').value,
      };
      note.textContent = '正在连接…';
      const r = await SHELL.mailBind(cfg);
      if (r.ok) {
        mailData = { ...mailData, bound: true, user: cfg.user, error: '' };
        note.textContent = `已绑定 ${cfg.user}，收件箱 ${r.count} 封。每分钟自动收。`;
        toast('邮箱绑定成功');
      } else {
        note.textContent = `绑定失败：${r.error}`;
        toast('绑定失败');
      }
    });
    $('#mRefresh').addEventListener('click', async () => {
      const d = await SHELL.mailRefresh();
      mailData = { ...mailData, ...d };
      renderLiveMail();
      toast('已刷新');
    });
    $('#mUnbind').addEventListener('click', async () => {
      await SHELL.mailUnbind();
      mailData = { count: 0, messages: [], error: '', bound: false, user: '' };
      note.textContent = '已解除绑定。';
      renderLiveMail();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 15. toast / keys                                                       */
  /* ---------------------------------------------------------------------- */
  const toastEl = $('#toast');
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2000);
  }

  function initKeys() {
    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if (e.key === 'Escape') {
        if (ccOpen) return closeCC();
        if (!dialogRoot.hidden) return closeDialog();
        if (!pickerRoot.hidden) return closePicker();
        if (panel.classList.contains('is-open')) return closePanel();
        if (!$('#ctx').hidden) return closeCtx();
        if (isOpen) return closeDrawer();
        return;
      }
      if (typing) return;
      if (e.code === 'Space' && !typing) {
        e.preventDefault();
        isOpen ? closeDrawer() : openDrawer();
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 16. boot                                                               */
  /* ---------------------------------------------------------------------- */
  async function refreshIcons() {
    const changed = await ensureLinks();
    if (changed) { renderDock(); renderSections(); }
  }

  async function seedFromDesktop() {
    if (state.seeded || state.dock.length || !SHELL?.listDesktop) return;
    state.seeded = true;
    try {
      const items = await SHELL.listDesktop();
      state.dock = items.slice(0, 7).map((it) => ({ id: uid(), path: it.path, name: it.name }));
      save(); renderDock();
      refreshIcons();
    } catch { /* 忽略 */ }
  }

  function boot() {
    buildForest();
    applyWallpaper();

    if (OVERLAY && SHELL) {
      $('#appQuit').hidden = false;
      initOverlay();
    }

    renderSections();
    renderDock();
    initClock();
    initDrawer();
    initItemEvents();
    initDrop();
    initCtx();
    initDialog();
    initPicker();
    initApps();
    initCC();
    initSettings();
    initKeys();

    drawerH = drawer.offsetHeight || 0;
    drawerSpring.jump(closedOffset());
    paintDrawer(closedOffset());

    seedFromDesktop();
    refreshIcons();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
