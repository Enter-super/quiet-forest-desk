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
app/index.html    页面结构
app/app.js        渲染进程：胶囊、控制中心、Dock、设置
app/styles.css    全部样式
app/icon.*        应用图标
```

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

## License

MIT
