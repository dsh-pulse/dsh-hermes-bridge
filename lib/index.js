/**
 * dsh-hermes-bridge — M0：出站推送最小闭环
 *
 * 范围（技术方案 §10 M0）：
 *   - cordis 插件骨架（apply + Config + 127.0.0.1 HTTP + Bearer token）
 *   - 仅 POST /v1/notify 一个端点 + hermes send 推送器（重试 1 次 + 脱敏）
 *   - daily-pulse 跑完 curl 一下 → 微信收到「日报已生成」
 *
 * 设计（对齐技术方案 §3 / §7）：
 *   - 出站走 `hermes send` CLI（零 LLM、无需 live gateway、bot-token 平台直连）
 *   - spawn 数组传参、零 shell，任务文本永不过 shell
 *   - 只绑 127.0.0.1（硬编码，不提供 host 配置）；authToken 必填否则拒绝激活
 *   - 推送前 redact（sk- 前缀 token、credentials 路径）
 *   - ctx.effect 注册卸载清理（server.close）
 *
 * 依赖：纯 Node（node:http / node:child_process），零 @deepseek-ai 依赖 ——
 * 开发期 file: 路径加载无需额外安装，M0 后接入 ctx.agents 时再补依赖声明。
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

/** Cordis 插件名 */
export const name = 'hermes-bridge'

/** M0 不需要注入 DSH 服务（纯推送）；M1 接入 agents/sessions/jobs 时再补 */
export const inject = []

/** 运行时配置（apply 时从 config 覆盖） */
const runtime = {
  port: 8643,
  authToken: '',
  pushTarget: '',
  hermesBin: 'hermes',
  retries: 1,
  maxTextLen: 1500,
}

/** 出站内容脱敏：token / 凭据路径，防推送内容把密钥带出去 */
export function redact(text) {
  return String(text)
    .replace(/\bsk_tr_[A-Za-z0-9_-]{8,}/g, 'sk_tr_***')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/(?:file:\/\/)?\/home\/[^\s/]+\/\.dsh\/\.credentials\.yaml/g, '***credentials***')
    .replace(/\bghp_[A-Za-z0-9]{20,}/g, 'ghp_***')
}

/** 调 hermes send（零 shell），返回 { code, out, err } */
export function runSend(hermesBin, target, text) {
  return new Promise((resolve) => {
    const child = spawn(hermesBin, ['send', '--to', target, '--json', text], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
  })
}

/** 推送 + 重试（默认 1 次）；失败记录日志供排查 */
export async function pushWithRetry(text, log = console) {
  for (let attempt = 0; attempt <= runtime.retries; attempt++) {
    try {
      const r = await runSend(runtime.hermesBin, runtime.pushTarget, text)
      if (r.code === 0) {
        return { ok: true, attempt: attempt + 1, detail: (r.out || '').trim().slice(0, 300) }
      }
      log.error(`[hermes-bridge] hermes send 失败 attempt=${attempt + 1}/${runtime.retries + 1} code=${r.code}: ${(r.err || r.out || '').trim().slice(0, 200)}`)
    } catch (e) {
      log.error(`[hermes-bridge] push 异常 attempt=${attempt + 1}/${runtime.retries + 1}: ${String(e)}`)
    }
  }
  return { ok: false, detail: `hermes send failed after ${runtime.retries + 1} attempts` }
}

/** 读取请求体（限长，防滥用） */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''
    let done = false
    req.on('data', (c) => {
      if (done) return
      data += c
      if (data.length > limit) {
        done = true
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => (done ? null : resolve(data)))
    req.on('error', reject)
  })
}

/**
 * 插件入口：起 127.0.0.1 HTTP 端点。
 *   POST /v1/notify  {text}  → 脱敏 → hermes send 推微信（重试 1 次）
 *   GET  /v1/health          → 存活检查
 * 其余 404；Bearer token 不符 401；authToken/pushTarget 未配拒绝激活。
 */
export async function apply(ctx, config = {}) {
  if (config.port !== undefined) runtime.port = Number(config.port)
  if (config.authToken) runtime.authToken = String(config.authToken)
  if (config.pushTarget) runtime.pushTarget = String(config.pushTarget)
  if (config.hermesBin) runtime.hermesBin = String(config.hermesBin)
  if (config.retries !== undefined) runtime.retries = Number(config.retries)
  if (config.maxTextLen !== undefined) runtime.maxTextLen = Number(config.maxTextLen)

  // 安全硬门槛：token 与目标必填，缺了拒绝激活（避免裸奔端口）
  if (!runtime.authToken) {
    console.error('[hermes-bridge] authToken 未配置，拒绝激活（安全要求）')
    return
  }
  if (!runtime.pushTarget) {
    console.error('[hermes-bridge] pushTarget 未配置，拒绝激活')
    return
  }

  const server = createServer(async (req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    // Bearer 认证（恒定比较由 === 天然保证；token 值本身不落日志）
    if (req.headers['authorization'] !== `Bearer ${runtime.authToken}`) {
      return json(401, { error: 'unauthorized' })
    }
    let pathname = ''
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    } catch {
      return json(400, { error: 'bad url' })
    }

    if (req.method === 'GET' && pathname === '/v1/health') {
      return json(200, { ok: true, name, m0: true })
    }

    if (req.method === 'POST' && pathname === '/v1/notify') {
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        return json(413, { error: String(e) })
      }
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        return json(400, { error: 'invalid json' })
      }
      const text = String(parsed.text ?? '').trim()
      if (!text) return json(400, { error: 'text required' })
      const safe = redact(text).slice(0, runtime.maxTextLen)
      console.log(`[hermes-bridge] notify → ${runtime.pushTarget}（${safe.length} 字，redact 后）`)
      const result = await pushWithRetry(safe)
      return json(result.ok ? 200 : 502, result.ok ? { ok: true, attempt: result.attempt } : { error: result.detail })
    }

    return json(404, { error: 'not found' })
  })

  server.listen(runtime.port, '127.0.0.1', () => {
    console.log(`[hermes-bridge] listening on 127.0.0.1:${runtime.port}（M0 出站推送）`)
  })
  server.on('error', (e) => {
    console.error(`[hermes-bridge] server error: ${e.message}`)
  })

  // 标准 cordis 生命周期：卸载时关 server
  ctx.effect(() => {
    return () => {
      server.close()
      console.log('[hermes-bridge] server closed')
    }
  }, 'hermes-bridge')
}
