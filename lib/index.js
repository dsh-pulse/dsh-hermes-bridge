/**
 * dsh-hermes-bridge — M1：入站调度 + 会话复用
 *
 * 范围（技术方案 §10 M1，吸收参考实现 dsh-harness-mcp-server 的验证做法）：
 *   - POST /v1/tasks 入站 + 任务队列 + 状态机（queued/running/done/failed）
 *   - 按 cwd 的常驻会话池（ctx.agents.create/resume + followup + whenIdle，
 *     省 15–20× token）；每 cwd 串行锁防并发 followup
 *   - 状态推送：接单 / 开跑 / 完成 / 失败 → hermes send 推微信
 *   - ctx.jobs 登记（尽力而为，Web UI 可见；controller 缺失自动降级）
 *   - 保留 M0：POST /v1/notify + GET /v1/health + Bearer 认证 + 脱敏
 *
 * 安全（对齐方案 §7）：只绑 127.0.0.1；authToken 必填；cwd 白名单（workspaceRoots
 * 非空时校验）；spawn 零 shell；推送前 redact。
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'

/** Cordis 插件名 */
export const name = 'hermes-bridge'

/** M1 注入：agents / agentPresets / sessions / sessionPersistence（jobs 用 ctx.get 懒取） */
export const inject = ['agents', 'agentPresets', 'sessions', 'sessionPersistence']

/** 运行时配置（apply 时从 config 覆盖） */
const runtime = {
  port: 8643,
  authToken: '',
  pushTarget: '',
  hermesBin: 'hermes',
  retries: 1,
  maxTextLen: 1500,
  preset: 'standard',
  provider: '',
  model: '',
  workspaceRoots: [],
  maxAgents: 3,
  maxQueue: 8,
  taskTtlMs: 86_400_000,
}

// ── 出站推送（M0 保留）──────────────────────────────────────────────

/** 脱敏：token / 凭据路径 */
export function redact(text) {
  return String(text)
    .replace(/\bsk_tr_[A-Za-z0-9_-]{8,}/g, 'sk_tr_***')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/(?:file:\/\/)?\/home\/[^\s/]+\/\.dsh\/\.credentials\.yaml/g, '***credentials***')
    .replace(/\bghp_[A-Za-z0-9]{20,}/g, 'ghp_***')
}

/** 调 hermes send（零 shell） */
export function runSend(hermesBin, target, text) {
  return new Promise((resolve) => {
    const child = spawn(hermesBin, ['send', '--to', target, '--json', text], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
  })
}

/** 推送 + 重试（默认 1 次） */
async function pushWithRetry(text) {
  const safe = redact(text).slice(0, runtime.maxTextLen)
  for (let attempt = 0; attempt <= runtime.retries; attempt++) {
    try {
      const r = await runSend(runtime.hermesBin, runtime.pushTarget, safe)
      if (r.code === 0) return { ok: true, attempt: attempt + 1 }
      console.error(`[hermes-bridge] send 失败 attempt=${attempt + 1} code=${r.code}: ${(r.err || r.out || '').trim().slice(0, 160)}`)
    } catch (e) {
      console.error(`[hermes-bridge] push 异常 attempt=${attempt + 1}: ${String(e)}`)
    }
  }
  return { ok: false }
}

// ── 会话池（按 cwd 复用，吸收参考实现 §F9）───────────────────────────

const liveAgents = new Map() // cwd -> { sessionId, handle, lastUsed }
const sessionToCwd = new Map() // sessionId -> cwd
const agentLocks = new Map() // cwd/session -> Promise

async function canonicalCwd(raw) {
  try {
    return await realpath(raw)
  } catch {
    return resolve(raw)
  }
}

/** 挂载 preset（rc.6 scope bug 检测，降级为无工具 agent 而非崩溃） */
async function mountPreset(ctx, agentCtx) {
  if (scopeOf(agentCtx) === undefined) {
    console.warn('[hermes-bridge] agent ctx unscoped（dsh rc.6 bug）；preset mount 跳过（降级无工具 agent）')
    return
  }
  await ctx.agentPresets.mount(agentCtx, runtime.preset)
}

/** 获取（或创建/恢复）指定 cwd 的常驻 agent；sessionId 时接管指定会话 */
async function getAgent(ctx, cwd, sessionId) {
  const canonical = await canonicalCwd(cwd)
  if (sessionId) {
    const sid = SessionId(sessionId)
    const targetCwd = sessionToCwd.get(String(sid))
    if (targetCwd !== undefined) {
      const existing = liveAgents.get(targetCwd)
      if (existing) {
        liveAgents.delete(targetCwd)
        liveAgents.set(targetCwd, existing)
        return existing
      }
    }
    const live = ctx.agents.get(sid)
    if (live) {
      return { sessionId: sid, handle: { agent: live, dispose: () => Promise.resolve() }, disposeAfter: false }
    }
    let handle
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: sid,
        ...(runtime.provider || runtime.model
          ? { agentOptions: { ...(runtime.provider ? { provider: runtime.provider } : {}), ...(runtime.model ? { model: runtime.model } : {}) } }
          : {}),
        setup: (agentCtx) => mountPreset(ctx, agentCtx),
      })
    } catch (e) {
      throw new Error(`session not found for resume: ${sessionId}（${(e).message ?? e}）`)
    }
    return { sessionId: sid, handle, disposeAfter: true }
  }
  const existing = liveAgents.get(canonical)
  if (existing) {
    liveAgents.delete(canonical)
    liveAgents.set(canonical, existing)
    return existing
  }
  // LRU 淘汰
  while (liveAgents.size >= runtime.maxAgents) {
    const oldestKey = liveAgents.keys().next().value
    if (oldestKey === undefined) break
    const old = liveAgents.get(oldestKey)
    liveAgents.delete(oldestKey)
    sessionToCwd.delete(String(old.sessionId))
    try { await old.handle.dispose?.() } catch { /* 忽略 */ }
  }
  const newSessionId = SessionId(randomUUID())
  const handle = await ctx.agents.create({
    sessionId: newSessionId,
    meta: { cwd: canonical, agentPreset: runtime.preset },
    ...(runtime.provider || runtime.model
      ? { agentOptions: { ...(runtime.provider ? { provider: runtime.provider } : {}), ...(runtime.model ? { model: runtime.model } : {}) } }
      : {}),
    setup: (agentCtx) => mountPreset(ctx, agentCtx),
  })
  const rec = { sessionId: newSessionId, handle }
  liveAgents.set(canonical, rec)
  sessionToCwd.set(String(newSessionId), canonical)
  return rec
}

/** 同一 cwd/session 串行执行（防并发 followup 冲突） */
function withLock(key, fn) {
  const prev = agentLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  agentLocks.set(key, next.catch(() => {}))
  return next
}

// ── 任务执行（吸收参考实现 executeTask）──────────────────────────────

/** 从 agent 最终回答解析 changes/verification/leftovers（从后往前找 JSON 候选） */
function parseSummary(assistantText) {
  const empty = { changes: '', verification: '', leftovers: '' }
  const re = /\{[\s\S]*?\}/g
  const candidates = []
  let m
  while ((m = re.exec(assistantText)) !== null) candidates.push(m[0])
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i])
      const s = (v) => (typeof v === 'string' ? v : '')
      const changes = s(obj.changes) || s(obj.改动)
      const verification = s(obj.verification) || s(obj.验证)
      const leftovers = s(obj.leftovers) || s(obj.遗留)
      if (changes || verification || leftovers) return { changes, verification, leftovers }
    } catch { /* 继续找更早候选 */ }
  }
  return empty
}

/** 执行任务：followup → whenIdle → 读增量 log */
async function executeTask(ctx, taskText, context, cwd, sessionId, title) {
  const workdir = await canonicalCwd(cwd ? resolve(cwd) : process.cwd())
  if (runtime.workspaceRoots.length > 0) {
    const allowed = runtime.workspaceRoots.some((root) => {
      const r = resolve(root)
      return workdir === r || workdir.startsWith(r + '/')
    })
    if (!allowed) throw new Error(`cwd not allowed（不在 workspaceRoots 内）：${workdir}`)
  }
  const lockKey = sessionId ? `session:${sessionId}` : workdir
  return withLock(lockKey, async () => {
    const { sessionId: sid, handle, disposeAfter } = await getAgent(ctx, workdir, sessionId)
    const log = ((handle.agent.session ?? {}).log ?? [])
    const baseline = log.length
    const fullTask = [
      context ? `【上下文/背景（来自微信/外部，供参考）】\n${context}\n` : '',
      `【任务】\n${taskText}\n`,
      `【完成后必须】输出一行 JSON 总结（不要 markdown 代码块包裹，直接输出这一行）：`,
      `{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`,
    ].filter(Boolean).join('\n')
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: fullTask }], source: { kind: 'plugin', plugin: 'hermes-bridge' } }),
    )
    await handle.agent.whenIdle()
    const events = ((handle.agent.session ?? {}).log ?? []).slice(baseline)
    const result = { sessionId: sid, assistantText: '', changes: '', verification: '', leftovers: '' }
    try {
      const extractText = (obj, out) => {
        if (Array.isArray(obj)) { obj.forEach((x) => extractText(x, out)); return }
        if (obj && typeof obj === 'object') {
          const rec = obj
          if (typeof rec.text === 'string' && rec.text.trim()) out.push(rec.text)
          if (typeof rec.content === 'string' && rec.content.trim()) out.push(rec.content)
          for (const v of Object.values(rec)) extractText(v, out)
        }
      }
      for (const ev of events) {
        if (ev?.type === 'assistant/message') {
          const content = ev?.data?.message?.content
          if (content) {
            const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text)
            if (texts.length) result.assistantText += texts.join('\n') + '\n'
          }
        }
      }
      const summary = parseSummary(result.assistantText)
      result.changes = summary.changes
      result.verification = summary.verification
      result.leftovers = summary.leftovers
    } catch (e) {
      result.assistantText = `[读输出异常] ${String(e)}`
    }
    if (disposeAfter) {
      try { await ctx.get('sessions')?.flush?.(handle.agent.session) } catch { /* 忽略 */ }
      try { await handle.dispose() } catch { /* 忽略 */ }
    }
    return result
  })
}

// ── 任务队列 + 状态机 ────────────────────────────────────────────────

const taskQueue = new Map()

/** 状态推送（每状态一次，不刷屏） */
function pushStatus(task, kind, extra = '') {
  const lines = {
    queued: `📥 已接单 ${task.id}\n任务：${(task.task || '').slice(0, 60)}${task.cwd ? `\ncwd：${task.cwd}` : ''}`,
    running: `🔧 开跑 ${task.id}（${task.sessionId ? '续接会话' : '新会话'}${task.sessionId ? ` ${task.sessionId}` : ''}）`,
    done: `✅ ${task.id}（${task.duration ? `${task.duration}s` : ''}）${extra ? `\n${extra}` : ''}`,
    failed: `❌ ${task.id}\n原因：${(task.error || '').slice(0, 200)}`,
  }[kind]
  void pushWithRetry(lines || extra)
}

function minutes(n) {
  const s = Math.round(n / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

async function runTask(ctx, task) {
  task.status = 'running'
  task.startedAt = Date.now()
  pushStatus(task, 'running')
  try {
    const result = await executeTask(ctx, task.task, task.context || '', task.cwd, task.sessionId, task.title)
    task.status = 'done'
    task.result = result
    task.finishedAt = Date.now()
    task.duration = (task.finishedAt - task.startedAt) / 1000
    const extra = [
      result.changes ? `改动：${result.changes}` : '',
      result.verification ? `验证：${result.verification}` : '',
      result.leftovers ? `遗留：${result.leftovers}` : '',
    ].filter(Boolean).join('\n')
    pushStatus(task, 'done', extra)
  } catch (e) {
    task.status = 'failed'
    task.error = String(e)
    task.finishedAt = Date.now()
    pushStatus(task, 'failed')
  }
}

/** 入队（TTL 清理 + 容量校验）→ jobs 登记（尽力）→ 执行 */
function enqueue(ctx, payload) {
  const now = Date.now()
  for (const [tid, t] of taskQueue) {
    if ((t.status === 'done' || t.status === 'failed') && t.finishedAt && now - t.finishedAt > runtime.taskTtlMs) {
      taskQueue.delete(tid)
    }
  }
  let active = 0
  for (const t of taskQueue.values()) if (t.status === 'queued' || t.status === 'running') active++
  if (active >= runtime.maxQueue) {
    throw new Error(`queue full（${active}/${runtime.maxQueue}）`)
  }
  const id = `br-${randomUUID().slice(0, 8)}`
  const task = { id, ...payload, status: 'queued', createdAt: now }
  taskQueue.set(id, task)
  pushStatus(task, 'queued')
  // ctx.jobs 登记（尽力而为；controller 缺失/未加载自动降级为直接执行）
  try {
    const jobs = ctx.get('jobs')
    if (jobs) {
      jobs.start({
        kind: 'bridge',
        label: (task.task || '').slice(0, 60),
        run: () => {
          const p = runTask(ctx, task)
          return {
            cancel: () => { if (task.status === 'queued') { task.status = 'failed'; task.error = 'cancelled' } },
            done: p.then(() => ({ status: task.status })),
            readOutput: () => ({ status: task.status, text: task.result?.assistantText?.slice(0, 500) || task.error || '' }),
          }
        },
      })
      return id
    }
  } catch (e) {
    console.warn(`[hermes-bridge] jobs 登记失败（降级直接执行）: ${e.message}`)
  }
  void runTask(ctx, task)
  return id
}

// ── HTTP ─────────────────────────────────────────────────────────────

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
 * 插件入口：127.0.0.1 HTTP。
 *   POST /v1/tasks       入站任务 {task,context?,cwd?,sessionId?,replyTarget?,title?} → 202 {taskId}
 *   GET  /v1/tasks/:id   查状态
 *   POST /v1/tasks/:id/cancel  取消（queued 立即失败；running 标记 intent，等终态后回推）
 *   POST /v1/notify      纯推送 {text}
 *   GET  /v1/health      存活
 */
export async function apply(ctx, config = {}) {
  if (config.port !== undefined) runtime.port = Number(config.port)
  if (config.authToken) runtime.authToken = String(config.authToken)
  if (config.pushTarget) runtime.pushTarget = String(config.pushTarget)
  if (config.hermesBin) runtime.hermesBin = String(config.hermesBin)
  if (config.retries !== undefined) runtime.retries = Number(config.retries)
  if (config.maxTextLen !== undefined) runtime.maxTextLen = Number(config.maxTextLen)
  if (config.preset) runtime.preset = String(config.preset)
  if (config.provider) runtime.provider = String(config.provider)
  if (config.model) runtime.model = String(config.model)
  if (config.workspaceRoots) runtime.workspaceRoots = config.workspaceRoots.map(String)
  if (config.maxAgents !== undefined) runtime.maxAgents = Number(config.maxAgents)
  if (config.maxQueue !== undefined) runtime.maxQueue = Number(config.maxQueue)
  if (config.taskTtlMs !== undefined) runtime.taskTtlMs = Number(config.taskTtlMs)

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
    if (req.headers['authorization'] !== `Bearer ${runtime.authToken}`) {
      return json(401, { error: 'unauthorized' })
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      return json(400, { error: 'bad url' })
    }
    const p = url.pathname

    if (req.method === 'GET' && p === '/v1/health') {
      return json(200, { ok: true, name, m1: true, liveAgents: liveAgents.size, queued: taskQueue.size })
    }

    if (req.method === 'POST' && p === '/v1/notify') {
      let body
      try { body = await readBody(req) } catch (e) { return json(413, { error: String(e) }) }
      let parsed
      try { parsed = JSON.parse(body) } catch { return json(400, { error: 'invalid json' }) }
      const text = String(parsed.text ?? '').trim()
      if (!text) return json(400, { error: 'text required' })
      const r = await pushWithRetry(text)
      return json(r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `push failed after ${runtime.retries + 1} attempts` })
    }

    if (req.method === 'POST' && p === '/v1/tasks') {
      let body
      try { body = await readBody(req) } catch (e) { return json(413, { error: String(e) }) }
      let parsed
      try { parsed = JSON.parse(body) } catch { return json(400, { error: 'invalid json' }) }
      const task = String(parsed.task ?? '').trim()
      if (!task) return json(400, { error: 'task required' })
      // cwd 白名单预检（与 executeTask 的 realpath 校验互补；入站即拦，返回 403）
      if (parsed.cwd && runtime.workspaceRoots.length > 0) {
        const w = resolve(String(parsed.cwd))
        const allowed = runtime.workspaceRoots.some((root) => {
          const r = resolve(root)
          return w === r || w.startsWith(r + '/')
        })
        if (!allowed) return json(403, { error: 'cwd not allowed' })
      }
      try {
        const id = enqueue(ctx, {
          task,
          context: parsed.context ? String(parsed.context) : undefined,
          cwd: parsed.cwd ? String(parsed.cwd) : undefined,
          sessionId: parsed.sessionId ? String(parsed.sessionId) : undefined,
          title: parsed.title ? String(parsed.title) : undefined,
        })
        return json(202, { taskId: id, status: 'queued' })
      } catch (e) {
        const msg = String(e?.message ?? e)
        if (msg.includes('queue full')) return json(429, { error: msg })
        if (msg.includes('cwd not allowed')) return json(403, { error: msg })
        return json(500, { error: msg })
      }
    }

    const mTask = p.match(/^\/v1\/tasks\/(br-[a-f0-9]+)(?:\/(cancel))?$/)
    if (mTask) {
      const task = taskQueue.get(mTask[1])
      if (!task) return json(404, { error: `task not found: ${mTask[1]}` })
      if (mTask[2] === 'cancel') {
        if (task.status === 'queued') {
          task.status = 'failed'
          task.error = 'cancelled'
          task.finishedAt = Date.now()
          void pushWithRetry(`⏹️ ${task.id} 已取消（未开始）`)
        } else if (task.status === 'running') {
          task.cancelRequested = true
          void pushWithRetry(`⏹️ ${task.id} 取消请求已收到，等当前步骤结束后停止并回推`)
        }
        return json(200, { taskId: task.id, status: task.status })
      }
      return json(200, {
        taskId: task.id,
        status: task.status,
        error: task.error,
        result: task.result
          ? { sessionId: task.result.sessionId, assistantText: task.result.assistantText.slice(0, 2000), changes: task.result.changes, verification: task.result.verification, leftovers: task.result.leftovers }
          : undefined,
      })
    }

    return json(404, { error: 'not found' })
  })

  server.listen(runtime.port, '127.0.0.1', () => {
    console.log(`[hermes-bridge] M1 listening on 127.0.0.1:${runtime.port}（入站 /v1/tasks + 出站 /v1/notify）`)
  })
  server.on('error', (e) => {
    console.error(`[hermes-bridge] server error: ${e.message}`)
  })

  ctx.effect(() => {
    return () => {
      server.close()
      console.log('[hermes-bridge] server closed')
    }
  }, 'hermes-bridge')
}
