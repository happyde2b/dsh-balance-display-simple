// dsh-balance-display-simple —— Host 半区：注册 GET /api/deepseek-balance-simple 端点。
//
// 余额来源两条，账号优先、API Key 兜底：
// 1. DSH 的 `deepseekAccount` 服务（DeepSeek 账号 OAuth 登录，不需要 API Key）：
//    `getBalance(client)` 返回平台钱包（充值余额 value + 赠送额度 bonusWallets）。
// 2. 没有账号服务 / 未登录 / 查询失败时，退回 credentials 的 DEEPSEEK_API_KEY，
//    代理调用 https://api.deepseek.com/user/balance。
//
// 浏览器端只访问同源本地端点，不接触 API Key，也不接触账号 grant。
// 端点用 exact 路由注册，优先于 client-connection 注册的 /api 前缀路由。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-balance-display-simple'

/** 依赖的 Cordis 服务：webServer（HTTP 路由注册）。credentials / deepseekAccount 惰性读取。 */
export const inject = ['webServer']

/** 端点路径。 */
const ENDPOINT = '/api/deepseek-balance-simple'

/** DeepSeek 官方余额接口（API Key 路线）。 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 凭证引用名（与 dsh-llm-deepseek 默认一致）。 */
const API_KEY_REF = 'DEEPSEEK_API_KEY'

/** 账号服务查询用的 UI 语言（服务内部归一成 Platform 的 zh_CN / en_US）。 */
const ACCOUNT_LOCALE = 'zh-CN'

/** 拿不到 dsh 版本时的兜底值（x-client-version 头，仅作标识）。 */
const FALLBACK_DSH_VERSION = '0.2.2'

/** 上游请求超时（毫秒）。 */
const UPSTREAM_TIMEOUT_MS = 15000

/** 本机回环主机名（旧版 dsh 兜底栅栏用）。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 缓存的 dsh 版本（首次询问时读一次 package.json）。 */
let cachedDshVersion

/**
 * 读取当前 dsh 版本，用于账号服务的 `x-client-version` 头。
 * @returns 版本字符串；读不到时返回兜底值。
 */
function dshVersion() {
  if (cachedDshVersion !== undefined) return cachedDshVersion
  cachedDshVersion = FALLBACK_DSH_VERSION
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir !== 'string' || installDir === '') return cachedDshVersion
  try {
    const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'))
    if (typeof pkg.version === 'string' && pkg.version !== '') cachedDshVersion = pkg.version
  } catch {
    // 读不到就用兜底版本，不影响余额查询。
  }
  return cachedDshVersion
}

/**
 * 把账号服务的钱包列表按币种求和（充值余额 + 赠送额度，与 API 的 total_balance 语义一致）。
 * @param detail - `getBalance` 返回的 ready 结果。
 * @returns `balance_infos` 数组，形如 `[{ currency: 'CNY', total_balance: '20.52' }]`。
 */
function walletTotals(detail) {
  const totals = new Map()
  const wallets = [...(detail.value ?? []), ...(detail.bonusWallets ?? [])]
  for (const wallet of wallets) {
    if (wallet === null || typeof wallet !== 'object') continue
    const amount = Number(wallet.balance)
    if (typeof wallet.currency !== 'string' || !Number.isFinite(amount)) continue
    totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + amount)
  }
  return [...totals].map(([currency, amount]) => ({
    currency,
    total_balance: amount.toFixed(2),
  }))
}

/**
 * 通过 DSH 账号服务查余额（免 API Key）。服务缺失、未登录、查询失败都返回 null，
 * 由调用方回退到 API Key 路线。
 * @param ctx - 插件上下文。
 * @returns ready 的统一余额响应；不可用时 null。
 */
async function accountBalance(ctx) {
  let account
  try {
    account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
  } catch {
    account = undefined
  }
  if (account === null || account === undefined || typeof account.getBalance !== 'function') return null
  try {
    const detail = await account.getBalance({
      version: dshVersion(),
      locale: ACCOUNT_LOCALE,
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    if (detail === null || detail === undefined || detail.status !== 'ready') return null
    const balance_infos = walletTotals(detail)
    if (balance_infos.length === 0) return null
    return { ok: true, source: 'account', fetchedAt: Date.now(), is_available: true, balance_infos }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger?.warn(`dsh-balance-display-simple: account balance failed: ${message}`)
    return null
  }
}

/**
 * 旧版 dsh / 无 `connection.requestRejection` 时的最小信任栅栏：只放行 loopback Host，
 * 拒绝 cross-site fetch 与 Origin 与 Host 不一致的请求。
 * @param req - node:http 请求。
 * @returns 是否可信。
 */
function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  const hostName = host.split(':')[0]
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 端点访问栅栏：与 dsh 自身 `/api` 路由一致，先走 Host Connection 的
 * `requestRejection(request)`（Host/Origin 栅栏 + 浏览器登录，返回 401/403/undefined），
 * 老版本 dsh 没有该服务时退回 loopback 信任栅栏。
 *
 * 没有这层检查时，用户浏览器里打开的任何网页都能直接请求本端点。
 * @param ctx - 插件上下文。
 * @param req - node:http 请求。
 * @returns 应当拒绝时的状态码；放行时返回 undefined。
 */
function rejectionFor(ctx, req) {
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  const gate = connection?.requestRejection
  if (typeof gate === 'function') return gate.call(connection, req)
  return isTrustedLoopbackRequest(req) ? undefined : 403
}

/**
 * 写一个 JSON 响应。
 * @param res - node:http 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可 JSON 序列化的响应体。
 */
function respond(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 处理一次余额查询：解析凭证、调用上游、返回统一 JSON。
 * @param ctx - 插件上下文（惰性读取 credentials 服务）。
 * @param req - node:http 请求。
 * @param res - node:http 响应。
 */
async function handleBalance(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  const rejected = rejectionFor(ctx, req)
  if (rejected !== undefined) {
    respond(res, rejected, {
      ok: false,
      error: rejected === 401 ? 'unauthorized' : 'forbidden',
    })
    return
  }
  try {
    const account = await accountBalance(ctx)
    if (account !== null) {
      respond(res, 200, account)
      return
    }
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      respond(res, 200, { ok: false, error: 'credentials service is unavailable in this profile' })
      return
    }
    const entry = await credentials.resolve(API_KEY_REF)
    if (entry === undefined || typeof entry.value !== 'string' || entry.value === '') {
      respond(res, 200, { ok: false, error: `${API_KEY_REF} is not configured` })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      const upstream = await fetch(BALANCE_URL, {
        method: 'GET',
        headers: { authorization: `Bearer ${entry.value}` },
        signal: controller.signal,
      })
      const text = await upstream.text()
      let data = null
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
      if (!upstream.ok || data === null) {
        respond(res, 200, {
          ok: false,
          httpStatus: upstream.status,
          error: `deepseek balance api error ${upstream.status}: ${text.slice(0, 200)}`,
        })
        return
      }
      respond(res, 200, { ok: true, source: 'apiKey', fetchedAt: Date.now(), ...data })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger?.warn(`dsh-balance-display-simple: ${message}`)
    respond(res, 200, { ok: false, error: message })
  }
}

/**
 * 注册余额端点。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ENDPOINT,
        handler: (req, res) => handleBalance(ctx, req, res),
      }),
    'dsh-balance-display-simple: balance route',
  )
}
