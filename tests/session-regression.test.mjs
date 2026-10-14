import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const APP = process.env.HERMES_DESKTOP_DIR ? resolve(process.env.HERMES_DESKTOP_DIR, 'package.json') : fileURLToPath(new URL('../package.json', import.meta.url))
const require = createRequire(pathToFileURL(APP))
const React = require('react')
const { JSDOM } = require('jsdom')
const { atom } = require('nanostores')
const { act } = React
const PLUGIN = process.env.PLUGIN_UNDER_TEST || fileURLToPath(new URL('../plugin.js', import.meta.url))
const toModule = name => pathToFileURL(require.resolve(name)).href
let generation = 0

async function mountPlugin() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="transcript" data-slot="aui_thread"></div></body></html>', { url: 'http://localhost/' })
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true
  })
  const { createRoot } = require('react-dom/client')
  const contributions = new Map()
  const cleanups = []
  const storage = new Map()
  const changed = atom(0)
  const visible = atom(false)
  const state = {
    focusedStoredSessionId: atom('chat-A'), focusedSessionId: atom('runtime-A'),
    focusedSessionOwner: atom({ connectionId: 'local', profile: 'bot-A' }),
    focusedSessionProfile: atom('bot-A'), activeSessionId: atom('runtime-A'),
    connectionId: atom('local'), profile: atom('bot-A'), cwd: atom('C:/workspace')
  }
  const notices = []
  const host = {
    state,
    paneVisibility: () => visible,
    undismissPane() {}, revealPane() { visible.set(true) },
    notify: msg => notices.push(msg)
  }
  globalThis.__pdfQaHost = host
  const ctx = {
    register(c) {
      contributions.set(c.id, c)
      changed.set(changed.get() + 1)
      const dispose = () => {
        if (contributions.get(c.id) !== c) return
        contributions.delete(c.id)
        if (c.area === 'panes') visible.set(false)
        changed.set(changed.get() + 1)
      }
      cleanups.push(dispose)
      return dispose
    },
    onDispose(fn) { cleanups.push(fn) },
    storage: { get: k => storage.get(k) ?? null, set: (k,v) => storage.set(k,v), remove: k => storage.delete(k) },
    os: { openExternal: async () => true, revealPath: async () => true },
    setTimeout(fn, ms) { const id = setTimeout(fn,ms); const stop = () => clearTimeout(id); cleanups.push(stop); return stop }
  }
  window.hermesDesktop = {
    readDir: async () => ({ entries: [{ name: 'test.pdf', path: 'C:/test.pdf', isDirectory: false }] }),
    readFileDataUrl: async () => 'data:application/pdf;base64,JVBERi0xLjQKJSB0ZXN0IGZpeHR1cmUK',
  }
  // The ONLY fake seam is the documented SDK/OS boundary; render and plugin code are real.
  const sdkCode = `import React from ${JSON.stringify(toModule('react'))}; export const host=globalThis.__pdfQaHost; export function useValue(a){return React.useSyncExternalStore(a.subscribe,a.get,a.get)}; // ${generation++}`
  const sdkUrl = 'data:text/javascript;base64,' + Buffer.from(sdkCode).toString('base64')
  let source = readFileSync(PLUGIN,'utf8')
  source = source.replace(/from\s+(['"])(@hermes\/plugin-sdk|react\/jsx-runtime|react)\1/g, (_m,_q,name) => 'from ' + JSON.stringify(name === '@hermes/plugin-sdk' ? sdkUrl : toModule(name)))
  const pluginUrl = 'data:text/javascript;base64,' + Buffer.from(source + '\n// ' + generation).toString('base64')
  const plugin = (await import(pluginUrl)).default
  function Harness() {
    React.useSyncExternalStore(changed.subscribe, changed.get, changed.get)
    return React.createElement(React.Fragment,null,[...contributions.values()].map(c => React.createElement('section', {
      key:c.id,'data-area':c.area,'data-contribution':c.id
    },React.createElement(c.render))))
  }
  const root = createRoot(document.getElementById('root'))
  await act(async () => { plugin.register(ctx); root.render(React.createElement(Harness)); await new Promise(r=>setTimeout(r,10)) })
  const settle = () => act(async () => { await new Promise(r=>setTimeout(r,25)) })
  const click = async el => { assert.ok(el,'expected clickable element'); await act(async () => { el.click(); await new Promise(r=>setTimeout(r,15)) }) }
  const button = text => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === text || b.getAttribute('title') === text || b.textContent === text)
  const pane = () => document.querySelector('[data-area="panes"]')
  const focus = async (id, profile='bot-' + id, runtime='runtime-' + id) => {
    await act(async () => {
      state.focusedSessionOwner.set({ connectionId:'local', profile })
      state.focusedSessionProfile.set(profile)
      state.focusedStoredSessionId.set(id)
      state.focusedSessionId.set(runtime)
      await new Promise(r=>setTimeout(r,25))
    })
  }
  const disable = async () => { await act(async () => { for (const f of cleanups.splice(0).reverse()) f() }) }
  const enable = async () => { await act(async () => { plugin.register(ctx); await new Promise(r=>setTimeout(r,15)) }) }
  const close = async () => { await disable(); await act(async () => root.unmount()); dom.window.close() }
  return { state, ctx, host, button, pane, click, focus, settle, close, notices, disable, enable }
}

test('bot A viewer disappears in bot B and reappears in bot A', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    assert.ok(h.pane(), 'A: viewer opens')
    await h.focus('chat-B','bot-B')
    assert.ok(!h.pane(),'B: viewer must not leak from A')
    await h.focus('chat-A','bot-A')
    assert.ok(h.pane(),'A: previously open viewer must return')
  } finally { await h.close() }
})

test('leaving a focused chat hides its viewer without forgetting it', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await h.focus(null,'bot-B',null)
    assert.ok(!h.pane(), 'draft/unresolved focus must not expose another chat viewer')
    await h.focus('chat-A','bot-A')
    assert.ok(h.pane(), 'restoring resolved focus must restore A')
  } finally { await h.close() }
})

test('directory browser starts at the current workspace, not a hardcoded course folder', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    assert.equal(h.pane().querySelector('input').value,'C:/workspace')
  } finally { await h.close() }
})

test('clicking a directive image opens it in the viewer', async () => {
  const h = await mountPlugin()
  try {
    document.getElementById('transcript').innerHTML='<div data-slot="thread"><span data-slot="aui_directive-image"><button type="button"><img src="https://example.test/A.png" alt="A"></button><button type="button" data-download>Download</button></span></div>'
    await h.click(document.querySelector('#transcript img'))
    assert.ok(h.pane(), 'directive image must open the right-side viewer')
    assert.equal(h.pane().querySelector('img').alt,'A')
  } finally { await h.close() }
})

test('image gallery only contains the clicked conversation, not another retained bot', async () => {
  const h = await mountPlugin()
  try {
    document.getElementById('transcript').innerHTML='<div data-slot="thread"><span data-slot="aui_zoomable-image"><button><img src="https://example.test/A.png" alt="A"></button></span></div><div data-slot="thread" style="display:none"><span data-slot="aui_zoomable-image"><button><img src="https://example.test/B.png" alt="B"></button></span></div>'
    await h.click(document.querySelector('#transcript img'))
    assert.ok(h.button('下一张（→）').disabled,'another bot image must not enter this gallery')
  } finally { await h.close() }
})

test('image download controls are not hijacked by the viewer', async () => {
  const h = await mountPlugin()
  try {
    document.getElementById('transcript').innerHTML='<div data-slot="thread"><span data-slot="aui_zoomable-image"><button><img src="https://example.test/A.png" alt="A"></button><button data-download>Download</button></span></div>'
    let downloaded=false
    const download=document.querySelector('[data-download]')
    download.addEventListener('click',()=>{downloaded=true})
    await h.click(download)
    assert.ok(downloaded,'download click must still reach its own handler')
    assert.ok(!h.pane(),'download must not open the viewer')
  } finally { await h.close() }
})

test('the toolbar reopens a core-closed pane on its first click', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await act(async()=>{h.host.paneVisibility().set(false)})
    await h.click(h.button('媒体查看器'))
    assert.ok(h.pane(),'toolbar must reopen instead of silently unregistering a hidden pane')
    assert.ok(h.host.paneVisibility().get(),'pane must be visible after one click')
  } finally { await h.close() }
})

test('each bot retains its own PDF and directory toggle state', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await h.click(h.button('test.pdf'))
    const srcA=h.pane().querySelector('embed').src
    assert.ok(!h.button('test.pdf'),'opening a PDF hides the directory list')
    await h.focus('chat-B','bot-B')
    assert.ok(!h.pane(),'B initially has no viewer')
    await h.click(h.button('媒体查看器'))
    await h.click(h.button('test.pdf'))
    const srcB=h.pane().querySelector('embed').src
    assert.notEqual(srcA,srcB,'independently opened PDFs have different blob identities')
    await h.focus('chat-A','bot-A')
    assert.equal(h.pane().querySelector('embed').src,srcA,'A returns with its original PDF')
    await h.click(h.button('显示目录列表'))
    assert.ok(h.button('test.pdf'),'directory can be expanded')
    await h.click(h.button('隐藏目录列表'))
    assert.ok(!h.button('test.pdf'),'directory can be collapsed again')
    await h.focus('chat-B','bot-B')
    assert.equal(h.pane().querySelector('embed').src,srcB,'B still has its own PDF')
  } finally { await h.close() }
})

test('runtime rehydration does not lose a durable chat PDF', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await h.click(h.button('test.pdf'))
    const src=h.pane().querySelector('embed').src
    await act(async()=>{h.state.focusedSessionId.set('new-runtime-id')})
    assert.equal(h.pane().querySelector('embed').src,src)
  } finally { await h.close() }
})

test('image arrows cycle and typing-area arrow keys are not intercepted', async () => {
  const h = await mountPlugin()
  try {
    document.getElementById('transcript').innerHTML='<div data-slot="thread"><span data-slot="aui_zoomable-image"><button><img src="https://example.test/A.png" alt="A"></button></span><span data-slot="aui_zoomable-image"><button><img src="https://example.test/B.png" alt="B"></button></span></div><textarea></textarea>'
    await h.click(document.querySelector('#transcript img'))
    await h.click(h.button('下一张（→）'))
    assert.equal(h.pane().querySelector('img').alt,'B')
    await h.click(h.button('下一张（→）'))
    assert.equal(h.pane().querySelector('img').alt,'A')
    const typingKey=new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})
    document.querySelector('textarea').dispatchEvent(typingKey)
    assert.ok(!typingKey.defaultPrevented,'typing-area arrow must not be stolen')
    assert.equal(h.pane().querySelector('img').alt,'A')
    await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true})))
    assert.equal(h.pane().querySelector('img').alt,'B')
  } finally { await h.close() }
})

test('a stale layout visibility flag does not block opening an unregistered viewer', async () => {
  const h = await mountPlugin()
  try {
    await act(async()=>{h.host.paneVisibility().set(true)})
    assert.equal(h.button('媒体查看器').getAttribute('aria-pressed'),'false','no registered pane means viewer is closed, even if layout has a stale id')
    await h.click(h.button('媒体查看器'))
    assert.ok(h.pane(),'first click must register and show the viewer')
  } finally { await h.close() }
})

test('the same stored id in another bot does not expose the previous bot PDF', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await h.click(h.button('test.pdf'))
    const original=h.pane().querySelector('embed').src
    await h.focus('chat-A','bot-B')
    assert.ok(!h.pane(),'same id, different owner must not leak A PDF')
    await h.focus('chat-A','bot-A')
    assert.equal(h.pane().querySelector('embed').src,original)
  } finally { await h.close() }
})

test('same profile and stored id on another connection are isolated', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await act(async()=>h.state.focusedSessionOwner.set({connectionId:'remote',profile:'bot-A'}))
    assert.ok(!h.pane(),'different connection must not inherit local viewer')
    await act(async()=>h.state.focusedSessionOwner.set({connectionId:'local',profile:'bot-A'}))
    assert.ok(h.pane())
  } finally { await h.close() }
})

test('unresolved owner hides cached content until the owner is confirmed', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await act(async()=>h.state.focusedSessionOwner.set(null))
    assert.ok(!h.pane(),'unknown owner must fail closed')
    await act(async()=>h.state.focusedSessionOwner.set({connectionId:'local',profile:'bot-A'}))
    assert.ok(h.pane())
  } finally { await h.close() }
})

test('disabling and enabling the same plugin module permits reopening', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await h.disable()
    await h.enable()
    await h.click(h.button('媒体查看器'))
    assert.ok(h.pane(),'re-enabled module must register a fresh pane')
  } finally { await h.close() }
})

test('an older PDF read cannot replace a newer selection', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    window.hermesDesktop.readDir=async()=>({entries:[{name:'first.pdf',path:'C:/first.pdf',isDirectory:false},{name:'second.pdf',path:'C:/second.pdf',isDirectory:false}]})
    await h.click(h.button('↑'))
    const resolveReads={}
    window.hermesDesktop.readFileDataUrl=path=>new Promise(resolve=>{resolveReads[path]=resolve})
    await h.click(h.button('first.pdf'))
    await h.click(h.button('second.pdf'))
    resolveReads['C:/second.pdf']('data:application/pdf;base64,JVBERi0xLjQKc2Vjb25k')
    await h.settle()
    const newest=h.pane().querySelector('embed').src
    resolveReads['C:/first.pdf']('data:application/pdf;base64,JVBERi0xLjQKZmlyc3Q=')
    await h.settle()
    assert.equal(h.pane().querySelector('embed').src,newest,'late first PDF read must be ignored')
  } finally { await h.close() }
})

test('an older directory response cannot overwrite the current directory', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    const resolveReads={}
    window.hermesDesktop.readDir=path=>new Promise(resolve=>{resolveReads[path]=resolve})
    const setInput=async value=>{await act(async()=>{const input=h.pane().querySelector('input');Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
    await setInput('C:/First');await h.click(h.button('打开'))
    await setInput('C:/New');await h.click(h.button('打开'))
    resolveReads['C:/New']({entries:[{name:'new.pdf',path:'C:/New/new.pdf',isDirectory:false}]})
    await h.settle()
    resolveReads['C:/First']({entries:[{name:'old.pdf',path:'C:/First/old.pdf',isDirectory:false}]})
    await h.settle()
    assert.equal(h.pane().querySelector('input').value,'C:/New')
    assert.ok(h.button('new.pdf') && !h.button('old.pdf'),'old directory result must not replace the new directory')
  } finally { await h.close() }
})

test('a new bot starts browsing at the workspace active when its state is created', async () => {
  const h = await mountPlugin()
  try {
    await act(async()=>h.state.cwd.set('C:/SecondWorkspace'))
    await h.focus('chat-B','bot-B')
    await h.click(h.button('媒体查看器'))
    assert.equal(h.pane().querySelector('input').value,'C:/SecondWorkspace','new bot must use its current workspace')
  } finally { await h.close() }
})

for (const [directory,parent] of [['C:/x','C:/'],['C:/','C:/'],['/x','/'],['/','/'],['//server/share','//server/share']]) {
  test('up navigation respects root boundaries: '+directory, async () => {
    const h = await mountPlugin()
    try {
      await h.click(h.button('媒体查看器'))
      await act(async()=>{const input=h.pane().querySelector('input');Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,directory);input.dispatchEvent(new Event('input',{bubbles:true}))})
      await h.click(h.button('打开'))
      await h.click(h.button('↑'))
      assert.equal(h.pane().querySelector('input').value,parent,'parent must respect filesystem root')
    } finally { await h.close() }
  })
}

test('external reveal uses the supported plugin OS bridge', async () => {
  const h = await mountPlugin()
  try {
    const revealed=[]
    h.ctx.os.revealPath=async path=>{revealed.push(path);return true}
    await h.click(h.button('媒体查看器'))
    await h.click(h.button('test.pdf'))
    await h.click(h.button('外部打开'))
    assert.deepEqual(revealed,['C:/test.pdf'],'external reveal must call the actual OS bridge')
  } finally { await h.close() }
})

test('an empty image tab shows guidance, not the PDF directory', async () => {
  const h = await mountPlugin()
  try {
    await h.click(h.button('媒体查看器'))
    await h.click(h.button('图片'))
    assert.ok(!h.pane().querySelector('input'),'empty image tab must not show the PDF browser')
    assert.ok(h.pane().textContent.includes('点击对话中的图片'))
  } finally { await h.close() }
})

for (const reenable of [false,true]) {
  test('pending PDF completion after '+(reenable?'re-enable':'disable')+' creates no stale resource', async () => {
    const h = await mountPlugin()
    const originalCreate=URL.createObjectURL
    const urls=[]
    URL.createObjectURL=blob=>{const url=originalCreate(blob);urls.push(url);return url}
    try {
      await h.click(h.button('媒体查看器'))
      let resolveRead
      window.hermesDesktop.readFileDataUrl=()=>new Promise(resolve=>{resolveRead=resolve})
      await h.click(h.button('test.pdf'))
      await h.disable()
      if(reenable)await h.enable()
      resolveRead('data:application/pdf;base64,JVBERi0xLjQKc3RhbGU=')
      await h.settle()
      assert.equal(urls.length,0,'retired plugin request must not create a blob')
    } finally {
      await h.close()
      for(const url of urls)URL.revokeObjectURL(url)
      URL.createObjectURL=originalCreate
    }
  })
}
