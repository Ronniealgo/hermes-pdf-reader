## v1.0.0 — 首个公开版本

Hermes 桌面应用的媒体查看器插件（看图 + 看 PDF），单文件、零运行时依赖。

### 功能

- 标题栏「PDF」按钮开关右侧媒体查看器面板
- 图片页：点击对话图片不再弹灯箱、直接进面板；`‹ ›` 按钮与键盘 `← / →` 循环切换对话内已加载的图片（带 `n / N` 计数）
- PDF 页：目录浏览本地 PDF、应用内直接渲染（Electron PDFium）、打开后自动收起目录、支持外部打开
- 图片 / PDF 页签随时互切

### 安装

复制 `plugin.js` 到 `<hermes home>/desktop-plugins/pdf-reader/plugin.js`，然后 `Ctrl+K` → Reload desktop plugins。
