# hermes-pdf-reader

Hermes 桌面应用的媒体查看器插件：**看图 + 看 PDF**，单文件、零运行时依赖。

## 功能

- 标题栏「PDF」按钮：开关停靠在对话右侧的媒体查看器面板（与文件树侧边栏互相独立）。
- **图片页**：点击对话里的图片不再弹灯箱，直接进面板查看；`‹ ›` 按钮或键盘 `← / →` 在对话内已加载的图片之间循环切换，带 `3 / 7` 位置计数。
- **PDF 页**：输入目录路径浏览本地 PDF，应用内直接渲染（Electron PDFium），打开文件后自动收起目录、阅读区占满面板；支持「外部打开」跳转系统文件管理器。
- 两个页签随时互切：看书途中点一张对话图片会自动跳到图片页，看完再切回 PDF。
- **按 bot 会话隔离**：每个 bot 会话有自己的一份查看器状态（打开的 PDF、图片列表、页签）；切到别的 bot 面板收起，切回来原样恢复。

## 安装

1. 把 `plugin.js` 复制到 `<hermes home>/desktop-plugins/pdf-reader/plugin.js`（文件夹名必须等于插件 id `pdf-reader`）。
   Windows 上 `<hermes home>` 通常是 `%LOCALAPPDATA%\hermes`。
2. 在 Hermes 桌面应用按 `Ctrl+K` → **Reload desktop plugins**（或重启应用）。

## 已知限制

- 对话列表是虚拟滚动：太早滚出屏幕的图片可能不在切换列表里；点到列表外的图片会自动补进列表。
- 对话里部分图片内嵌的是缩略图，面板里显示的清晰度可能略低于原图。

## License

MIT — 详见 [LICENSE](./LICENSE)。插件由 Hermes 的「修hermes机器人」生成。
