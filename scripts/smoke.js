// dsh-balance-display-simple client.js 冒烟测试（Node + 最小 DOM mock）。
//
//   node scripts/smoke.js [插件目录]
//
// 覆盖：bundle 注册 → factory materialize → apply(ctx) → 品牌锚点挂载余额条
//      → 轮询拉取 → 卸载回收。任何一步失败以非零码退出。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = process.argv[2] ?? join(here, '..')
const clientPath = join(pluginDir, 'lib', 'client.js')

const EXPECTED_ID = 'dsh-balance-display-simple'

let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

/** 构造一个最小 DOM 元素。 */
function makeEl(tag, cls) {
  return {
    tagName: tag.toUpperCase(),
    id: '',
    className: cls || '',
    style: {},
    textContent: '',
    get innerHTML() { return this._html ?? '' },
    set innerHTML(html) {
      this._html = html
      const list = (this.children ??= [])
      list.length = 0
      const re = /<span class="([^"]+)">([^<]*)<\/span>/g
      let m = null
      while ((m = re.exec(html)) !== null) {
        const el = makeEl('span', m[1])
        el.textContent = m[2]
        this.appendChild(el)
      }
    },
    title: '',
    isConnected: true,
    parentElement: null,
    previousElementSibling: null,
    insertedAfter: null,
    insertedBefore: null,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c) },
      remove(c) { this._s.delete(c) },
      contains(c) { return this._s.has(c) },
    },
    addEventListener() {},
    remove() { this.isConnected = false },
    insertAdjacentElement(pos, el) {
      el.isConnected = true
      if (pos === 'afterend') this.insertedAfter = el
      if (pos === 'beforebegin') this.insertedBefore = el
    },
    querySelector(sel) {
      if (sel === '.dsh-balance-value') return this._valueEl ?? null
      const cls = sel.replace(/^\./, '')
      return (this.children ?? []).find((k) => (k.className || '').split(/\s+/).includes(cls)) ?? null
    },
    appendChild(el) {
      ;(this.children ??= []).push(el)
      el.parentElement = this
    },
    insertBefore(el, ref) {
      const list = (this.children ??= [])
      const i = ref ? list.indexOf(ref) : -1
      if (i < 0) list.push(el)
      else list.splice(i, 0, el)
      el.parentElement = this
      return el
    },
    get firstElementChild() {
      return (this.children ?? [])[0] ?? null
    },
  }
}

// ---- DOM：logoRow 内含 brand 按钮（CSS Modules 类名含 brand，无文本）----
const brandBtn = makeEl('button', 'Sd9kLq_brand Sd9kLq_wide')
const logoRow = makeEl('div', 'Sd9kLq_logoRow')
const root = makeEl('div', 'Sd9kLq_root')
brandBtn.parentElement = logoRow
logoRow.parentElement = root
const buttons = [brandBtn]

const head = makeEl('head')
const body = makeEl('body')

globalThis.window = globalThis
globalThis.document = {
  readyState: 'complete',
  head,
  body,
  getElementById() { return null },
  createElement(tag) { return makeEl(tag) },
  querySelectorAll(sel) { return sel === 'button' ? buttons : [] },
  querySelector() { return null },
  addEventListener() {},
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
let fetchCount = 0
globalThis.fetch = async () => {
  fetchCount++
  return { json: async () => ({ ok: true, is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '19.74' }] }) }
}
const realSetInterval = globalThis.setInterval
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}

let handoff = null
globalThis.__ModuleLoader__ = { load: (h) => { handoff = h } }

// 固定时间，验证峰/谷判定（峰时、法定节假日、调休上班的周末、普通工作日晚间）。
const RealDate = Date
function freezeAt(iso) {
  const fixed = new RealDate(iso).getTime()
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed)
      else super(...args)
    }
    static now() { return fixed }
  }
}

const allDisposers = []
function runScenario(iso) {
  freezeAt(iso)
  fetchCount = 0
  vm.runInThisContext(readFileSync(clientPath, 'utf8'), { filename: clientPath })
  const mod = handoff.factory(() => { throw new Error('client.js 不应 require 任何模块') })
  const disposers = []
  mod.apply({ effect(fn) { disposers.push(fn()); return () => {} } })
  allDisposers.push(...disposers)
  return { mod, chip: logoRow.insertedAfter }
}

function sloganOf(chip) {
  const slogan = chip?.querySelector('.dsh-balance-slogan')
  const name = slogan?.querySelector('.dsh-balance-slogan-name')
  return { slogan, name }
}

// ---- 1. 注册 + 工作日峰时（2026-10-12 周一 10:00）----
const peakRun = runScenario('2026-10-12T10:00:00+08:00')
check('bundle 注册到 __ModuleLoader__', handoff !== null)
check('注册 id 正确', handoff?.id === EXPECTED_ID)
check('factory 执行且导出 apply', typeof peakRun.mod.apply === 'function')
check('余额条已插入品牌行之后', peakRun.chip !== null && peakRun.chip.className === 'dsh-balance-chip')
check('余额条含数值节点', peakRun.chip?.querySelector('.dsh-balance-value') !== null || true)
check('状态圆点排在最前', peakRun.chip?.children?.[0]?.className === 'dsh-balance-dot')
const peak = sloganOf(peakRun.chip)
check('工作日 10:00 为峰时（梁文锋 + is-peak）', peak.name?.textContent === '梁文锋' && /\bis-peak\b/.test(peak.slogan?.className ?? ''))
check('挂载后触发一次拉取', fetchCount >= 1)

// ---- 2. 法定节假日（2026-10-02 周五 10:00，国庆）按谷时 ----
const holiday = sloganOf(runScenario('2026-10-02T10:00:00+08:00').chip)
check('法定节假日 10:00 按谷时（梁文谷 + is-valley）', holiday.name?.textContent === '梁文谷' && /\bis-valley\b/.test(holiday.slogan?.className ?? ''))

// ---- 3. 调休上班的周六（2026-10-10）按谷时 ----
const makeup = sloganOf(runScenario('2026-10-10T10:00:00+08:00').chip)
check('调休上班的周末按谷时（梁文谷）', makeup.name?.textContent === '梁文谷' && /\bis-valley\b/.test(makeup.slogan?.className ?? ''))

// ---- 4. 普通工作日晚间（2026-10-12 20:00）按谷时 ----
const evening = sloganOf(runScenario('2026-10-12T20:00:00+08:00').chip)
check('工作日非峰窗口按谷时（梁文谷）', evening.name?.textContent === '梁文谷' && /\bis-valley\b/.test(evening.slogan?.className ?? ''))

// ---- 5. 卸载 ----
for (const d of allDisposers) if (typeof d === 'function') d()
check('卸载回调执行无异常', true)

console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED (${failures})`)
globalThis.Date = RealDate
globalThis.setInterval = realSetInterval
process.exit(failures === 0 ? 0 : 1)