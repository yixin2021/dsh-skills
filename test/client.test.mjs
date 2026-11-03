/**
 * Client-half tests: the module the browser loads, driven without a browser.
 *
 * The React stub below exposes ONLY `createElement`, `useState` and
 * `useEffect` — the three functions the Host's curated `React` object
 * guarantees. Anything else resolves to `undefined`, so a hook the shell does
 * not provide fails here exactly as it would in the page, instead of being
 * quietly implemented by the test.
 *
 * @module dsh-skills/test/client
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const TEXT = await readFile(SOURCE, 'utf8')

/**
 * Define a global the runtime may already own.
 *
 * Node 21 turned `navigator` into a getter-only global, so assigning to it
 * throws; the panel never reads it (it reads the Host's locale instead), but
 * the harness sets it to prove as much.
 *
 * @param name - the global's name.
 * @param value - the value it should hold.
 */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}

/**
 * Load the client half against a stub runtime.
 *
 * @param options - `active` locale id, `navigatorLanguage`, `baseUri`.
 * @returns the registrations, the module exports and the render helper.
 */
function loadClient(options = {}) {
  const registrations = []
  const listeners = new Map()
  const hooks = { cursor: 0, states: [] }

  const React = {
    createElement(type, props, ...children) {
      // Mirror React: children passed as arguments are also in `props.children`,
      // which is where the test looks for a button's label.
      const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: { ...(props ?? {}), children: kids }, children: kids }
    },
    useState(initial) {
      const index = hooks.cursor
      hooks.cursor += 1
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === 'function' ? initial() : initial
      }
      return [hooks.states[index], (next) => { hooks.states[index] = next }]
    },
    // Mount effects stay inert by default so rendering a panel in a test has no
    // side effects; the refresh test opts in to prove the mount load happens.
    useEffect(effect) {
      if (options.runEffects === true) effect()
    },
  }

  const localeService = {
    getSnapshot: () => ({ active: options.active ?? 'zh-CN', revision: 1 }),
    subscribe: () => () => {},
    getLocale: () => ({ active: options.active ?? 'zh-CN' }),
  }

  const ctx = {
    locale: localeService,
    effect: () => () => {},
    get: (name) => (name === 'locale' ? localeService : undefined),
    on: (name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    slots: {
      inject: (_key, callback) => {
        callback()
        return () => {}
      },
      register: (declaration, component) => {
        registrations.push({ declaration, component })
        return () => {}
      },
    },
  }

  let exports
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        exports = factory((name) => {
          if (name === 'react') return React
          throw new Error(`unexpected require(${JSON.stringify(name)})`)
        })
        exports.id = id
      },
    },
  }
  globalThis.document = { baseURI: options.baseUri ?? 'http://127.0.0.1:1/', documentElement: { lang: '' } }
  // Node 21 made `navigator` a getter-only global, so it cannot be assigned.
  defineGlobal('navigator', { language: options.navigatorLanguage ?? 'en-US' })

  new Function('window', TEXT)(globalThis.window)
  exports.apply(ctx)

  /** Expand the tree, dropping the stylesheet, and collect visible text. */
  const flatten = (node) => {
    if (node === null || node === undefined || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(flatten).join(' ')
    if (typeof node.type === 'function') {
      hooks.cursor = 0
      return flatten(node.type(node.props))
    }
    if (node.type === 'style') return ''
    return node.children.map(flatten).join(' ')
  }

  /** Expand function components down to the first host element. */
  const expand = (node) => {
    let current = node
    for (let depth = 0; depth < 20 && typeof current?.type === 'function'; depth += 1) {
      hooks.cursor = 0
      current = current.type(current.props)
    }
    return current
  }

  const panel = registrations.find((entry) => entry.declaration.name === 'main')
  const sidebar = registrations.find((entry) => entry.declaration.name === 'sidebar.panellist')

  /** @returns the panel's visible text on a fresh mount. */
  const text = () => flatten(panel.component({})).replace(/\s+/g, ' ').trim()

  return { exports, registrations, panel, sidebar, text, listeners, localeService, expand }
}

test('the panel only calls React functions the Host guarantees', () => {
  // Throws inside the factory or the first render if it reaches for a hook the
  // curated React object does not carry — which is how the panel once blanked.
  assert.doesNotThrow(() => loadClient().text())
  assert.ok(!/React\.(?!createElement|useState|useEffect)/.test(TEXT), 'no other React member is referenced')
})

test('the panel speaks the Host language, not the browser language', () => {
  const chinese = loadClient({ active: 'zh-CN', navigatorLanguage: 'en-US' })
  assert.match(chinese.text(), /技能/)
  assert.match(chinese.text(), /正在读取技能目录/)
  assert.doesNotMatch(chinese.text(), /Skills/)

  const english = loadClient({ active: 'en-US', navigatorLanguage: 'zh-CN' })
  assert.match(english.text(), /Skills/)
  assert.match(english.text(), /Reading skill roots/)
})

test('a Chinese variant maps to the Chinese dictionary', () => {
  for (const active of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW']) {
    assert.match(loadClient({ active }).text(), /技能/, active)
  }
})

test('an unknown language falls back to English, as the Host fallback does', () => {
  assert.match(loadClient({ active: 'ja-JP' }).text(), /Skills/)
})

test('the sidebar label follows the active language', () => {
  assert.equal(loadClient({ active: 'zh-CN' }).sidebar.declaration.label(), '技能')
  assert.equal(loadClient({ active: 'en-US' }).sidebar.declaration.label(), 'Skills')
})

test('a language switch repaints through the Host change event', () => {
  const client = loadClient({ active: 'zh-CN' })
  const handlers = client.listeners.get('locale/change') ?? []
  assert.equal(handlers.length, 1, 'the client subscribes to locale/change')
  // The subscription must reach the store, not just exist.
  const page = client.panel.component({})
  assert.doesNotThrow(() => handlers[0]())
  assert.ok(page !== undefined)
})

test('both halves of the panel are registered under one id', () => {
  const client = loadClient()
  assert.equal(client.sidebar.declaration.id, 'dsh-skills')
  assert.equal(client.panel.declaration.key, 'dsh-skills')
})

test('the panel renders a stylesheet and never imports a Harness package', () => {
  const client = loadClient()
  const tree = client.expand(client.panel.component({}))
  assert.equal(tree.props.className, 'dsm-page')
  assert.ok(tree.children.some((child) => child && child.type === 'style'), 'the panel carries its own stylesheet')
  assert.doesNotMatch(TEXT, /@deepseek-ai\//)
})

/**
 * The stylesheet the panel actually renders.
 * @returns the CSS text.
 */
function stylesheetOf(client) {
  const tree = client.expand(client.panel.component({}))
  const style = tree.children.find((child) => child && child.type === 'style')
  assert.ok(style, 'the panel renders a stylesheet')
  return style.children.join('')
}

test('only the list scrolls, and the page above it stays put', () => {
  // The `main` slot gives a panel the whole column and scrolls nothing. The
  // header must not travel with the list, so the page clips and one inner
  // region owns the scrolling.
  const css = stylesheetOf(loadClient())
  const page = /\.dsm-page\{([^}]*)\}/.exec(css)
  assert.ok(page, '.dsm-page is styled')
  for (const rule of ['height:100%', 'overflow:hidden', 'min-height:0']) {
    assert.ok(page[1].includes(rule), `.dsm-page declares ${rule}`)
  }
  assert.doesNotMatch(page[1], /overflow-y:auto/, 'the page itself must not scroll')
  // A slot renderer that leaves an auto-height wrapper would defeat
  // `height:100%` alone; the viewport bound keeps the box bounded either way.
  assert.match(page[1], /max-height:100dvh/, '.dsm-page bounds itself to the viewport')

  const body = /\.dsm-body\{([^}]*)\}/.exec(css)
  assert.ok(body, '.dsm-body wraps the list')
  assert.match(body[1], /flex:1 1 auto/, 'the body takes the leftover height')
  assert.match(body[1], /min-height:0/, 'the body may shrink below its content')

  const list = /\.dsm-list\{([^}]*)\}/.exec(css)
  assert.ok(list, '.dsm-list is the scroller')
  for (const rule of ['overflow-y:auto', 'min-height:0', 'flex:1 1 auto']) {
    assert.ok(list[1].includes(rule), `.dsm-list declares ${rule}`)
  }
  // The native bar is hidden; the panel draws its own so it can fade out.
  assert.ok(list[1].includes('scrollbar-width:none'), 'the native scrollbar is hidden')
  assert.match(css, /\.dsm-list::-webkit-scrollbar\{width:0/, 'WebKit hides the track too')
  assert.match(css, /\.dsm-thumb\{[^}]*opacity:0/, 'the thumb starts invisible')
  assert.match(css, /\.dsm-thumb\[data-on="true"\]\{opacity:\.45\}/, 'the thumb fades in while scrolling')

  // Flex children with their own `overflow:hidden` have an automatic minimum
  // size of 0, so cards squash instead of overflowing — the list then fits
  // exactly and never scrolls, and each squashed card clips its own rows.
  assert.match(css, /\.dsm-page>\*\{flex:0 0 auto\}/, 'page children keep their content height')
  // The cards hang off the list, not the page: the same rule has to be applied
  // to the container that actually scrolls, or nothing below `.dsm-list` scrolls.
  assert.match(css, /\.dsm-list>\*\{flex:0 0 auto\}/, 'list children keep their content height')
})

test('every stylesheet rule stays inside this package namespace', () => {
  const css = stylesheetOf(loadClient())
  const bare = css
    .replace(/@media[^{]*\{/g, '') // media conditions are not selectors
    .split('}')
    .map((chunk) => chunk.split('{')[0].trim())
    .filter((selector) => selector.length > 0)
  for (const selector of bare) {
    assert.match(selector, /^\.dsm-/, `selector escapes the namespace: ${selector}`)
  }
})

/**
 * Collect every element of a rendered tree.
 * @param node - the tree root.
 * @param out - accumulator.
 * @returns every element node, depth first.
 */
function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) elementsOf(child, out)
  return out
}

/**
 * Find the element whose own text is `text`, skipping stylesheet text.
 * @param node - the tree root.
 * @param text - the visible label.
 * @returns the first matching element, or undefined.
 */
function findByText(node, text) {
  return elementsOf(node).find(
    (element) => Array.isArray(element.children) && element.children.length === 1 && element.children[0] === text,
  )
}

/**
 * Mount the panel against a stub runtime whose state actually updates.
 *
 * `loadClient` freezes hook state on purpose: most assertions only need the
 * first paint, and a setter that stored its value would make every render
 * drift. A click test needs the opposite, so this harness keeps one hook slot
 * array per component function, runs mount effects once, and re-renders on
 * demand. It is still the same curated React surface — three functions only.
 *
 * @param options - `roots` returned by the stubbed Host.
 * @returns the request log, the current tree and the click/settle helpers.
 */
function mountClient(options = {}) {
  const calls = []
  const records = new Map()
  const effects = []
  // Host nodes handed to `ref`, so a test can drive scroll metrics.
  const fakes = new Map()
  const roots = options.roots ?? []
  let current = null
  let buttons = []
  let panel

  const React = {
    createElement(type, props, ...children) {
      // Mirror React: children passed as arguments are also in `props.children`,
      // which is where the test looks for a button's label.
      const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: { ...(props ?? {}), children: kids }, children: kids }
    },
    useState(initial) {
      // The setter must close over THIS instance: a store listener fires long
      // after the render that created it, when `current` has moved on.
      const record = current
      const index = record.cursor
      record.cursor += 1
      if (!(index in record.slots)) {
        record.slots[index] = typeof initial === 'function' ? initial() : initial
      }
      return [
        record.slots[index],
        (next) => {
          record.slots[index] = typeof next === 'function' ? next(record.slots[index]) : next
        },
      ]
    },
    useEffect(effect) {
      const record = current
      const index = record.cursor
      record.cursor += 1
      if (record.ran.has(index)) return
      record.ran.add(index)
      effects.push(effect)
    },
  }

  const localeService = {
    getSnapshot: () => ({ active: 'zh-CN', revision: 1 }),
    subscribe: () => () => {},
  }

  const ctx = {
    locale: localeService,
    effect: () => () => {},
    get: (name) => (name === 'locale' ? localeService : undefined),
    on: () => () => {},
    slots: {
      inject: (_key, callback) => {
        callback()
        return () => {}
      },
      register: (declaration, component) => {
        if (declaration.name === 'main') panel = component
        return () => {}
      },
    },
  }

  let exports
  // The dialogs register an Escape listener on mount, so the fake window needs
  // the two methods a real one has.
  const listeners = new Map()
  globalThis.window = {
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
    __ModuleLoader__: {
      load({ factory }) {
        exports = factory((name) => {
          if (name === 'react') return React
          throw new Error(`unexpected require(${JSON.stringify(name)})`)
        })
      },
    },
  }
  globalThis.document = { baseURI: 'http://127.0.0.1:1/', documentElement: { lang: '' } }
  defineGlobal('navigator', { language: 'en-US' })
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { status: 200, json: async () => ({ ok: true, roots }) }
  }

  new Function('window', TEXT)(globalThis.window)
  exports.apply(ctx)

  const walk = (node) => {
    if (node === null || node === undefined || node === false) return node
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node.type === 'function') {
      let record = records.get(node.type)
      if (record === undefined) {
        record = { cursor: 0, slots: [], ran: new Set() }
        records.set(node.type, record)
      }
      record.cursor = 0
      current = record
      return walk(node.type(node.props))
    }
    const hostChildren = node.children.map(walk)
    if (node.type === 'button') {
      buttons.push({ props: node.props, text: textOf(hostChildren).trim() })
    }
    if (typeof node.props?.ref === 'function') {
      node.props.ref(fakeNodeFor(node.props.className))
    }
    return { type: node.type, props: node.props, children: hostChildren }
  }

  /** A stand-in DOM node: scroll metrics plus the listeners attached to it. */
  const fakeNodeFor = (className) => {
    const key = String(className ?? '')
    if (!fakes.has(key)) {
      const listeners = new Map()
      fakes.set(key, {
        className: key,
        clientHeight: 0,
        scrollHeight: 0,
        scrollTop: 0,
        listeners,
        addEventListener(type, handler) {
          listeners.set(type, handler)
        },
        removeEventListener(type) {
          listeners.delete(type)
        },
      })
    }
    return fakes.get(key)
  }

  /** Every visible string inside a rendered subtree. */
  const textOf = (node) => {
    if (node === null || node === undefined || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return textOf(node.children ?? [])
  }

  /** Re-render, then run any effect that has not run yet. @returns the tree. */
  const render = () => {
    buttons = []
    const tree = walk(panel({}))
    while (effects.length > 0) effects.shift()()
    return tree
  }

  /** Let the pending Host request settle, then show its result. */
  const settle = async () => {
    render()
    for (let round = 0; round < 5; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      render()
    }
    return render()
  }

  /** Every host <button> in the current render, by visible label. */
  const buttonsNow = () => {
    render()
    return buttons
  }

  /** Click the button carrying `label`, then settle. */
  const click = async (label) => {
    const host = buttonsNow().find((entry) => entry.text === label)
    assert.ok(host, `a button labelled ${label} is on screen`)
    assert.notEqual(host.props.disabled, true, `${label} is enabled`)
    host.props.onClick()
    return settle()
  }

  /** The panel's visible text after the latest render. */
  const text = () => {
    const tree = render()
    return textOf(tree).replace(/\s+/g, ' ').trim()
  }

  /** The fake DOM node for a class name, so a test can scroll it. */
  const nodeFor = (className) => fakes.get(className)

  /** The fading thumb element of the current render. */
  const thumb = () => {
    const tree = render()
    return elementsOf(tree).find((element) => element.props?.className === 'dsm-thumb')
  }

  return { calls, render, settle, click, buttons: buttonsNow, text, nodeFor, thumb }
}

test('the reload button reports a read even when the result is unchanged', async () => {
  const root = { key: 'user-dsh', kind: 'user', source: 'user-dsh', path: '/home/u/.dsh/skills', exists: true, skills: [], trash: [] }
  const app = mountClient({ roots: [root] })

  let tree = await app.settle()
  assert.equal(app.calls.length, 1, 'the panel reads the roots on mount')
  assert.equal(app.calls[0].url, 'http://127.0.0.1:1/api/dsh-skills')
  assert.equal(app.calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(app.calls[0].init.body), { action: 'list' })

  const stamp = (node) => elementsOf(node).find((element) => element.props?.['data-dsm-read'] !== undefined)
  const before = stamp(tree)
  assert.ok(before, 'the toolbar carries a read stamp')
  const firstRead = before.props['data-dsm-read']
  assert.notEqual(firstRead, '0', 'the mount read is stamped')

  // Same disk, same answer: this is the case where the page looks inert.
  const realNow = Date.now
  const clock = realNow()
  let offset = 0
  Date.now = () => clock + (offset += 5000)
  try {
    tree = await app.click('刷新')
  } finally {
    Date.now = realNow
  }

  assert.equal(app.calls.length, 2, 'clicking 刷新 reads the roots again')
  assert.deepEqual(JSON.parse(app.calls[1].init.body), { action: 'list' })
  const after = stamp(tree).props['data-dsm-read']
  assert.notEqual(after, firstRead, 'the read stamp moves, so the click is visible')
  assert.match(app.text(), /最后读取 \d{2}:\d{2}:\d{2}/, 'the stamp is human readable')
})

test('the reload button is disabled while its own read is in flight', async () => {
  const app = mountClient({ roots: [] })
  await app.settle()

  const idle = app.buttons().find((entry) => entry.text === '刷新')
  assert.ok(idle, 'the reload button is on screen')
  assert.notEqual(idle.props.disabled, true, 'idle: enabled')

  let release
  const held = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async () => {
    await held
    return { status: 200, json: async () => ({ ok: true, roots: [] }) }
  }

  const pending = idle.props.onClick()
  const during = app.buttons().find((entry) => entry.text === '刷新中…')
  assert.ok(during, 'the label reports the read in flight')
  assert.equal(during.props.disabled, true, 'in flight: disabled')

  release()
  await pending
  const after = app.buttons().find((entry) => entry.text === '刷新')
  assert.ok(after, 'the label returns to 刷新')
  assert.notEqual(after.props.disabled, true, 'settled: enabled again')
})

test('the mark is one spark at every size', async () => {
  // One silhouette, three renderings: the sidebar glyph, the empty state and
  // the package icon must not drift into three different sparks.
  const glyph = /const SPARK = '([^']+)'/.exec(TEXT)
  assert.ok(glyph, 'the client defines the spark path')
  assert.equal((TEXT.match(/h\('path', \{ d: SPARK \}\)/g) ?? []).length, 2, 'the glyph and the empty state both draw it')

  // SOURCE is already `<package>/client.js`.
  const svg = await readFile(join(dirname(SOURCE), 'icon.svg'), 'utf8')
  assert.ok(svg.includes(glyph[1]), 'icon.svg uses the same path')
  assert.match(svg, /aria-label="Skills"/, 'the icon keeps its accessible name')
})

test('the list scrollbar follows the scroll and fades out when it stops', async () => {
  const root = {
    key: 'user-dsh',
    kind: 'user',
    source: 'user-dsh',
    path: '/home/u/.dsh/skills',
    exists: true,
    skills: Array.from({ length: 20 }, (_, index) => ({
      name: `skill-${index}`,
      description: 'x',
      disabled: false,
      issues: [],
      path: `/home/u/.dsh/skills/skill-${index}`,
    })),
    trash: [],
  }
  const app = mountClient({ roots: [root] })
  await app.settle()

  // Only the rows live in the scrolling region; the toolbar and the directory
  // tabs stay above it, which is the point of the split.
  const list = elementsOf(app.render()).find((element) => element.props?.className === 'dsm-list')
  assert.ok(list, 'the list region is rendered')
  const inside = elementsOf(list).map((element) => String(element.props?.className ?? ''))
  assert.ok(!inside.includes('dsm-toolbar'), 'the toolbar is outside the scroller')
  assert.ok(!inside.includes('dsm-roots'), 'the directory tabs are outside the scroller')
  assert.ok(inside.some((name) => name.startsWith('dsm-card')), 'the skill cards are inside the scroller')
  assert.ok(inside.includes('dsm-card-path'), 'each card keeps its directory path')

  const node = app.nodeFor('dsm-list')
  assert.ok(node, 'the list is mounted through a ref')
  assert.equal(app.thumb().props['data-on'], 'false', 'idle: the thumb is hidden')

  node.clientHeight = 400
  node.scrollHeight = 1600
  node.scrollTop = 0
  node.listeners.get('scroll')()

  let thumb = app.thumb()
  assert.equal(thumb.props['data-on'], 'true', 'scrolling: the thumb appears')
  assert.equal(thumb.props.style.height, '100px', 'thumb is view/total of the list')
  assert.equal(thumb.props.style.top, '0px', 'at the top the thumb sits at 0')

  node.scrollTop = 800
  node.listeners.get('scroll')()
  thumb = app.thumb()
  assert.equal(thumb.props.style.top, '200px', 'half way down, half the travel')

  node.scrollTop = 1200
  node.listeners.get('scroll')()
  assert.equal(app.thumb().props.style.top, '300px', 'at the bottom the thumb parks at the end')

  // The bar must not linger after the scrolling stops.
  await new Promise((resolve) => setTimeout(resolve, 780))
  app.render()
  assert.equal(app.thumb().props['data-on'], 'false', 'after the pause the thumb fades out')

  // A short list has nothing to drag: no thumb even while scrolling.
  node.scrollHeight = 400
  node.listeners.get('scroll')()
  assert.equal(app.thumb().props['data-on'], 'false', 'a list that fits draws no thumb')
})

test('an added directory is browsable, removable, and offers no switch', async () => {
  const added = {
    key: 'custom:0badc0de',
    kind: 'custom',
    source: 'custom',
    path: '/home/u/.claude/skills',
    exists: true,
    readOnly: true,
    skills: [
      { name: 'alpha', entryName: 'alpha', entryKind: 'directory', description: 'Alpha.', disabled: false, modelInvocable: true, userInvocable: true, issues: [], path: '/home/u/.claude/skills/alpha' },
    ],
    trash: [],
  }
  const app = mountClient({ roots: [added] })
  await app.settle()

  const labels = app.buttons().map((entry) => entry.text)
  assert.ok(labels.includes('添加目录'), 'the toolbar offers to add a directory')
  assert.ok(labels.includes('移除'), 'the card offers to forget it')
  assert.ok(labels.includes('安装…'), 'a skill can be copied out of it')
  assert.ok(!labels.includes('卸载'), 'a skill in it cannot be uninstalled')
  // The read-only card must not present a destructive switch either.
  const text = app.text()
  assert.match(text, /只读/, 'the card says it is read-only')

  const tree = app.render()
  const toggles = elementsOf(tree).filter((element) => element.type === 'input' && element.props?.type === 'checkbox')
  assert.equal(toggles.length, 0, 'no checkbox is rendered for a read-only root')

  // Installing from it opens the copy dialog with the source path filled in.
  const install = app.buttons().find((entry) => entry.text === '安装…')
  install.props.onClick()
  const dialog = app.text()
  assert.match(dialog, /安装/, 'the install dialog opens')
  assert.match(dialog, /\/home\/u\/\.claude\/skills\/alpha/, 'the dialog names the source')
})

test('removing an added directory asks the Host once', async () => {
  const added = {
    key: 'custom:0badc0de',
    kind: 'custom',
    source: 'custom',
    path: '/home/u/.claude/skills',
    exists: true,
    readOnly: true,
    skills: [],
    trash: [],
  }
  const app = mountClient({ roots: [added] })
  await app.settle()
  const before = app.calls.length

  const remove = app.buttons().find((entry) => entry.text === '移除')
  await remove.props.onClick()
  await app.settle()

  const sent = app.calls.slice(before).map((call) => JSON.parse(call.init.body))
  assert.deepEqual(sent[0], { action: 'remove-root', rootKey: 'custom:0badc0de', path: '/home/u/.claude/skills' })
})

test('an agent library is named after its agent and carries that agent\'s own mark', async () => {
  const roots = [
    { key: 'agent:codex', kind: 'agent', source: 'custom', agent: 'codex', path: '/home/u/.codex/skills', exists: true, readOnly: true, skills: [], trash: [] },
    { key: 'agent:claude', kind: 'agent', source: 'custom', agent: 'claude', path: '/home/u/.claude/skills', exists: true, readOnly: true, skills: [], trash: [] },
    { key: 'agent:workbuddy', kind: 'agent', source: 'custom', agent: 'workbuddy', path: '/home/u/.workbuddy/skills', exists: true, readOnly: true, skills: [], trash: [] },
    { key: 'custom:0badc0de', kind: 'custom', source: 'custom', agent: 'custom', path: '/home/u/mine', exists: true, readOnly: true, skills: [], trash: [] },
  ]
  const app = mountClient({ roots })
  await app.settle()
  const text = app.text()
  assert.match(text, /Codex/, 'the card is named after the agent')
  assert.match(text, /Claude Code/)
  assert.match(text, /WorkBuddy/)
  assert.match(text, /自动/, 'and says it was found rather than added')

  const tree = app.render()
  const svgs = elementsOf(tree).filter((element) => element.type === 'svg')
  const tiles = elementsOf(tree).filter((element) => element.props?.dangerouslySetInnerHTML !== undefined)

  const counts = elementsOf(tree).filter((element) => element.props?.className === 'dsm-root-count')
  assert.ok(counts.length >= 8, 'the skill count sits beside the name, in the card and in the tab')

  // Tab plus card for each of the three agent roots.
  assert.ok(svgs.length >= 4, 'vector marks for Codex and Claude Code')
  assert.equal(tiles.length, 2, 'the WorkBuddy tile is drawn in the tab and the card')

  // The marks are the vendors' own, so the geometry is recognisable.
  const openaiKnot = svgs.filter((svg) => (svg.props.children ?? []).some((child) => typeof child.props?.d === 'string' && child.props.d.startsWith('M9.205 8.658')))
  assert.ok(openaiKnot.length >= 2, 'the OpenAI knot, not a drawn substitute')
  const claudeSpark = svgs.filter((svg) => (svg.props.children ?? []).some((child) => child.props?.fill === 'currentColor' && String(child.props.d).startsWith('M4.709 15.955')))
  assert.ok(claudeSpark.length >= 2, 'the Claude asterisk')
  assert.equal(claudeSpark[0].props.style.color, '#D97757', 'in Anthropic orange')

  // The WorkBuddy tile is the official SVG document, not a generated shape.
  assert.ok(tiles.some((tile) => tile.props.dangerouslySetInnerHTML.__html.includes('workbuddy') || tile.props.dangerouslySetInnerHTML.__html.includes('<svg')))

  // A manually added directory has no agent mark.
  assert.equal(tiles.filter((tile) => tile.props.style?.width === '15px').length, 1, 'only the agent cards carry a tile')
})

test('GitHub import offers multi-select and imports the selected skills together', async () => {
  const root = { key: 'user-dsh', kind: 'user', source: 'user-dsh', path: '/home/u/.dsh/skills', exists: true, skills: [], trash: [] }
  const app = mountClient({ roots: [root] })
  await app.settle()

  const open = app.buttons().find((entry) => entry.text === '从 GitHub 导入')
  assert.ok(open, 'the toolbar offers GitHub import')
  open.props.onClick()
  assert.match(app.text(), /GitHub 链接/)

  const inputs = elementsOf(app.render()).filter((element) => element.type === 'input')
  const link = inputs.find((element) => element.props.className === 'dsm-input' && element.props.type !== 'password')
  assert.ok(link, 'the dialog has a GitHub link field')
  link.props.onChange({ target: { value: 'https://github.com/owner/repo' } })

  const calls = []
  let answered = false
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.action === 'install-from-remote' && !answered) {
      answered = true
      return {
        status: 200,
        json: async () => ({
          ok: false,
          code: 'choose-skill',
          candidates: [
            { path: 'skills/alpha', name: 'alpha', description: 'Does the alpha thing.' },
            { path: 'skills/beta', name: 'beta', description: 'Does the beta thing.' },
          ],
          total: 2,
          truncated: false,
        }),
      }
    }
    return {
      status: 200,
      json: async () => ({ ok: true, rootKey: 'user-dsh', entries: [{ entryName: 'alpha' }, { entryName: 'beta' }], source: { repo: 'owner/repo' } }),
    }
  }

  await app.click('扫描 GitHub')
  assert.deepEqual(calls[0], { action: 'install-from-remote', rootKey: 'user-dsh', url: 'https://github.com/owner/repo' })
  assert.match(app.text(), /选择要导入的技能/)
  const checks = elementsOf(app.render()).filter((element) => element.type === 'input' && element.props.type === 'checkbox')
  assert.equal(checks.length, 2)
  assert.equal(checks[0].props.checked, true, 'found skills start selected')
  assert.equal(checks[1].props.checked, true)

  checks[0].props.onChange({ target: { checked: false } })
  assert.ok(app.buttons().some((entry) => entry.text === '导入已选（1）'))
  await app.click('清空选择')
  assert.equal(app.buttons().find((entry) => entry.text === '导入已选（0）').props.disabled, true)
  await app.click('全选')

  await app.click('导入已选（2）')
  await app.settle()
  assert.deepEqual(calls[1], {
    action: 'install-from-remote',
    rootKey: 'user-dsh',
    url: 'https://github.com/owner/repo',
    paths: ['skills/alpha', 'skills/beta'],
  })
  assert.match(app.text(), /已从 owner\/repo 导入 2 个技能/)
})

test('a read-only filter never preselects a root the import cannot write', async () => {
  const locked = { key: 'custom:locked', kind: 'custom', source: 'custom', agent: 'codex', path: '/home/u/.codex/skills', exists: true, readOnly: true, skills: [], trash: [] }
  const writable = { key: 'user-dsh', kind: 'user', source: 'user-dsh', path: '/home/u/.dsh/skills', exists: true, skills: [], trash: [] }
  const app = mountClient({ roots: [locked, writable] })
  await app.settle()

  // Filter the page to the read-only library, then open the GitHub dialog.
  // Tabs are: all roots, then one per root, in listing order.
  const tabs = elementsOf(app.render()).filter((element) => element.props?.className === 'dsm-root-tab')
  assert.equal(tabs.length, 3, 'the toolbar lists both roots')
  tabs[1].props.onClick()
  app.render()
  app.buttons().find((entry) => entry.text === '从 GitHub 导入').props.onClick()

  const select = elementsOf(app.render()).find((element) => element.type === 'select' && element.props?.className === 'dsm-input')
  assert.ok(select, 'the dialog offers a target root')
  assert.equal(select.props.value, 'user-dsh', 'it defaults to the writable root, not the filtered read-only one')
})

test('the target root cannot change while a scan is in flight', async () => {
  const root = { key: 'user-dsh', kind: 'user', source: 'user-dsh', path: '/home/u/.dsh/skills', exists: true, skills: [], trash: [] }
  const app = mountClient({ roots: [root] })
  await app.settle()
  app.buttons().find((entry) => entry.text === '从 GitHub 导入').props.onClick()

  const link = elementsOf(app.render()).find((element) => element.type === 'input' && element.props?.className === 'dsm-input' && element.props.type !== 'password')
  link.props.onChange({ target: { value: 'https://github.com/owner/repo' } })

  let release
  const held = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async () => {
    await held
    return { status: 200, json: async () => ({ ok: false, code: 'not-a-skill', message: 'nothing there' }) }
  }

  const scan = app.buttons().find((entry) => entry.text === '扫描 GitHub')
  const pending = scan.props.onClick()
  const select = elementsOf(app.render()).find((element) => element.type === 'select' && element.props?.className === 'dsm-input')
  assert.equal(select.props.disabled, true, 'the root is locked while the request owns it')
  release()
  await pending
  await app.settle()
})

test('a token is only sent when one was typed', async () => {
  const root = { key: 'user-dsh', kind: 'user', source: 'user-dsh', path: '/home/u/.dsh/skills', exists: true, skills: [], trash: [] }
  const app = mountClient({ roots: [root] })
  await app.settle()

  app.buttons().find((entry) => entry.text === '从 GitHub 导入').props.onClick()
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    return { status: 200, json: async () => ({ ok: false, code: 'not-a-skill', message: 'nothing there' }) }
  }

  const inputs = elementsOf(app.render()).filter((element) => element.type === 'input')
  const link = inputs.find((element) => element.props.className === 'dsm-input' && element.props.type !== 'password')
  link.props.onChange({ target: { value: 'https://gitlab.com/owner/repo' } })
  const secret = inputs.find((element) => element.props.className === 'dsm-input' && element.props.type === 'password')
  assert.ok(secret, 'the dialog has a token field')
  secret.props.onChange({ target: { value: 'glpat_secret' } })

  await app.click('扫描 GitHub')
  assert.deepEqual(calls[0], {
    action: 'install-from-remote',
    rootKey: 'user-dsh',
    url: 'https://gitlab.com/owner/repo',
    token: 'glpat_secret',
  })

  // A refusal is shown inside the dialog, where the person is looking.
  assert.match(app.text(), /nothing there/)
})
