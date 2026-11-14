# 静林桌面 · QuietForestDesk

一个 Windows 桌面部件壳（Electron）。把 **灵动岛**、**Nexus 风格 Dock**、**桌面时钟** 三样东西贴在桌面上，
不遮挡任何应用窗口，所有内容都在桌面层。

![icon](app/icon.png)

## 功能

### 灵动岛
- 顶部居中胶囊，悬停 **1.3 秒**或单击展开
- 展开后是毛玻璃面板，分 **主页 / 设置** 两个页签
- 主页：大时间、日期、电量、网络、蓝牙状态 + 消息列表（支持一键清空）
- 设置：亮度、音量滑块；飞行模式 / WiFi / 蓝牙开关（直接调系统接口，不跳设置页）
- 可拖动到任意位置，位置记忆在 localStorage

### Dock
- 底部居中，图标悬停放大（Nexus 式）
- **悬停 ⊞ 向上展开应用面板**，列出 Dock + 桌面全部软件和文件（含文件夹）
- **单击 ⊞ 打开设置**
- **拖动图标可排序**（按住 5px 后进入拖拽，松手落位）
- **右键图标**：打开 / 打开文件所在位置 / 移出 Dock
- **右键 Dock 空白处**：选择文件加入 Dock（支持 .lnk / .exe / .url / .bat）
- 拖文件到 Dock 时会插入虚线占位块，图标向两边让开

### 时钟
- 屏幕居中，走字、日期、天气占位信息
- 位置可拖动并记忆

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

产物在 `dist/`（NSIS 安装包）。图标取自 `app/icon.ico`。

## 目录结构

```
main.js           主进程：窗口、托盘、IPC（图标 / 截图 / 亮度 / 音量 / 无线开关 / 桌面清单）
preload.js        contextBridge 暴露给页面的能力白名单
app/index.html    页面结构
app/app.js        渲染进程：时钟、Dock、灵动岛、启动器、设置
app/styles.css    全部样式
app/icon.*        应用图标
```

## 实现要点

- **桌面层窗口**：`transparent + frame:false + skipTaskbar`，全屏覆盖层；空白区域鼠标穿透，
  只有指针落在部件上时通过 `setIgnoreMouseEvents(false)` 接管鼠标，靠主进程 60ms 轮询热区实现。
- **永不遮挡应用**：窗口默认 `focusable:false` + `showInactive()`，不会被激活也不会被抬到最前。
- **图标获取**：`app.getFileIcon` → `.lnk` 解析目标（`shell.readShortcutLink` + 二进制扫描兜底）→ 失败则画字母徽章。
- **毛玻璃**：展开瞬间用 `desktopCapturer` 抓一帧背景并缓存，不做轮询（早期版本每秒 4~5 次全屏截图，CPU 3.9%）；
  动画全部走 transform / opacity，静止时无动画。
- **亮度**：WMI `WmiMonitorBrightnessMethods`；**音量**：`SendKeys {VOLUME_UP/DOWN}`；
  **WiFi / 蓝牙**：`Enable/Disable-NetAdapter`、`Enable/Disable-PnpDevice`（需要管理员权限）。

## 已知限制

- WiFi / 蓝牙开关需要以管理员身份运行，否则会提示权限不足
- 音量无法读取系统当前值，滑块是相对调节（每格 2%）
- 从桌面**拖放**文件到 Dock 依赖 Windows 对非激活窗口的拖放投递，部分环境下不生效，可用右键菜单替代

## License

MIT
