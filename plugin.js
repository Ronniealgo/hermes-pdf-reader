/**
 * pdf-reader — Hermes 桌面应用的通用媒体查看器（按 bot 会话隔离）。
 * 安装位置: <hermes home>/desktop-plugins/pdf-reader/plugin.js （文件夹名 == id）
 *
 * 交互:
 *  - 应用右上角标题栏有独立的「PDF」按钮，点击开/关查看器面板
 *    （面板停靠在对话右侧，与文件树侧边栏的开关完全独立）。
 *  - 点击对话里的图片 → 自动在右侧面板「图片」页打开（不再弹灯箱），
 *    ‹ › / ← → 在对话内的图片间循环切换。
 *  - 「PDF」页：目录浏览 + 应用内渲染（Electron PDFium）。
 *  - 每个bot会话有自己的一份查看器状态（打开的PDF、图片列表、页签…）：
 *    切到别的bot时面板收起，回到原bot时原样恢复。
 *
 * 由 修hermes机器人 生成。
 */
import { host, useValue } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'pdf-reader'
const PANE_ID = ID + ':pane' // 贡献作用域化的面板 id: <pluginId>:<paneId>
const DEFAULT_DIR = 'C:/Users/a/Desktop/物理光学'

// ── 面板注册状态（register() 时注入 ctx）──
let pluginCtx = null
let paneDisposer = null
let paneRegistered = false

// ── 会话作用域的查看器状态 ──
const sessionStates = new Map() // sessionKey -> state
let activeKey = null

// 模块级小 pub/sub：任何状态变化 → version++ → 订阅的组件重渲染
let version = 0
const storeListeners = new Set()
const subscribeStore = cb => {
  storeListeners.add(cb)
  return () => storeListeners.delete(cb)
}
function emit() {
  version++
  storeListeners.forEach(f => {
    try {
      f()
    } catch (e) {
      /* 订阅者异常不互相影响 */
    }
  })
}

function getSessionState(key) {
  if (!sessionStates.has(key)) {
    sessionStates.set(key, {
      open: false, // 该会话离开时面板是否开着（回来时据此恢复）
      tab: 'pdf', // 'pdf' | 'image'
      dir: DEFAULT_DIR,
      dirInput: DEFAULT_DIR,
      entries: [],
      selected: null, // {name, path}
      blobUrl: '',
      status: '正在读取目录…',
      listOpen: true,
      image: { src: '', alt: '', list: [], index: -1 }
    })
  }
  return sessionStates.get(key)
}

function onSessionChanged(key) {
  if (!key || key === activeKey) return
  activeKey = key
  const s = getSessionState(key)
  if (s.open) openPane()
  else closePane()
  emit() // PdfReaderPane 以 activeKey 为 React key → 换会话即重挂载，读新状态
}

// ── 面板注册/注销 ──
function openPane() {
  if (!pluginCtx || paneRegistered) return
  paneDisposer = pluginCtx.register(PANE_CONTRIBUTION)
  paneRegistered = true
  if (activeKey) getSessionState(activeKey).open = true
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
  if (activeKey) getSessionState(activeKey).open = false
}

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

// ── 图片：收集/切换（作用到当前会话）──
function collectChatImages() {
  const out = []
  document.querySelectorAll('[data-slot="aui_zoomable-image"] img').forEach(img => {
    const src = img.currentSrc || img.getAttribute('src') || img.src || ''
    if (src) out.push({ src, alt: img.alt || '' })
  })
  return out
}

function showImage(src, alt) {
  const s = getSessionState(activeKey || 'default')
  const list = collectChatImages()
  let index = list.findIndex(item => item.src === src)
  if (index < 0) {
    // 点到的图不在已收集列表里（例如被虚拟滚动丢掉）：补进去
    list.push({ src: String(src || ''), alt: String(alt || '') })
    index = list.length - 1
  }
  showAt(index, list, s)
}

function showAt(index, list, sArg) {
  const s = sArg || getSessionState(activeKey || 'default')
  const arr = list || (s.image && s.image.list) || []
  if (!arr.length) return
  const n = ((index % arr.length) + arr.length) % arr.length // 循环
  s.image = { src: arr[n].src, alt: arr[n].alt, list: arr, index: n }
  s.tab = 'image'
  openPane() // 面板没开就自动打开
  emit()
}

function stepImage(delta) {
  const s = getSessionState(activeKey || 'default')
  if (s.tab !== 'image' || !s.image.list || !s.image.list.length) return
  showAt(s.image.index + delta, s.image.list, s)
}

// ── 拦截对话图片点击 + 键盘切换 ──
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
    if (!paneRegistered || !activeKey) return
    if (getSessionState(activeKey).tab !== 'image') return
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

// ── 跟踪当前聚焦的会话（bot）──
function watchFocusedSession(ctx) {
  // focusedSessionOwner 对 bot 聊天可能解析为 null（模糊时 fail-closed），
  // 所以用 focusedSessionId（聚焦会话的运行时 id，跟随用户在瓦片间切换），
  // 它退到 focusedStoredSessionId，再退到单一全局状态。
  const pick =
    host.focusedSessionId && typeof host.focusedSessionId.subscribe === 'function'
      ? host.focusedSessionId
      : host.focusedStoredSessionId && typeof host.focusedStoredSessionId.subscribe === 'function'
        ? host.focusedStoredSessionId
        : null
  if (!pick) {
    activeKey = 'default' // 旧桌面无此 API：退化为单一全局状态
    return
  }
  const unsub = pick.subscribe(id => {
    const k = id ? String(id) : null
    if (!k) return // 草稿/未解析：保持当前会话的查看器不变
    onSessionChanged(k)
  })
  if (typeof ctx.onDispose === 'function') ctx.onDispose(unsub)
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

// ── 面板外壳：以会话为 key 重挂载内容 ──
function PdfReaderPane() {
  useSyncExternalStore(subscribeStore, () => version)
  if (!activeKey) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center p-4 text-center text-xs text-(--ui-text-tertiary)',
      children: '未聚焦任何会话'
    })
  }
  return jsx(PdfSessionView, { sk: activeKey }, activeKey)
}

// ── 单个会话的查看器内容（状态全部存 getSessionState(sk)，天然隔离）──
function PdfSessionView({ sk }) {
  const s = getSessionState(sk)

  const loadDir = useCallback(
    async d => {
      const st = getSessionState(sk)
      st.status = '正在读取目录…'
      st.entries = []
      emit()
      try {
        const desktop = window.hermesDesktop
        if (!desktop || !desktop.readDir) {
          st.status = '桌面桥不可用：请在 Hermes 桌面应用中使用本面板'
          emit()
          return
        }
        const res = await desktop.readDir(d)
        if (res && res.error) {
          st.status = '目录读取失败：' + res.error
          emit()
          return
        }
        const all = (res && res.entries) || []
        const dirs = all.filter(e => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name))
        const pdfs = all.filter(e => !e.isDirectory && /\.pdf$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))
        st.entries = [...dirs, ...pdfs]
        st.status = pdfs.length ? '' : '此目录下没有 PDF 文件'
        emit()
      } catch (e) {
        st.status = '目录读取失败：' + ((e && e.message) || String(e))
        emit()
      }
    },
    [sk]
  )

  // 挂载/换会话时刷新目录列表
  useEffect(() => {
    loadDir(getSessionState(sk).dir)
  }, [sk, loadDir])

  // blob 的生命周期归会话状态管：卸载不吊销（回来还要用），插件卸载统一清理
  const openFile = useCallback(
    async entry => {
      const st = getSessionState(sk)
      st.status = '正在加载 ' + entry.name + ' …'
      emit()
      try {
        const desktop = window.hermesDesktop
        if (!desktop || !desktop.readFileDataUrl) {
          st.status = '桌面桥不可用：请在 Hermes 桌面应用中使用本面板'
          emit()
          return
        }
        const res = await desktop.readFileDataUrl(entry.path)
        if (!res || typeof res !== 'string') {
          st.status = '文件读取失败：' + ((res && (res.message || res.error)) || '未知错误')
          emit()
          return
        }
        const bytes = await (await fetch(res)).arrayBuffer()
        const blob = new Blob([bytes], { type: 'application/pdf' })
        const url = URL.createObjectURL(blob)
        if (st.blobUrl) URL.revokeObjectURL(st.blobUrl)
        st.blobUrl = url
        st.selected = entry
        st.status = ''
        st.listOpen = false // 打开 PDF 后自动收起目录，阅读区占满面板
        emit()
      } catch (e) {
        st.status = '打开失败：' + ((e && e.message) || String(e))
        emit()
      }
    },
    [sk]
  )

  if (s.tab === 'image' && s.image.src) {
    // ── 图片页 ──
    return jsxs('div', {
      className: 'flex h-full flex-col gap-2 p-2 text-sm',
      children: [
        jsxs('div', {
          className: 'flex items-center gap-1',
          children: [
            jsx('button', {
              className:
                'rounded px-2 py-0.5 text-xs ' +
                (s.tab === 'image'
                  ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
                  : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'),
              type: 'button',
              onClick: () => {
                s.tab = 'image'
                emit()
              },
              children: '图片'
            }),
            jsx('button', {
              className:
                'rounded px-2 py-0.5 text-xs ' +
                (s.tab === 'pdf'
                  ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
                  : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'),
              type: 'button',
              onClick: () => {
                s.tab = 'pdf'
                emit()
              },
              children: 'PDF'
            })
          ]
        }),
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
                  disabled: !s.image.list || s.image.list.length < 2,
                  title: '上一张（←）',
                  children: '‹'
                }),
                jsx('div', {
                  className: 'shrink-0 text-xs text-(--ui-text-tertiary)',
                  children:
                    s.image.list && s.image.list.length
                      ? s.image.index + 1 + ' / ' + s.image.list.length
                      : ''
                }),
                jsx('button', {
                  className:
                    'rounded px-1.5 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary) disabled:opacity-40',
                  type: 'button',
                  onClick: () => stepImage(1),
                  disabled: !s.image.list || s.image.list.length < 2,
                  title: '下一张（→）',
                  children: '›'
                }),
                jsx('div', {
                  className: 'min-w-0 flex-1 truncate text-xs text-(--ui-text-tertiary)',
                  title: s.image.src,
                  children: s.image.alt || '对话图片'
                })
              ]
            }),
            jsx('div', {
              className: 'min-h-0 flex-1 overflow-auto rounded border border-(--ui-stroke-secondary)',
              children: jsx('img', {
                className: 'mx-auto block max-h-full max-w-full object-contain',
                src: s.image.src,
                alt: s.image.alt || '',
                draggable: false
              })
            })
          ]
        })
      ]
    })
  }

  // ── PDF 页 ──
  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-2 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx('button', {
            className:
              'rounded px-2 py-0.5 text-xs ' +
              (s.tab === 'image'
                ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
                : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'),
            type: 'button',
            onClick: () => {
              s.tab = 'image'
              emit()
            },
            children: '图片'
          }),
          jsx('button', {
            className:
              'rounded px-2 py-0.5 text-xs ' +
              (s.tab === 'pdf'
                ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
                : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'),
            type: 'button',
            onClick: () => {
              s.tab = 'pdf'
              emit()
            },
            children: 'PDF'
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-center gap-1.5',
        children: [
          jsx('input', {
            className:
              'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs text-(--ui-text-secondary)',
            type: 'text',
            value: s.dirInput,
            spellCheck: false,
            onChange: e => {
              s.dirInput = e.target.value
              emit()
            },
            onKeyDown: e => {
              if (e.key === 'Enter') {
                const next = String(s.dirInput || '').trim()
                if (next && next !== s.dir) {
                  s.dir = next
                  loadDir(next)
                }
              }
            },
            title: '目录路径，回车打开'
          }),
          jsx('button', {
            className:
              'rounded px-2 py-1 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)',
            type: 'button',
            onClick: () => {
              const next = String(s.dirInput || '').trim()
              if (next && next !== s.dir) {
                s.dir = next
                loadDir(next)
              }
            },
            children: '打开'
          }),
          jsx('button', {
            className:
              'rounded px-2 py-1 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)',
            type: 'button',
            onClick: () => {
              const up = dirUp(s.dir)
              s.dir = up
              s.dirInput = up
              loadDir(up)
            },
            title: '上级目录',
            children: '↑'
          })
        ]
      }),
      jsxs('div', {
        className: 'flex min-h-0 flex-1 gap-2',
        children: [
          s.listOpen
            ? jsx('div', {
                className:
                  'w-44 shrink-0 overflow-y-auto rounded border border-(--ui-stroke-secondary) p-1',
                children: s.entries.map(e =>
                  jsx(
                    'button',
                    {
                      className:
                        'block w-full truncate rounded px-1.5 py-1 text-left text-xs ' +
                        (e.isDirectory
                          ? 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
                          : s.selected && s.selected.path === e.path
                            ? 'bg-(--chrome-action-hover) text-(--ui-text-secondary)'
                            : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)'),
                      type: 'button',
                      title: e.path,
                      onClick: () => {
                        if (e.isDirectory) {
                          s.dir = e.path
                          s.dirInput = e.path
                          loadDir(e.path)
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
                    title: s.selected ? s.selected.path : '',
                    children: s.selected
                      ? s.selected.name
                      : s.listOpen
                        ? '从左侧选择一个 PDF'
                        : '点击「显示目录」选择 PDF'
                  }),
                  jsx('button', {
                    className:
                      'rounded px-2 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)',
                    type: 'button',
                    onClick: () => {
                      s.listOpen = !s.listOpen
                      emit()
                    },
                    title: s.listOpen ? '隐藏目录列表' : '显示目录列表',
                    children: s.listOpen ? '⇥ 隐藏目录' : '⇤ 显示目录'
                  }),
                  s.selected
                    ? jsx('button', {
                        className:
                          'rounded px-2 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)',
                        type: 'button',
                        onClick: () => {
                          const desktop = window.hermesDesktop
                          if (!s.selected || !desktop) return
                          if (typeof desktop.showItemInFolder === 'function') {
                            desktop.showItemInFolder(s.selected.path)
                          } else if (typeof desktop.openExternal === 'function') {
                            desktop.openExternal('file:///' + String(s.selected.path).replace(/\\/g, '/'))
                          }
                        },
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
                  s.blobUrl
                    ? jsx('embed', {
                        className: 'h-full w-full',
                        type: 'application/pdf',
                        src: s.blobUrl
                      })
                    : jsx('div', {
                        className:
                          'flex h-full items-center justify-center p-4 text-center text-xs text-(--ui-text-tertiary)',
                        children: s.status || '未打开文件'
                      })
                ]
              })
            ]
          })
        ]
      }),
      s.status && s.blobUrl
        ? jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: s.status })
        : null
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

    // 拦截对话图片点击 → 送进当前会话的「图片」页
    interceptChatImageClicks(ctx)

    // 跟踪聚焦的 bot 会话：换 bot → 收起/换状态；回原 bot → 原样恢复
    watchFocusedSession(ctx)

    // 插件卸载：统一吊销所有会话的 PDF blob
    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        sessionStates.forEach(st => {
          if (st.blobUrl) {
            try {
              URL.revokeObjectURL(st.blobUrl)
            } catch (e) {
              /* 忽略 */
            }
          }
        })
      })
    }

    // 注意：面板【不】在加载时注册 —— 由按钮/图片点击/会话恢复按需开/关
  }
}
