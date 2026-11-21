// dsh-balance-display-simple Host 半区只读验证：真实导入插件模块并检查
// cordis 插件导出、路由注册参数、访问栅栏与错误分支（不启动服务、不写入任何状态）。
//
//   node scripts/verify-host.js [插件目录]
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = process.argv[2] ?? join(here, '..')

const EXPECTED_NAME = 'dsh-balance-display-simple'
const EXPECTED_PATH = '/api/deepseek-balance-simple'

let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href)
check('导出 name', mod.name === EXPECTED_NAME)
check('导出 inject 含 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'))
check('导出 apply 函数', typeof mod.apply === 'function')

// mock cordis ctx：记录 register 参数，验证 effect 包装与路由形状。
// connection 可切换：undefined = 老版 dsh（走回环栅栏），或提供 requestRejection。
const registered = []
const disposed = []
let connection = undefined
const ctx = {
  effect(fn, label) {
    const disposer = fn()
    disposed.push({ label, disposer })
    return () => {}
  },
  webServer: {
    register(route) {
      registered.push(route)
      return () => {}
    },
  },
  get(name) {
    if (name === 'connection') return connection
    return undefined // credentials 不可用：只验证注册路径与栅栏，不解析凭证
  },
  logger: { warn() {} },
}

mod.apply(ctx)
check('apply 注册了 1 条路由', registered.length === 1)
const route = registered[0]
check('路由 kind=exact', route?.kind === 'exact')
check(`路由 path=${EXPECTED_PATH}`, route?.path === EXPECTED_PATH)
check('路由 handler 是函数', typeof route?.handler === 'function')
check('effect 有 label', disposed.length === 1 && typeof disposed[0].label === 'string')

const makeRes = () => ({
  statusCode: 0,
  headers: null,
  body: '',
  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers ?? null
  },
  end(text) {
    this.body = text ?? ''
  },
})

const TRUSTED = { host: '127.0.0.1:19387' }

// ---- 1. 方法栅栏：非 GET/HEAD 直接 405（在访问栅栏之前）----
const res405 = makeRes()
await route.handler({ method: 'POST', headers: TRUSTED }, res405)
check('非 GET 返回 405', res405.statusCode === 405)

// ---- 2. 没有 connection 服务时的回环栅栏 ----
let res = makeRes()
await route.handler({ method: 'GET', headers: {} }, res)
check('缺 Host 头返回 403', res.statusCode === 403 && res.body.includes('forbidden'))

res = makeRes()
await route.handler(
  { method: 'GET', headers: { ...TRUSTED, 'sec-fetch-site': 'cross-site' } },
  res,
)
check('cross-site 请求返回 403', res.statusCode === 403)

res = makeRes()
await route.handler(
  { method: 'GET', headers: { ...TRUSTED, origin: 'http://evil.example' } },
  res,
)
check('Origin 与 Host 不一致返回 403', res.statusCode === 403)

res = makeRes()
await route.handler({ method: 'GET', headers: { host: '192.168.1.9:19387' } }, res)
check('非回环 Host 返回 403', res.statusCode === 403)

// ---- 3. 回环请求放行，继续走到 credentials 缺失分支 ----
res = makeRes()
await route.handler({ method: 'GET', headers: { ...TRUSTED, origin: 'http://127.0.0.1:19387' } }, res)
check(
  '回环 GET 在 credentials 缺失时返回 JSON 错误',
  res.statusCode === 200 && res.body.includes('credentials service is unavailable'),
)

// ---- 4. 有 connection 服务时以 requestRejection 为准 ----
connection = { requestRejection: () => 401 }
res = makeRes()
await route.handler({ method: 'GET', headers: TRUSTED }, res)
check('connection 拒绝 401 时原样返回', res.statusCode === 401 && res.body.includes('unauthorized'))

connection = { requestRejection: () => undefined }
res = makeRes()
await route.handler({ method: 'GET', headers: TRUSTED }, res)
check(
  'connection 放行后进入 credentials 分支',
  res.statusCode === 200 && res.body.includes('credentials service is unavailable'),
)

connection = { requestRejection: () => 403 }
res = makeRes()
await route.handler({ method: 'GET', headers: TRUSTED }, res)
check('connection 拒绝 403 时原样返回', res.statusCode === 403 && res.body.includes('forbidden'))

console.log(failures === 0 ? '\nHOST VERIFY PASSED' : `\nHOST VERIFY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
