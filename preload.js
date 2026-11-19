/* 预加载：只暴露必要能力，页面拿不到 Node。 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const params = new URLSearchParams(window.location.search);

contextBridge.exposeInMainWorld('desktopShell', {
  overlay: params.has('overlay'),

  /* 该接管鼠标的矩形；full=true 表示整屏接管 */
  setZones(zones, full) {
    ipcRenderer.send('overlay:zones', zones, !!full);
  },

  /* 打开设置/弹窗时临时允许聚焦，否则输入框打不了字 */
  setFocusable(on) {
    ipcRenderer.send('app:focusable', !!on);
  },

  open(target) {
    return ipcRenderer.invoke('shell:open', target);
  },

  icon(target) {
    return ipcRenderer.invoke('shell:icon', target);
  },

  resolveLinks(paths) {
    return ipcRenderer.invoke('shell:resolveLinks', paths);
  },

  contextMenu(target) {
    return ipcRenderer.invoke('shell:menu', target);
  },

  listDesktop() {
    return ipcRenderer.invoke('shell:listDesktop');
  },

  listPlaces() {
    return ipcRenderer.invoke('shell:listPlaces');
  },

  /* 从桌面拖进来的文件，拿它的真实路径 */
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  openHome() { return ipcRenderer.invoke('shell:open', 'HOME'); },
  openDownloads() { return ipcRenderer.invoke('shell:open', 'DOWNLOADS'); },

  sysPaths() { return ipcRenderer.invoke('sys:paths'); },

  mailStatus() { return ipcRenderer.invoke('mail:status'); },
  mailBind(cfg) { return ipcRenderer.invoke('mail:bind', cfg); },
  mailUnbind() { return ipcRenderer.invoke('mail:unbind'); },
  mailRefresh() { return ipcRenderer.invoke('mail:refresh'); },
  onMail(cb) { ipcRenderer.on('mail:update', (_e, d) => cb(d)); },

  netInfo() { return ipcRenderer.invoke('sys:net'); },
  setLevel(kind, value) { ipcRenderer.send('sys:level', kind, value); },
  stats() { return ipcRenderer.invoke('sys:stats'); },
  display() { return ipcRenderer.invoke('sys:display'); },
  media() { return ipcRenderer.invoke('sys:media'); },
  memTop() { return ipcRenderer.invoke('sys:memtop'); },
  mediaCtl(action) { ipcRenderer.send('media:ctl', action); },
  closeSidebar() { ipcRenderer.send('sidebar:close'); },
  openMail(seq) { ipcRenderer.send('mail:open', seq); },
  closeMail() { ipcRenderer.send('mail:close'); },
  mailBody(seq) { return ipcRenderer.invoke('mail:body', seq); },
  mailHeight(h) { ipcRenderer.send('mail:height', h); },
  onMailShow(cb) { ipcRenderer.on('mail:show', (_e, seq) => cb(seq)); },
  sidebarHeight(h) { ipcRenderer.send('sidebar:height', h); },
  getLevel() { return ipcRenderer.invoke('sys:getLevel'); },
  pickApps() { return ipcRenderer.invoke('dialog:pickApps'); },
  capsuleSize(open) { ipcRenderer.send('capsule:size', !!open); },

  quit() { ipcRenderer.send('app:quit'); },
  setAlwaysOnTop(on) { ipcRenderer.send('app:setTop', !!on); },
});
