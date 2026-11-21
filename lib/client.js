// dsh-balance-display-simple —— Client 半区（浏览器 / Electron 渲染进程）。
//
// 在侧边栏顶部品牌行（deepseek 标题）下方注入余额条，轮询同源端点
// /api/deepseek-balance-simple（Host 半区代理 DeepSeek 官方余额接口，浏览器不接触 API Key）。
//
// 模块只导出 apply/inject；所有 DOM 副作用都发生在 apply 内，随插件 fiber 卸载回收。
window.__ModuleLoader__.load({
  id: 'dsh-balance-display-simple',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ============ 配置 ============
    const ENDPOINT = '/api/deepseek-balance-simple'
    const REFRESH_MS = 60000 // 实时轮询间隔：60s
    const CHIP_ID = 'dsh-balance-display-simple-chip'
    const CSS_ID = 'dsh-balance-display-simple-style'
    const DEBUG_ID = 'dsh-balance-display-simple-debug'
    // 余额条右侧的补充文字（凑齐行宽、和上方 logo 行对齐）。
    // 用户的梗：DeepSeek 按峰谷计价 —— 峰时「梁文锋」，谷时「梁文谷」。
    const SLOGAN_PREFIX = '此时是'
    const SLOGAN_SUFFIX = '时段'
    const PEAK_NAME = '梁文锋'
    const VALLEY_NAME = '梁文谷'
    // 2026-08-17 起的峰谷规则（2026-09-19 DeepSeek 明确口径）：
    //   峰时 = 周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00，北京时间；
    //   其余所有时间 —— 含周末全天、法定节假日全天、调休上班的周末 —— 都是谷时，谷价是峰价一半。
    const PEAK_WINDOWS = [
      [9 * 60, 12 * 60],
      [14 * 60, 18 * 60],
    ]
    // 中国法定节假日放假日期（国务院办公厅通知：2026 年国办发明电〔2025〕7 号、
    // 2027 年国办发明电〔2026〕10 号）。落在周末的日期不必列，但一并写下便于逐年核对；
    // 调休上班的周末 DeepSeek 也按谷时，所以周末规则不做例外。每年国务院发通知后更新一次。
    const HOLIDAY_DATES = new Set([
      // 2026
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
      // 2027
      '2027-01-01', '2027-01-02', '2027-01-03',
      '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
      '2027-04-03', '2027-04-04', '2027-04-05',
      '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
      '2027-06-09',
      '2027-09-15',
      '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
    ])

    // ============ 模块级状态 ============
    let chip = null // 余额条 DOM 节点
    let anchor = null // 品牌按钮（deepseek 标题）节点
    let timer = null // 轮询定时器
    let lastValue = null // 最近一次成功值，失败时保留展示
    let everMounted = false // 是否成功挂载过（决定调试条显隐）

    // ============ 样式（跟随主题语义变量，缺省值兜底暗色） ============
    function ensureStyle() {
      if (document.getElementById(CSS_ID) !== null) return
      const style = document.createElement('style')
      style.id = CSS_ID
      style.textContent = `
        #${CHIP_ID} {
          box-sizing: border-box;
          flex: none;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 5px;
          margin: 0 2px 8px;
          padding: 0 2px;
          background: transparent;
          border: none;
          color: var(--dsw-alias-label-primary, #e8e8e8);
          font-size: 12px;
          line-height: 18px;
          cursor: pointer;
          user-select: none;
          min-width: 0;
          overflow: hidden;
          opacity: .85;
          transition: opacity .15s ease;
        }
        #${CHIP_ID}:hover { opacity: 1; }
        #${CHIP_ID} .dsh-balance-label {
          flex: none;
          color: var(--dsw-alias-label-secondary, #9aa0a6);
          white-space: nowrap;
        }
        #${CHIP_ID} .dsh-balance-value {
          flex: none;
          min-width: 0;
          text-align: left;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #${CHIP_ID} .dsh-balance-dot {
          flex: none;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #9aa0a6;
        }
        #${CHIP_ID}.dsh-balance-ok .dsh-balance-dot { background: #34c759; }
        #${CHIP_ID}.dsh-balance-bad .dsh-balance-dot { background: #ff3b30; }
        #${CHIP_ID}.dsh-balance-error .dsh-balance-dot { background: #ff9f0a; }
        #${CHIP_ID} .dsh-balance-slogan {
          flex: 0 1 auto;
          min-width: 0;
          margin-left: 0;
          padding-left: 2px;
          color: var(--dsw-alias-label-secondary, #9aa0a6);
          font-size: 11px;
          line-height: 16px;
          opacity: .9;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #${CHIP_ID} .dsh-balance-slogan-name {
          margin: 0 5px;
          color: #8d94a4;
          font-size: 17px;
          font-weight: 700;
          line-height: 18px;
        }
        /* 谷时（梁文谷）：明亮、活络 */
        #${CHIP_ID} .dsh-balance-slogan.is-valley { opacity: 1; }
        #${CHIP_ID} .dsh-balance-slogan.is-valley .dsh-balance-slogan-name {
          color: #34c759;
          text-shadow: 0 0 8px rgba(52, 199, 89, 0.55);
        }
        /* 峰时（梁文锋）：灰暗、收敛 */
        #${CHIP_ID} .dsh-balance-slogan.is-peak { opacity: .58; }
        #${CHIP_ID} .dsh-balance-slogan.is-peak .dsh-balance-slogan-name {
          color: #8d94a4;
          font-weight: 600;
          text-shadow: none;
        }
      `
      document.head.appendChild(style)
    }

    // ============ 调试条（挂载失败时可见，便于定位问题） ============
    function ensureDebug(message) {
      if (everMounted) {
        const bar = document.getElementById(DEBUG_ID)
        if (bar !== null) bar.remove()
        return
      }
      if (document.body === null) return
      let bar = document.getElementById(DEBUG_ID)
      if (bar === null) {
        bar = document.createElement('div')
        bar.id = DEBUG_ID
        bar.style.cssText =
          'position:fixed;top:8px;right:8px;z-index:99999;max-width:340px;padding:6px 10px;' +
          'border-radius:8px;background:#7a1f1f;color:#fff;' +
          'font:12px/16px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);' +
          'white-space:pre-wrap;word-break:break-all;'
        document.body.appendChild(bar)
      }
      bar.textContent = 'DSH 余额条未挂载: ' + message
    }

    // ============ 锚点查找 ============
    // 品牌按钮：CSS Modules 类名含 brand（内容可能只有 SVG 图标，不能依赖文本）。
    // 兜底：新会话按钮（类名含 newSession），插到它前面。
    function findAnchor() {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        const cls = typeof btn.className === 'string' ? btn.className : ''
        if (cls.indexOf('brand') !== -1) return btn
      }
      for (const btn of buttons) {
        const cls = typeof btn.className === 'string' ? btn.className : ''
        if (cls.indexOf('newSession') !== -1) return btn
      }
      return null
    }

    function isBrandButton(btn) {
      const cls = typeof btn.className === 'string' ? btn.className : ''
      return cls.indexOf('brand') !== -1
    }

    function currencySymbol(currency) {
      const map = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$' }
      return map[currency] || currency
    }

    function formatBalance(info) {
      const amount = Number(info && info.total_balance)
      const value = Number.isFinite(amount) ? amount.toFixed(2) : '—'
      return `${currencySymbol(info && info.currency)}${value}`
    }

    // ============ 峰 / 谷时段 ============
    // 北京时间 = UTC+8。周末全天谷时；工作日只在峰时窗口里算峰时。
    function beijingDateKey(date) {
      const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
      const pad = (n) => String(n).padStart(2, '0')
      return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    }

    function isHolidayToday() {
      return HOLIDAY_DATES.has(beijingDateKey(new Date()))
    }

    function isValleyNow() {
      const now = new Date()
      const minutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % 1440
      const weekday = (now.getUTCDay() + 6) % 7 // 0 = 周一 … 6 = 周日
      if (weekday >= 5) return true // 周末（含调休上班的周末）全谷时
      if (isHolidayToday()) return true // 法定节假日全谷时
      return !PEAK_WINDOWS.some((w) => minutes >= w[0] && minutes < w[1])
    }



    // ============ 状态渲染 ============
    function setState(mode, text) {
      if (chip === null) return
      const valueEl = chip.querySelector('.dsh-balance-value')
      if (valueEl !== null) valueEl.textContent = text
      chip.classList.remove('dsh-balance-ok', 'dsh-balance-bad', 'dsh-balance-error')
      if (mode !== '') chip.classList.add('dsh-balance-' + mode)
    }

    async function refresh() {
      if (chip === null) return
      setState('', lastValue !== null ? lastValue : '查询中…')
      try {
        const resp = await fetch(ENDPOINT, { cache: 'no-store' })
        const data = await resp.json()
        if (data === null || typeof data !== 'object' || data.ok !== true) {
          setState('error', '获取失败')
          return
        }
        const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
        const text = infos.length > 0 ? infos.map(formatBalance).join(' · ') : '—'
        lastValue = text
        setState(data.is_available === false ? 'bad' : 'ok', text)
      } catch (err) {
        setState('error', '获取失败')
      }
      updateSlogan()
    }

    // ============ 挂载 / 重挂 ============
    // 侧边栏折叠（rail）时隐藏余额条。
    function applyCollapsed() {
      if (chip === null || anchor === null) return
      let node = anchor.parentElement
      while (node !== null && node !== document.body) {
        const cls = typeof node.className === 'string' ? node.className : ''
        if (cls.indexOf('collapsed') !== -1) {
          chip.style.display = 'none'
          return
        }
        node = node.parentElement
      }
      chip.style.display = ''
    }

    // 余额条右侧的时段文字：幂等补齐（热重载时旧节点里可能没有它）。
    // 结构：此时是 [梁文谷] 时段 —— 中间的名字单独成 span，红色、加大。
    function ensureSlogan(node) {
      let slogan = node.querySelector('.dsh-balance-slogan')
      if (slogan === null) {
        slogan = document.createElement('span')
        slogan.className = 'dsh-balance-slogan'
        const prefix = document.createElement('span')
        prefix.className = 'dsh-balance-slogan-prefix'
        prefix.textContent = SLOGAN_PREFIX
        const name = document.createElement('span')
        name.className = 'dsh-balance-slogan-name'
        const suffix = document.createElement('span')
        suffix.className = 'dsh-balance-slogan-suffix'
        suffix.textContent = SLOGAN_SUFFIX
        slogan.appendChild(prefix)
        slogan.appendChild(name)
        slogan.appendChild(suffix)
        node.appendChild(slogan)
      }
      updateSlogan(slogan)
    }

    // 每次刷新时跟着改文案，跨过峰时/谷时边界不用重启。
    function updateSlogan(root) {
      const target = root === undefined ? chip : root
      if (target === null || target === undefined) return
      const isSlogan = typeof target.className === 'string' && target.className.split(/\s+/).includes('dsh-balance-slogan')
      const slogan = isSlogan ? target : target.querySelector('.dsh-balance-slogan')
      if (slogan === null) return
      const valley = isValleyNow()
      slogan.className = 'dsh-balance-slogan ' + (valley ? 'is-valley' : 'is-peak')
      const name = slogan.querySelector('.dsh-balance-slogan-name')
      if (name !== null) name.textContent = valley ? VALLEY_NAME : PEAK_NAME
    }

    function mount() {
      // 幂等：DOM 里已有余额条就不再插入（插件被加载两次时只保留一条）。
      const existing = document.getElementById(CHIP_ID)
      if (existing !== null) {
        chip = existing
        everMounted = true
        applyCollapsed()
        ensureSlogan(chip)
        ensureDebug(null)
        return true
      }
      const found = findAnchor()
      if (found === null) return false
      const row = found.parentElement
      if (row === null) return false
      anchor = found
      if (chip !== null && chip.isConnected) {
        if (row.contains(chip) || found.previousElementSibling === chip) {
          applyCollapsed()
          return true
        }
        chip.remove()
      }
      chip = document.createElement('div')
      chip.id = CHIP_ID
      chip.className = 'dsh-balance-chip'
      chip.title = 'DeepSeek API 余额（点击立即刷新）'
      chip.innerHTML =
        '<span class="dsh-balance-label">API 余额</span>' +
        '<span class="dsh-balance-value">查询中…</span>' +
        '<span class="dsh-balance-dot"></span>'
      ensureSlogan(chip)
      chip.addEventListener('click', () => {
        refresh()
      })
      if (isBrandButton(found)) {
        // 品牌行（logoRow）之后、新会话按钮之前
        row.insertAdjacentElement('afterend', chip)
      } else {
        // 兜底：插到新会话按钮之前
        found.insertAdjacentElement('beforebegin', chip)
      }
      applyCollapsed()
      refresh()
      everMounted = true
      ensureDebug(null)
      return true
    }

    function ensure() {
      if (document.body === null) return
      // 幂等入口：DOM 中已存在余额条时直接复用，不重复插入。
      const existing = document.getElementById(CHIP_ID)
      if (existing !== null) {
        chip = existing
        everMounted = true
        applyCollapsed()
        ensureSlogan(chip)
        ensureDebug(null)
        return
      }
      if (chip !== null && chip.isConnected) {
        applyCollapsed()
        ensureSlogan(chip)
        return
      }
      if (mount()) return
      const total = document.querySelectorAll('button').length
      if (total > 0) ensureDebug('未找到品牌/新会话锚点（button 共 ' + total + ' 个）')
    }

    // ============ 启动 ============
    let scheduled = false
    let observer = null

    function start() {
      ensureStyle()
      ensure()
      if (observer === null) {
        observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          setTimeout(() => {
            scheduled = false
            ensure()
          }, 300)
        })
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        })
      }
      if (timer === null) timer = setInterval(refresh, REFRESH_MS)
    }

    function apply(ctx) {
      ctx.effect(() => {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', start, { once: true })
        } else {
          start()
        }
        return () => {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
          if (observer !== null) {
            observer.disconnect()
            observer = null
          }
          if (chip !== null) {
            chip.remove()
            chip = null
          }
          anchor = null
        }
      }, 'dsh-balance-display-simple: sidebar balance chip')
    }

    exports.apply = apply
    return module.exports
  },
})
