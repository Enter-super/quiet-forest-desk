# 静林桌面 · QuietForestDesk

Windows 桌面部件壳（Electron）。把 **顶部胶囊**、**底部 Dock**、**控制中心** 贴在桌面层，
不遮挡任何应用窗口。

![icon](app/icon.png)

## 结构

- **顶部胶囊**：时间 + 天气 + 电量；悬停/点击展开控制中心
- **控制中心**：两个页签（主页 / 设置），亮度与音量滑块、无线开关卡片、消息区
- **底部 Dock**：应用图标（悬停放大），左侧 ⊞ 展开应用面板
- **设置面板 / 添加对话框**：从桌面多选的 picker

## 运行

```bash
npm install
npm start
```

需要 Node.js 18+ 与 Windows 10/11。

## 打包

```bash
npm run dist
```

产物在 `dist/`（NSIS 安装包），图标取自 `app/icon.ico`。

## 目录结构

```
main.js           主进程：窗口、托盘、鼠标热区、图标/系统能力 IPC
preload.js        contextBridge 白名单
mailer.js         邮件相关模块
vol.ps1           音量键发送（keybd_event，绕过 SendKeys 不支持 VOLUME_* 的限制）
app/index.html    页面结构
app/app.js        渲染进程：胶囊、控制中心、Dock、设置
app/styles.css    全部样式
app/icon.*        应用图标
```

## 侧边栏（Alt + Q）

全局快捷键 `Alt + Q`（`globalShortcut`）呼出屏幕右侧的液态玻璃面板，再次按下或 Esc 收起。

| 模块 | 数据来源 |
|---|---|
| 时钟 / 日期 | 本地时间 |
| 天气 | `https://wttr.in/?format=j1&lang=zh` + 中文描述词典 |
| CPU | `os.cpus()` 两次时间差 |
| 内存 | `os.totalmem() - os.freemem()` |
| GPU | `nvidia-smi --query-gpu=utilization.gpu` |
| 显存 | 同上一条命令的 `memory.used,memory.total`（MiB） |
| 网络 | `net.ps1`：`Get-NetAdapterStatistics` 接收字节增量 |
| 正在播放 | `media.ps1`：WinRT `GlobalSystemMediaTransportControlsSessionManager` |
| 待办 | `localStorage` |

播放控制（上一首 / 暂停 / 下一首）由 `mediactl.ps1` 发系统媒体键 `VK_MEDIA_*`。

> PowerShell 脚本开头都设了 `[Console]::OutputEncoding = UTF8`，否则中文标题经管道传到 Node 会变成乱码。

窗口是 `transparent + 自绘渐变`；曾试过 `backgroundMaterial: 'acrylic'`，但它会把整个矩形窗口涂色，圆角外侧露出浅灰方块，因此去掉。

## 鼠标穿透是怎么做的

整屏覆盖层默认 `setIgnoreMouseEvents(true)`，鼠标事件直接落到桌面；
渲染进程把「需要接管的矩形」通过 `overlay:zones` 上报，主进程每 60ms 读一次真实光标位置做命中检测，
命中就把整层切成可点击，离开再切回穿透。

## 已知修复：桌面右键失效

`applyIgnore()` 里原来有这一行：

```js
if (ignore === ignoreMouse) return;   // 状态没变就跳过
```

一旦 Windows 侧的真实状态被 `setFocusable` / `focus` / 置顶等调用改动过，
内部变量 `ignoreMouse` 仍记着旧值，两边永久不一致 —— 之后 `setIgnoreMouseEvents(true)` 再也不会被调用，
覆盖层一直吞掉鼠标：**桌面图标点不动、右键没有菜单、拖放失效**。

现在改为「要恢复穿透时强制下发」：

```js
if (ignore === ignoreMouse && ignore !== true) return;
try { win.setIgnoreMouseEvents(ignore, { forward: true }); } catch {}
```

60ms 的轮询会不断把状态纠回正确值，即使中途被别人改掉，最多 60 毫秒自愈。

## 已知修复：控制中心亮度 / 音量无效

这版原来的 `sys:level` 只处理了 `bri`，`vol` 直接被丢弃；而亮度那条走的是
`spawn(..., { detached: true, stdio: 'ignore' })`，失败也没有任何反馈。

现在：
- 亮度：`execFile` 调 WMI `WmiSetBrightness`，拿回 stdout/stderr 并写入 `%TEMP%\qfd-level.log`
- 音量：`SendKeys` 不支持 `{VOLUME_UP}/{VOLUME_DOWN}`（会抛 ArgumentException），
  改用 `vol.ps1` 里的 `keybd_event` 发 `VK_VOLUME_UP(0xAF)` / `VK_VOLUME_DOWN(0xAE)`，
  滑块每格 2%

## 已知修复：IMAP 连接超时

原实现在 `sock.on('connect')`（TCP 已连、TLS 未完成）就写 `LOGIN`，数据被丢弃；
服务器随后只发了问候语 `* OK`，客户端却一直在等 `A1 OK`，20 秒后报「连接 IMAP 超时」。

IMAP 规定必须**先读到服务器问候语**才能发命令，现改为：

```js
if (stage === 0) {
  if (/^\* (OK|PREAUTH)/m.test(text)) {
    curTag = send(`LOGIN "..." "..."`);
    stage = 1;
  }
  return;
}
```

实测：20 秒超时 → 515 毫秒拿到服务器真实回应。

## 验证码识别

`消息` 页会从最近几封邮件里找验证码，命中才显示；没有命中时卡片显示当前邮箱，不出现验证码区域。

识别条件是「关键词 + 数字」双条件，避免 GitHub 通知里的日期/编号被误判：

```js
const OTP_KEY = /(验证码|校验码|动态码|确认码|激活码|安全码|登录码|绑定码|口令|验证|认证|verification code|verify|passcode|otp|code)/i;
hits = subject.match(/(?<!\d)(\d{4,8})(?!\d)/g);
return hits[hits.length - 1];
```

单独的「验证」是必须的 —— 像 `iTab邮箱验证提醒153402` 这种标题里并没有「验证码」三个字。

## License

MIT
