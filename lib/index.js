// dsh-balance-display-simple —— Host 半区：注册 GET /api/deepseek-balance-simple 端点。
//
// 通过 credentials 服务解析 DEEPSEEK_API_KEY（来源：进程环境 > .credentials.yaml
// > .env），代理调用 DeepSeek 官方余额接口 https://api.deepseek.com/user/balance，
// 浏览器端只访问同源本地端点，不接触 API Key。
//
// 端点用 exact 路由注册，优先于 client-connection 注册的 /api 前缀路由。

export const name = 'dsh-balance-display-simple'

/** 依赖的 Cordis 服务：webServer（HTTP 路由注册）。credentials 惰性读取。 */
export const inject = ['webServer']

/** 端点路径。 */
const ENDPOINT = '/api/deepseek-balance-simple'

/** DeepSeek 官方余额接口。 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 凭证引用名（与 dsh-llm-deepseek 默认一致）。 */
const API_KEY_REF = 'DEEPSEEK_API_KEY'

/** 上游请求超时（毫秒）。 */
const UPSTREAM_TIMEOUT_MS = 15000

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
  try {
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
      respond(res, 200, { ok: true, fetchedAt: Date.now(), ...data })
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
