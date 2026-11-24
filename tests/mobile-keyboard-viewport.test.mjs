import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from './fixtures/client-vm.mjs'

const layoutSource = await readFile(new URL('../tavern-plugin/src/client/modules/mobile-layout.js', import.meta.url), 'utf8')
const entrySource = await readFile(new URL('../android/dsh-tavern-entry/client.js', import.meta.url), 'utf8')
const css = await readFile(new URL('../tavern-plugin/lib/client-assets/tavern.css', import.meta.url), 'utf8')

// 取出一个具名函数（含函数体），宿主客户端是 IIFE 拼装出来的，只能按平衡括号切片。
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `缺少 ${name}`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (!depth) return source.slice(start, index + 1)
    }
  }
  throw new Error(`${name} 括号不闭合`)
}

function makeClassList() {
  const names = new Set()
  return {
    add: (...values) => values.forEach(value => names.add(value)),
    remove: (...values) => values.forEach(value => names.delete(value)),
    contains: value => names.has(value),
    toggle: (value, on) => { if (on === undefined ? !names.has(value) : on) names.add(value); else names.delete(value) },
    values: () => [...names]
  }
}

function makeStyle() {
  const values = new Map()
  return {
    getPropertyValue: name => values.get(name) || '',
    getPropertyPriority: () => '',
    setProperty: (name, value) => values.set(name, String(value)),
    removeProperty: name => values.delete(name)
  }
}

function makeDocument({ width = 390 } = {}) {
  const listeners = new Map()
  const doc = {
    documentElement: { style: makeStyle(), classList: makeClassList() },
    body: {},
    querySelector: selector => selector === '[data-composer-seat]' ? doc.seat : selector === '[data-composer-card]' ? doc.card : null,
    addEventListener: (name, handler) => listeners.set(name, [...(listeners.get(name) || []), handler]),
    removeEventListener: (name, handler) => listeners.set(name, (listeners.get(name) || []).filter(item => item !== handler)),
    dispatch: (name, event = {}) => (listeners.get(name) || []).forEach(handler => handler(event))
  }
  doc.seat = { getBoundingClientRect: () => ({ top: 700 - (800 - doc.view.innerHeight), left: 0, width }), scrollHeight: 0, clientHeight: 0, isConnected: true, children: [] }
  doc.card = { contains: target => target?.inComposer === true, getBoundingClientRect: () => ({ top: 700, left: 0, width }) }
  return doc
}

function makeView(doc, { height = 800, visual, keyboardRect, userAgent = "" } = {}) {
  const frames = new Map()
  let nextFrame = 1
  const listeners = new Map()
  const vvListeners = new Map()
  const keyboardListeners = new Map()
  const keyboard = keyboardRect === undefined ? null : {
    boundingRect: { ...keyboardRect },
    addEventListener: (name, handler) => keyboardListeners.set(name, [...(keyboardListeners.get(name) || []), handler]),
    removeEventListener: (name, handler) => keyboardListeners.set(name, (keyboardListeners.get(name) || []).filter(item => item !== handler)),
    dispatch: name => (keyboardListeners.get(name) || []).forEach(handler => handler())
  }
  const vv = {
    height: visual ?? height,
    offsetTop: 0,
    scale: 1,
    addEventListener: (name, handler) => vvListeners.set(name, [...(vvListeners.get(name) || []), handler]),
    removeEventListener: (name, handler) => vvListeners.set(name, (vvListeners.get(name) || []).filter(item => item !== handler)),
    dispatch: name => (vvListeners.get(name) || []).forEach(handler => handler())
  }
  const view = {
    innerHeight: height,
    visualViewport: vv,
    navigator: { userAgent, virtualKeyboard: keyboard },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: handler => { const id = nextFrame++; frames.set(id, handler); return id },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, handler) => listeners.set(name, [...(listeners.get(name) || []), handler]),
    removeEventListener: (name, handler) => listeners.set(name, (listeners.get(name) || []).filter(item => item !== handler)),
    dispatch: name => (listeners.get(name) || []).forEach(handler => handler())
  }
  return {
    view,
    vv,
    keyboard,
    // 一帧一帧地跑排队的 rAF 回调。
    flush: () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(handler => handler()) },
    pending: () => frames.size
  }
}

const header = { getBoundingClientRect: () => ({ bottom: 44 }) }

function installPin(options) {
  const doc = makeDocument()
  const harness = makeView(doc, options)
  doc.view = harness.view
  doc.defaultView = harness.view
  doc.querySelector = selector => selector === '[data-composer-seat]' ? doc.seat : selector === '[data-composer-card]' ? doc.card : selector.includes('header') ? header : null
  const clock = { now: 1000 }
  const sandbox = {
    Date: { now: () => clock.now },
    composerOffsetPx: () => 0,
    sheetMaxPx: () => 0
  }
  const factory = vm.runInNewContext(`${layoutSource}\n;({ tavernShellHeight, keyboardPadPx, installVisualViewportPin, TAVERN_KEYBOARD_INSET_MIN, TAVERN_KEYBOARD_SETTLE_MS })`, sandbox)
  const release = factory.installVisualViewportPin(doc)
  return { doc, harness, factory, release, clock, style: doc.documentElement.style }
}

test('键盘顶起页面时外壳跟随布局视口，而不是可视区像素', () => {
  const { style, factory } = installPin()
  // 没有键盘：布局视口就是可视区。
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '100%')
  // Chrome resizes-visual：布局视口不动，可视区缩了 → 必须按像素锁高，否则输入条被键盘盖住。
  assert.equal(factory.tavernShellHeight(800, 460), '460px')
  // 原生窗口或父级 iframe 跟着键盘缩了：布局视口自己就变短了 → 100% 就是同帧跟随。
  assert.equal(factory.tavernShellHeight(470, 470), '100%')
  assert.equal(factory.tavernShellHeight(0, 0), null)
  assert.equal(factory.tavernShellHeight(800, 795), '100%', '取整误差不能当成键盘')
  assert.equal(factory.tavernShellHeight(800, 780), '780px', '明显的遮挡仍要按可视区缩')
})

test('输入法压住多少就直接给输入条垫多少', () => {
  const { factory } = installPin()
  // 布局视口和可视化视口都停在 800，键盘其实从 786 起 —— 底下 14px 的输入框被盖住。
  assert.equal(factory.keyboardPadPx({ boundingRect: { top: 786, height: 663 } }, 800), 14)
  // 键盘收齐时矩形是零，不能拿它当遮挡。
  assert.equal(factory.keyboardPadPx({ boundingRect: { top: 0, height: 0 } }, 800), 0)
  assert.equal(factory.keyboardPadPx(null, 800), 0)
  // 键盘整个在下面（布局视口已经缩到键盘上方）就没有要垫的。
  assert.equal(factory.keyboardPadPx({ boundingRect: { top: 800, height: 663 } }, 800), 0)
  // 坐标系对不上的值（上沿跑到可视区上半段）一律不认，垫多了会把输入条顶到屏幕中间。
  assert.equal(factory.keyboardPadPx({ boundingRect: { top: 51, height: 663 } }, 800), 0)
  assert.equal(factory.keyboardPadPx({ boundingRect: { top: Number.NaN, height: 663 } }, 800), 0)
  // 垫高不超过输入法自身高度。
  assert.equal(factory.keyboardPadPx({ boundingRect: { top: 480, height: 200 } }, 800), 200)
})

test('输入法几何一变就当场垫底，不等可视化视口事件', () => {
  const { harness, style, release } = installPin({ keyboardRect: { top: 786, height: 663 } })
  assert.equal(style.getPropertyValue('--dsh-keyboard-inset'), '14px', '进页面就按输入法压住的那一截垫底')
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '100%', '外壳不必再缩')
  assert.equal(style.getPropertyValue('--dsh-vv-height'), '786px', '可视高度扣掉垫底那一段')
  harness.keyboard.boundingRect.top = 800
  harness.keyboard.boundingRect.height = 0
  harness.keyboard.dispatch('geometrychange')
  assert.equal(style.getPropertyValue('--dsh-keyboard-inset'), '0px', '键盘收起立刻回落到 0')
  harness.keyboard.boundingRect.top = 786
  harness.keyboard.boundingRect.height = 663
  harness.keyboard.dispatch('geometrychange')
  assert.equal(style.getPropertyValue('--dsh-keyboard-inset'), '14px')
  release()
})

test('visualViewport 缩小时当场改高度，不等下一帧', () => {
  const { harness, style } = installPin()
  harness.view.innerHeight = 800
  harness.vv.height = 420
  harness.vv.dispatch('resize')
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '420px')
  harness.vv.height = 800
  harness.vv.dispatch('resize')
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '100%')
})

test('iOS 输入框贴住键盘，键入和视口平移都不额外留白', () => {
  const { doc, harness, style, release, clock } = installPin({ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit' })
  const classes = doc.documentElement.classList
  const opened = () => classes.contains('dsh-tavern-ios-composer-keyboard')
  assert.equal(classes.contains('dsh-tavern-ios-composer'), true)
  assert.equal(opened(), false)

  const editor = { nodeType: 1, isContentEditable: true, inComposer: true }
  doc.activeElement = editor
  doc.dispatch('focusin', { target: editor })
  harness.vv.height = 750
  harness.vv.dispatch('resize')
  assert.equal(opened(), false, '浏览器工具栏或实体键盘不触发让位')
  harness.vv.height = 440
  harness.vv.offsetTop = 18
  harness.vv.dispatch('resize')
  assert.equal(opened(), true)
  assert.equal(style.getPropertyValue('--dsh-vv-top'), '18px')
  assert.equal(style.getPropertyValue('--dsh-vv-height'), '440px', '外壳正好止于键盘上沿')
  assert.equal(style.getPropertyValue('--dsh-keyboard-inset'), '0px', '工具条让位不重复计算键盘高度')
  assert.equal(style.getPropertyValue('--dsh-ios-accessory-inset'), '', '不再按键入位移额外垫高')
  clock.now += 500
  harness.flush()

  // 浏览器为露出光标平移可视区：外壳跟着平移，高度不变。
  harness.vv.offsetTop = 30
  doc.dispatch('input', { target: editor })
  assert.equal(style.getPropertyValue('--dsh-vv-top'), '30px', '键入后视口事件迟到也当场跟上')
  assert.equal(style.getPropertyValue('--dsh-vv-height'), '440px')
  // 输入法候选栏改变键盘高度：外壳跟着键盘上沿走。
  harness.vv.height = 404
  doc.dispatch('compositionend', { target: editor })
  assert.equal(style.getPropertyValue('--dsh-vv-height'), '404px')

  doc.activeElement = { nodeType: 1, tagName: 'BUTTON', inComposer: true }
  doc.dispatch('focusout', { target: editor })
  assert.equal(opened(), true, '触摸发送时按钮不能移位')
  harness.vv.height = 800
  harness.vv.offsetTop = 0
  harness.vv.dispatch('resize')
  assert.equal(opened(), false)
  release()
  assert.equal(classes.contains('dsh-tavern-ios-composer'), false)
})

test('iOS 键盘收起后把残留的页面平移归零', () => {
  const { doc, harness, release } = installPin({ userAgent: 'iPhone' })
  const calls = []
  harness.view.scrollY = 0
  harness.view.scrollTo = (x, y) => { calls.push([x, y]); harness.view.scrollY = y; harness.vv.offsetTop = 0 }
  doc.body.classList = makeClassList()
  doc.body.classList.add('dsh-tavern-shell-active')
  const editor = { nodeType: 1, tagName: 'TEXTAREA', inComposer: true }
  doc.activeElement = editor
  doc.dispatch('focusin', { target: editor })
  harness.vv.height = 440
  harness.vv.offsetTop = 120
  harness.vv.dispatch('resize')
  assert.deepEqual(calls, [], '键盘打开时由浏览器负责露出输入框')
  doc.activeElement = doc.body
  harness.vv.height = 800
  harness.vv.offsetTop = 64
  harness.vv.dispatch('resize')
  assert.deepEqual(calls, [[0, 0]], '键盘收起后 offsetTop 没归零')
  harness.vv.dispatch('scroll')
  assert.equal(calls.length, 1, '已归零时不再滚动')
  release()
})

test('iOS 的 innerHeight 跟着键盘缩短时，外壳仍按初始包含块锁到可视区', () => {
  const { doc, harness, style, release } = installPin({ userAgent: 'iPhone' })
  doc.documentElement.clientHeight = 800
  const editor = { nodeType: 1, tagName: 'TEXTAREA', inComposer: true }
  doc.activeElement = editor
  doc.dispatch('focusin', { target: editor })
  // Safari 把 innerHeight 报成可视区高度，页面同时被卷上去 350，固定定位仍按 800 高的初始包含块排。
  harness.view.innerHeight = 450
  harness.vv.height = 450
  harness.vv.offsetTop = 350
  harness.vv.dispatch('resize')
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '450px', '不能当成布局视口已经变短')
  assert.equal(style.getPropertyValue('--dsh-vv-top'), '350px', '外壳跟着可视区下移，顶栏不被卷出屏幕')
  assert.equal(doc.documentElement.classList.contains('dsh-tavern-ios-composer-keyboard'), true)
  release()
})

function makeTailGuard() {
  const listeners = new Map()
  const doc = {
    defaultView: {},
    addEventListener: (name, handler, options) => listeners.set(name + (options?.capture ? ':capture' : ''), handler),
    removeEventListener: (name, _handler, options) => listeners.delete(name + (options?.capture ? ':capture' : ''))
  }
  const clock = { now: 10000 }
  const factory = vm.runInNewContext(`${layoutSource}\n;({ installTavernTailGuard })`, { Date: { now: () => clock.now } })
  const release = factory.installTavernTailGuard(doc)
  let following = true
  const scroller = {
    scrollTop: 3000, scrollHeight: 3400, clientHeight: 400,
    hasAttribute: name => name === 'data-conversation-scroll',
    querySelector: selector => selector === '[data-chat-following-tail]' && following ? {} : null
  }
  const scroll = top => { scroller.scrollTop = top; listeners.get('scroll:capture')({ target: scroller }) }
  const input = (name, target = { closest: () => null }) => listeners.get(name + ':capture')({ target })
  return { scroller, scroll, input, clock, release, listeners, setFollowing: value => { following = value } }
}

test('iOS 跟随最新时，浏览器自己把聊天往上推会在同一次滚动事件里放回底部', () => {
  const guard = makeTailGuard()
  guard.scroll(3000)
  guard.scroll(2300)
  assert.equal(guard.scroller.scrollTop, 3000, '没有读者手势的上跳放回底部')

  guard.input('pointerdown', { closest: selector => selector === '[data-composer-seat]' ? {} : null })
  guard.scroll(2400)
  assert.equal(guard.scroller.scrollTop, 3000, '点输入框、发送不算读者滚动')

  guard.scroller.scrollHeight = 3200
  guard.scroll(2790)
  assert.equal(guard.scroller.scrollTop, 2790, '内容变短时浏览器夹到新的底部，不再干预')

  guard.input('touchstart')
  guard.scroll(2000)
  assert.equal(guard.scroller.scrollTop, 2000, '读者自己往上翻')
  guard.clock.now += 1500
  guard.setFollowing(false)
  guard.scroll(1500)
  assert.equal(guard.scroller.scrollTop, 1500, '离开最新后不管')
  guard.release()
  assert.equal(guard.listeners.size, 0)
})

test('iOS 同步缩小布局与可视区时，逐帧变化仍能识别键盘', () => {
  const { doc, harness, release } = installPin({ userAgent: 'iPhone' })
  const opened = () => doc.documentElement.classList.contains('dsh-tavern-ios-composer-keyboard')
  doc.activeElement = { nodeType: 1, tagName: 'TEXTAREA', inComposer: true }
  doc.dispatch('focusin', { target: doc.activeElement })
  for (const height of [770, 740, 710, 680, 500]) {
    harness.view.innerHeight = harness.vv.height = height
    harness.view.dispatch('resize')
  }
  assert.equal(opened(), true)
  harness.view.innerHeight = harness.vv.height = 800
  harness.view.dispatch('resize')
  assert.equal(opened(), false, '关闭键盘时编辑器仍有焦点也要回落')
  release()
})

test('布局视口被原生顶上去时切换成 100%，关闭后回落', () => {
  const { harness, style } = installPin()
  harness.view.innerHeight = 470
  harness.vv.height = 470
  harness.view.dispatch('resize')
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '100%')
  harness.view.innerHeight = 800
  harness.vv.height = 800
  harness.view.dispatch('resize')
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '100%')
})

test('漏掉一次 resize 事件也能在后续帧里自己纠正（不顶上去/不回落）', () => {
  const { harness, style, clock } = installPin()
  // 键盘弹出：事件照常来，进入跟随模式。
  harness.vv.dispatch('resize')
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '100%')
  // 键盘真的弹出来，但这次系统一个事件都没发。
  harness.view.innerHeight = 800
  harness.vv.height = 430
  clock.now += 16
  harness.flush()
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '430px', '自行刷帧要把页面拉回键盘上方')
  // 键盘收起同样不发事件。
  harness.vv.height = 800
  clock.now += 16
  harness.flush()
  assert.equal(style.getPropertyValue('--dsh-shell-height'), '100%')
})

test('刷新窗口只在输入法动画期间持续', () => {
  const { harness, clock, factory } = installPin()
  harness.vv.dispatch('resize')
  let frames = 0
  while (harness.pending()) {
    clock.now += 16
    harness.flush()
    assert.ok(++frames < 100, '刷新必须自己停下来')
  }
  assert.ok(clock.now - 1000 >= factory.TAVERN_KEYBOARD_SETTLE_MS, '至少覆盖一次输入法动画')
})

test('内嵌酒馆的 iframe 外壳同样跟随布局视口', () => {
  const source = sliceFunction(entrySource, 'installEmbeddedViewport')
  const constants = entrySource.slice(entrySource.indexOf('const EMBED_KEYBOARD_INSET_MIN'), entrySource.indexOf('function installEmbeddedViewport('))
  assert.match(constants, /EMBED_KEYBOARD_INSET_MIN/)
  const clock = { now: 1000 }
  const sandbox = { Date: { now: () => clock.now } }
  const factory = vm.runInNewContext(`${constants}\n${source}\n;({ installEmbeddedViewport })`, sandbox)
  const doc = makeDocument()
  const harness = makeView(doc)
  // 内嵌外壳直接写 DOM style 属性，不是 setProperty。
  const root = { style: { removeProperty(name) { delete this[name] } }, ownerDocument: { defaultView: harness.view } }
  const release = factory.installEmbeddedViewport(root)
  assert.equal(root.style.height, '100%', '没键盘时铺满顶层布局视口')
  // 浏览器 resizes-visual：顶层布局视口不动，只有可视区缩了 → 外壳按像素缩，否则输入条被键盘盖住。
  harness.view.innerHeight = 800
  harness.vv.height = 380
  harness.vv.dispatch('resize')
  assert.equal(root.style.height, '380px')
  // 原生把窗口顶上去之后交回布局视口，内部酒馆就跟着原生重排，不再等事件。
  harness.view.innerHeight = 380
  harness.vv.height = 380
  harness.view.dispatch('resize')
  assert.equal(root.style.height, '100%')
  release()
})

test('phone layout holds minimum-scale=1 so stray overflow cannot zoom the page out; dispose restores the viewport meta', () => {
  const doc = makeDocument()
  const harness = makeView(doc)
  doc.view = harness.view
  doc.defaultView = harness.view
  let content = 'width=device-width, initial-scale=1'
  const meta = { getAttribute: () => content, setAttribute: (_name, value) => { content = value } }
  doc.querySelector = selector => selector === 'meta[name="viewport"]' ? meta : selector === '[data-composer-seat]' ? doc.seat : selector === '[data-composer-card]' ? doc.card : selector.includes('header') ? header : null
  const factory = vm.runInNewContext(`${layoutSource}\n;({ installVisualViewportPin })`, { Date, composerOffsetPx: () => 0, sheetMaxPx: () => 0 })
  const release = factory.installVisualViewportPin(doc)
  harness.flush()
  assert.equal(content, 'width=device-width, initial-scale=1, minimum-scale=1')
  release()
  assert.equal(content, 'width=device-width, initial-scale=1')
})

test('sync 严格先批量读取几何再写入 CSS 变量，且同帧重复 resize 不二次测量', () => {
  const ops = []
  let rectReads = 0
  const doc = makeDocument()
  const harness = makeView(doc, { height: 800 })
  doc.view = harness.view
  doc.defaultView = harness.view
  const baseStyle = doc.documentElement.style
  doc.documentElement.style = {
    getPropertyValue: name => baseStyle.getPropertyValue(name),
    getPropertyPriority: () => '',
    setProperty: (name, value) => { ops.push('write:' + name); baseStyle.setProperty(name, value) },
    removeProperty: name => { ops.push('remove:' + name); baseStyle.removeProperty(name) },
  }
  doc.seat = {
    getBoundingClientRect: () => { ops.push('read:seat'); rectReads++; return { top: 700, left: 0, width: 390 } },
    scrollHeight: 60, clientHeight: 60, isConnected: true, children: [],
  }
  doc.card = null
  const trackedHeader = {
    getBoundingClientRect: () => { ops.push('read:header'); rectReads++; return { bottom: 44 } },
    isConnected: true,
  }
  doc.querySelector = selector => selector === '[data-composer-seat]' ? doc.seat : selector.includes('header') ? trackedHeader : null
  const clock = { now: 1000 }
  const { installVisualViewportPin } = vm.runInNewContext(
    `${layoutSource}\n;({ installVisualViewportPin })`,
    { Date: { now: () => clock.now }, composerOffsetPx: () => 0, sheetMaxPx: () => 0 }
  )
  const release = installVisualViewportPin(doc)
  ops.length = 0
  rectReads = 0

  harness.view.innerHeight = 480
  harness.vv.height = 480
  harness.view.dispatch('resize')
  const firstWrite = ops.findIndex(item => item.startsWith('write:') || item.startsWith('remove:'))
  const lastRead = ops.findLastIndex(item => item.startsWith('read:'))
  assert.ok(lastRead >= 0 && firstWrite > lastRead, '所有几何读取必须在首次 CSS 写入之前完成：' + JSON.stringify(ops))
  assert.equal(rectReads, 2, '单次 resize 只读 header 与 seat 各一次')

  // 紧接着同一帧内 visualViewport.resize 带着相同尺寸到达：不应再次测量
  harness.vv.dispatch('resize')
  assert.equal(rectReads, 2, '几何未变时同帧第二次 resize 跳过重复 sync')
  release()
})

test('APK 原生 IME 动画使用 GPU translationY 跟随，不在 onProgress 逐帧 setPadding 重排 WebView', async () => {
  const preparePy = await readFile(new URL('../android/apk/prepare.py', import.meta.url), 'utf8')
  const start = preparePy.indexOf('def patch_web_fullscreen_ui(')
  const end = preparePy.indexOf('\ndef prepare(', start)
  assert.ok(start >= 0 && end > start, '找到 patch_web_fullscreen_ui 定义')
  const fn = preparePy.slice(start, end)
  const onProgressStart = fn.indexOf('public WindowInsetsCompat onProgress(')
  const onEndStart = fn.indexOf('public void onEnd(', onProgressStart)
  assert.ok(onProgressStart >= 0 && onEndStart > onProgressStart, '找到 onProgress 回调')
  const onProgressBody = fn.slice(onProgressStart, onEndStart)
  assert.doesNotMatch(onProgressBody, /setPadding\(/, 'onProgress 禁止逐帧 setPadding 触发 WebView 重排')
  assert.match(onProgressBody, /setChildrenTranslationY\(/, 'onProgress 通过 GPU translationY 逐帧跟随键盘')
  assert.match(fn, /setClipToPadding\(true\)/, '启用 clipToPadding 防止平移侵入状态栏安全区')
  assert.match(fn, /else if \(ime < keyboard\[0\]\)/, '收回动画开始时预先扩回高度并补偿 translationY')
})
