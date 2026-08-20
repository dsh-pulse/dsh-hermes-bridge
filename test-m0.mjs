/**
 * dsh-hermes-bridge M0 隔离测试（不碰生产 dsh 实例）
 * 用 mock ctx 驱动 apply()，验证：
 *   1. 无/错 token → 401
 *   2. GET /v1/health → 200
 *   3. POST /v1/notify 无 text → 400；坏 json → 400
 *   4. POST /v1/notify 假 target → 502（hermes send 失败 + 重试 1 次）
 *   5. 404
 *   6. 脱敏：redact 打掉 sk- 前缀
 * 用法：node test-m0.mjs
 */
import { apply, redact } from './lib/index.js'

// Node 18 的文件脚本模式默认不暴露全局 Web Crypto（`crypto` 仅在 -e/REPL 里可用；
// DSH 要求 Node ≥ 22，那里默认可用）。测试在 Node 18 本地也能跑，故此处垫片。
import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto

// mock ctx（cordis 最小面）
const ctx = {
  _cleanup: null,
  effect(fn) {
    this._cleanup = fn()
    return this._cleanup
  },
}

const PORT = 8644
const TOKEN = 'test-token-abc'

// 假 target：hermes send 会投递失败 → 验证失败重试路径（不会真发微信）
await apply(ctx, {
  port: PORT,
  authToken: TOKEN,
  pushTarget: 'weixin:fake-target@im.wechat',
  hermesBin: '/home/superzealot/.hermes/hermes-agent/venv/bin/hermes',
  retries: 1,
})
await new Promise((r) => setTimeout(r, 500))

const base = `http://127.0.0.1:${PORT}`
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
const noAuth = { 'Content-Type': 'application/json' }

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label} ${extra}`) }
}

console.log('=== 1. 认证 ===')
let r = await fetch(`${base}/v1/notify`, { method: 'POST', headers: noAuth, body: '{}' })
check('无 token → 401', r.status === 401, `got ${r.status}`)
r = await fetch(`${base}/v1/notify`, { method: 'POST', headers: { ...noAuth, Authorization: 'Bearer wrong' }, body: '{}' })
check('错误 token → 401', r.status === 401, `got ${r.status}`)

console.log('=== 2. health ===')
r = await fetch(`${base}/v1/health`, { headers: H })
check('GET /v1/health → 200', r.status === 200 && (await r.json()).ok === true, `got ${r.status}`)

console.log('=== 3. 入参校验 ===')
r = await fetch(`${base}/v1/notify`, { method: 'POST', headers: H, body: 'not-json' })
check('坏 json → 400', r.status === 400, `got ${r.status}`)
r = await fetch(`${base}/v1/notify`, { method: 'POST', headers: H, body: JSON.stringify({}) })
check('缺 text → 400', r.status === 400, `got ${r.status}`)

console.log('=== 4. 失败重试（假 target，hermes send 应失败 → 502） ===')
const t0 = Date.now()
r = await fetch(`${base}/v1/notify`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'M0 测试：这条不会真的发出去' }) })
const dt = Date.now() - t0
const j = await r.json()
check('假 target → 502', r.status === 502, `got ${r.status}`)
check('失败信息含 retries', /failed after 2 attempts/.test(j.error || ''), j.error)
check('耗时体现重试（>800ms）', dt > 800, `${dt}ms`)

console.log('=== 5. 404 ===')
r = await fetch(`${base}/v1/whatever`, { headers: H })
check('未知路径 → 404', r.status === 404, `got ${r.status}`)

console.log('=== 6. 脱敏 ===')
const r1 = redact('key=sk-1a3b14cf5acd40fe84f0dfdd05b96320 中转=sk_tr_rS12345678901234567890')
check('sk- 前缀被脱敏', !/sk-(?!\*)/.test(r1) && r1.includes('sk-***'), r1)
const r2 = redact('路径 /home/superzealot/.dsh/.credentials.yaml 引用')
check('credentials 路径被脱敏', !r2.includes('.credentials.yaml') && r2.includes('***credentials***'), r2)

// 清理
ctx._cleanup?.()
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
