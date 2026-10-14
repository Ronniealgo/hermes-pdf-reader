/**
 * pdf-reader — Hermes 桌面应用的通用媒体查看器。
 * 安装位置: <hermes home>/desktop-plugins/pdf-reader/plugin.js （文件夹名 == id）
 *
 * 交互:
 *  - 应用右上角标题栏有独立的「PDF」按钮，点击开/关查看器面板
 *    （面板停靠在对话右侧，与文件树侧边栏的开关完全独立）。
 *  - 点击对话里的图片 → 自动在右侧面板的「图片」页打开（不再弹灯箱）。
 *  - 「PDF」页：目录浏览 + 应用内渲染（Electron PDFium）。
 *
 * 渲染路线:
 *  - PDF:  window.hermesDesktop.readFileDataUrl → Blob(application/pdf)
 *          → URL.createObjectURL → <embed type="application/pdf">
 *  - 图片: 捕获阶段拦截 [data-slot="aui_zoomable-image"] 的点击，
 *          取 img.currentSrc 直接展示。
 *
 * 由 修hermes机器人 生成。
 */
import { host, useValue } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'pdf-reader'
const PANE_ID = ID + ':pane' // 贡献作用域化的面板 id: <pluginId>:<paneId>

// ── 面板注册状态（register() 时注入 ctx，按钮回调读写）──
let pluginCtx = null
let paneDisposer = null
let paneRegistered = false

const PANE_CONTRIBUTION = {
  id: 'pane',
  area: 'panes',
  title: '媒体查看器',
  data: {
    placement: 'right',
    collapsible: true,
    // 停靠在对话（workspace）右缘 —— 自己的独立区域，不进文件树所在的侧边栏
    dock: { pane: 'workspace', pos: 'right' },
    revealAliases: ['pdf-reader'],
    width: '560px',
    minWidth: '360px'
  },
  render: () => jsx(PdfReaderPane, {})
}

function openPane() {
  if (!pluginCtx || paneRegistered) return
  paneDisposer = pluginCtx.register(PANE_CONTRIBUTION)
  paneRegistered = true
  try {
    // 清掉历史 Close 记录并把面板带到前台（旧桌面无此 API 则跳过）
    if (typeof host.undismissPane === 'function') host.undismissPane(PANE_ID)
    if (typeof host.revealPane === 'function') host.revealPane(PANE_ID)
  } catch (e) {
    /* 显示失败不致命：面板已注册，布局里可见 */
  }
}

function closePane() {
  if (!paneRegistered) return
  try {
    if (typeof paneDisposer === 'function') paneDisposer()
  } catch (e) {
    /* 忽略 */
  }
  paneDisposer = null
  paneRegistered = false
}

// ── 媒体状态（图片/PDF 两个页签；模块级小 pub/sub，不引外部依赖）──
let mediaTab = 'pdf' // 'pdf' | 'image'
let imageState = { src: '', alt: '', list: [], index: -1 }
const mediaListeners = new Set()
const subscribeMedia = cb => {
  mediaListeners.add(cb)
  return () => mediaListeners.delete(cb)
}
const notifyMedia = () => mediaListeners.forEach(f => {
  try {
    f()
  } catch (e) {
    /* 订阅者异常不互相影响 */
  }
})
function setMediaTab(t) {
  if (mediaTab !== t) {
    mediaTab = t
    notifyMedia()
  }
}
function collectChatImages() {
  const out = []
  document.querySelectorAll('[data-slot="aui_zoomable-image"] img').forEach(img => {
    const src = img.currentSrc || img.getAttribute('src') || img.src || ''
    if (src) out.push({ src, alt: img.alt || '' })
  })
  return out
}

function showImage(src, alt) {
  const list = collectChatImages()
  let index = list.findIndex(item => item.src === src)
  if (index < 0) {
    // 点到的图不在已收集列表里（例如被虚拟滚动丢掉）：补进去
    list.push({ src: String(src || ''), alt: String(alt || '') })
    index = list.length - 1
  }
  showAt(index, list)
}

function showAt(index, list) {
  const arr = list || imageState.list || []
  if (!arr.length) return
  const n = ((index % arr.length) + arr.length) % arr.length // 循环
  imageState = { src: arr[n].src, alt: arr[n].alt, list: arr, index: n }
  mediaTab = 'image'
  openPane() // 面板没开就自动打开
  notifyMedia()
}

function stepImage(delta) {
  if (mediaTab !== 'image' || !imageState.list || !imageState.list.length) return
  showAt(imageState.index + delta, imageState.list)
}

// ── 拦截对话图片点击 ──
// ZoomableImage 的灯箱由 React 在根容器委托的 click 处理；document 捕获阶段
// 先于它执行，stopPropagation 即可阻止灯箱，把图片转进本面板。
function interceptChatImageClicks(ctx) {
  const onCapture = e => {
    const el = e.target instanceof Element ? e.target : null
    if (!el || typeof el.closest !== 'function') return
    const wrap = el.closest('[data-slot="aui_zoomable-image"]')
    if (!wrap) return
    const img = wrap.querySelector('img')
    const src = img ? img.currentSrc || img.getAttribute('src') || img.src || '' : ''
    if (!src) return
    e.stopPropagation()
    e.preventDefault()
    showImage(src, img ? img.alt || '' : '')
  }
  document.addEventListener('click', onCapture, true)
  // 键盘 ←/→ 在图片页切换上/下一张（输入框里不抢键）
  const onKey = e => {
    if (!paneRegistered || mediaTab !== 'image') return
    const t = e.target
    if (t instanceof Element && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    stepImage(e.key === 'ArrowLeft' ? -1 : 1)
  }
  document.addEventListener('keydown', onKey, true)
  if (typeof ctx.onDispose === 'function') {
    ctx.onDispose(() => {
      document.removeEventListener('click', onCapture, true)
      document.removeEventListener('keydown', onKey, true)
    })
  }
}

// ── 页签栏 ──
function ViewTabs() {
  const tab = useSyncExternalStore(subscribeMedia, () => mediaTab)
  const mkBtn = (key, label) =>
    jsx(
      'button',
      {
        className:
          'rounded px-2 py-0.5 text-xs ' +
          (tab === key
            ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
            : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'),
        type: 'button',
        onClick: () => setMediaTab(key),
        children: label
      },
      key
    )
  return jsxs('div', {
    className: 'flex items-center gap-1',
    children: [mkBtn('image', '图片'), mkBtn('pdf', 'PDF')]
  })
}

// ── 右上角标题栏按钮 ──
// 样式对齐应用内置 titlebar 图标按钮（titlebarButtonClass + icon-titlebar 尺寸）
function PdfTitlebarButton() {
  let visible = paneRegistered
  if (typeof host.paneVisibility === 'function') {
    const $v = host.paneVisibility(PANE_ID)
    if ($v && typeof $v.get === 'function') visible = useValue($v)
  }

  return jsx('button', {
    type: 'button',
    'aria-label': '媒体查看器',
    'aria-pressed': visible,
    title: visible ? '关闭媒体查看器' : '打开媒体查看器',
    className:
      'flex h-(--titlebar-control-height) w-(--titlebar-control-size) items-center justify-center rounded-[4px] text-[10px] font-medium tracking-wide select-none ' +
      (visible
        ? 'bg-(--ui-control-hover-background) text-foreground'
        : 'text-muted-foreground/85 hover:bg-(--ui-control-hover-background) hover:text-foreground'),
    onClick: () => {
      if (paneRegistered) closePane()
      else openPane()
    },
    children: 'PDF'
  })
}

function dirUp(p) {
  const norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const i = norm.lastIndexOf('/')
  return i > 2 ? norm.slice(0, i) : norm
}

// ── 面板主体 ──
function PdfReaderPane() {
  const tab = useSyncExternalStore(subscribeMedia, () => mediaTab)
  const img = useSyncExternalStore(subscribeMedia, () => imageState)

  const [dir, setDir] = useState('C:/Users/a/Desktop/物理光学')
  const [dirInput, setDirInput] = useState('C:/Users/a/Desktop/物理光学')
  const [entries, setEntries] = useState([])
  const [selected, setSelected] = useState(null) // {name, path}
  const [blobUrl, setBlobUrl] = useState('')
  const [status, setStatus] = useState('正在读取目录…')
  const [listOpen, setListOpen] = useState(true)
  const blobRef = useRef('')

  const loadDir = useCallback(async d => {
    setStatus('正在读取目录…')
    setEntries([])
    try {
      const desktop = window.hermesDesktop
      if (!desktop || !desktop.readDir) {
        setStatus('桌面桥不可用：请在 Hermes 桌面应用中使用本面板')
        return
      }
      const res = await desktop.readDir(d)
      if (res && res.error) {
        setStatus('目录读取失败：' + res.error)
        return
      }
      const all = (res && res.entries) || []
      const dirs = all.filter(e => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name))
      const pdfs = all.filter(e => !e.isDirectory && /\.pdf$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))
      setEntries([...dirs, ...pdfs])
      setStatus(pdfs.length ? '' : '此目录下没有 PDF 文件')
    } catch (e) {
      setStatus('目录读取失败：' + ((e && e.message) || String(e)))
    }
  }, [])

  useEffect(() => {
    loadDir(dir)
  }, [dir, loadDir])

  // 面板卸载时释放 blob
  useEffect(
    () => () => {
      if (blobRef.current) {
        URL.revokeObjectURL(blobRef.current)
        blobRef.current = ''
      }
    },
    []
  )

  const openFile = useCallback(async entry => {
    setStatus('正在加载 ' + entry.name + ' …')
    try {
      const desktop = window.hermesDesktop
      if (!desktop || !desktop.readFileDataUrl) {
        setStatus('桌面桥不可用：请在 Hermes 桌面应用中使用本面板')
        return
      }
      const res = await desktop.readFileDataUrl(entry.path)
      if (!res || typeof res !== 'string') {
        setStatus('文件读取失败：' + ((res && (res.message || res.error)) || '未知错误'))
        return
      }
      const bytes = await (await fetch(res)).arrayBuffer()
      const blob = new Blob([bytes], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      if (blobRef.current) URL.revokeObjectURL(blobRef.current)
      blobRef.current = url
      setBlobUrl(url)
      setSelected(entry)
      setStatus('')
      setListOpen(false) // 打开 PDF 后自动收起目录，阅读区占满面板
    } catch (e) {
      setStatus('打开失败：' + ((e && e.message) || String(e)))
    }
  }, [])

  const openExternal = useCallback(() => {
    const desktop = window.hermesDesktop
    if (!selected || !desktop) return
    if (typeof desktop.showItemInFolder === 'function') {
      desktop.showItemInFolder(selected.path)
    } else if (typeof desktop.openExternal === 'function') {
      desktop.openExternal('file:///' + String(selected.path).replace(/\\/g, '/'))
    }
  }, [selected])

  const submitDir = useCallback(() => {
    const next = String(dirInput || '').trim()
    if (next && next !== dir) setDir(next)
  }, [dirInput, dir])

  const showImage = tab === 'image' && !!img.src

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-2 text-sm',
    children: [
      jsx(ViewTabs, {}),
      ...(showImage
        ? [
            // ── 图片页：对话里点开的图片 ──
            jsxs('div', {
              className: 'flex min-h-0 flex-1 flex-col gap-1',
              children: [
                jsxs('div', {
                  className: 'flex items-center gap-1.5',
                  children: [
                    jsx('button', {
                      className:
                        'rounded px-1.5 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary) disabled:opacity-40',
                      type: 'button',
                      onClick: () => stepImage(-1),
                      disabled: !img.list || img.list.length < 2,
                      title: '上一张（←）',
                      children: '‹'
                    }),
                    jsx('div', {
                      className: 'shrink-0 text-xs text-(--ui-text-tertiary)',
                      children: img.list && img.list.length ? img.index + 1 + ' / ' + img.list.length : ''
                    }),
                    jsx('button', {
                      className:
                        'rounded px-1.5 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary) disabled:opacity-40',
                      type: 'button',
                      onClick: () => stepImage(1),
                      disabled: !img.list || img.list.length < 2,
                      title: '下一张（→）',
                      children: '›'
                    }),
                    jsx('div', {
                      className: 'min-w-0 flex-1 truncate text-xs text-(--ui-text-tertiary)',
                      title: img.src,
                      children: img.alt || '对话图片'
                    })
                  ]
                }),
                jsx('div', {
                  className:
                    'min-h-0 flex-1 overflow-auto rounded border border-(--ui-stroke-secondary)',
                  children: jsx('img', {
                    className: 'mx-auto block max-h-full max-w-full object-contain',
                    src: img.src,
                    alt: img.alt || '',
                    draggable: false
                  })
                })
              ]
            }, 'image-view')
          ]
        : [
            // ── PDF 页：目录浏览 + 阅读区 ──
            jsxs('div', {
              className: 'flex items-center gap-1.5',
              children: [
                jsx('input', {
                  className:
                    'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs text-(--ui-text-secondary)',
                  type: 'text',
                  value: dirInput,
                  spellCheck: false,
                  onChange: e => setDirInput(e.target.value),
                  onKeyDown: e => {
                    if (e.key === 'Enter') submitDir()
                  },
                  title: '目录路径，回车打开'
                }),
                jsx('button', {
                  className:
                    'rounded px-2 py-1 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)',
                  type: 'button',
                  onClick: submitDir,
                  children: '打开'
                }),
                jsx('button', {
                  className:
                    'rounded px-2 py-1 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)',
                  type: 'button',
                  onClick: () => {
                    const up = dirUp(dir)
                    setDir(up)
                    setDirInput(up)
                  },
                  title: '上级目录',
                  children: '↑'
                })
              ]
            }),
            jsxs('div', {
              className: 'flex min-h-0 flex-1 gap-2',
              children: [
                listOpen
                  ? jsx('div', {
                      className:
                        'w-44 shrink-0 overflow-y-auto rounded border border-(--ui-stroke-secondary) p-1',
                      children: entries.map(e =>
                        jsx(
                          'button',
                          {
                            className:
                              'block w-full truncate rounded px-1.5 py-1 text-left text-xs ' +
                              (e.isDirectory
                                ? 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
                                : selected && selected.path === e.path
                                  ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
                                  : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)'),
                            type: 'button',
                            title: e.path,
                            onClick: () => {
                              if (e.isDirectory) {
                                setDir(e.path)
                                setDirInput(e.path)
                              } else {
                                openFile(e)
                              }
                            },
                            children: (e.isDirectory ? '📁 ' : '') + e.name
                          },
                          e.path
                        )
                      )
                    })
                  : null,
                jsxs('div', {
                  className: 'flex min-w-0 flex-1 flex-col gap-1',
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-1.5',
                      children: [
                        jsx('div', {
                          className: 'min-w-0 flex-1 truncate text-xs text-(--ui-text-tertiary)',
                          title: selected ? selected.path : '',
                          children: selected
                            ? selected.name
                            : listOpen
                              ? '从左侧选择一个 PDF'
                              : '点击「显示目录」选择 PDF'
                        }),
                        jsx('button', {
                          className:
                            'rounded px-2 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)',
                          type: 'button',
                          onClick: () => setListOpen(v => !v),
                          title: listOpen ? '隐藏目录列表' : '显示目录列表',
                          children: listOpen ? '⇥ 隐藏目录' : '⇤ 显示目录'
                        }),
                        selected
                          ? jsx('button', {
                              className:
                                'rounded px-2 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)',
                              type: 'button',
                              onClick: openExternal,
                              title: '在系统中打开',
                              children: '外部打开'
                            })
                          : null
                      ]
                    }),
                    jsxs('div', {
                      className:
                        'min-h-0 flex-1 overflow-hidden rounded border border-(--ui-stroke-secondary)',
                      children: [
                        blobUrl
                          ? jsx('embed', {
                              className: 'h-full w-full',
                              type: 'application/pdf',
                              src: blobUrl
                            })
                          : jsx('div', {
                              className:
                                'flex h-full items-center justify-center p-4 text-center text-xs text-(--ui-text-tertiary)',
                              children: status || '未打开文件'
                            })
                      ]
                    })
                  ]
                })
              ]
            }),
            status && blobUrl
              ? jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: status })
              : null
          ])
    ]
  })
}

export default {
  id: ID,
  name: '媒体查看器',
  register(ctx) {
    pluginCtx = ctx

    // 右上角标题栏按钮（固定 chrome 槽位，渲染在内置按钮之后 = 最右上角）
    ctx.register({
      id: 'titlebar-toggle',
      area: 'titleBar.right',
      render: () => jsx(PdfTitlebarButton, {})
    })

    // 拦截对话图片点击 → 送进面板「图片」页
    interceptChatImageClicks(ctx)

    // 注意：面板【不】在加载时注册 —— 由右上角按钮或图片点击按需开/关
  }
}
