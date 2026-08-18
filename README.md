# dsh-hermes-bridge

DSH ↔ WeChat bridge plugin: **inbound dispatch (WeChat → DSH agent) + outbound push (DSH → WeChat)**, powered by the [Hermes](https://github.com/) gateway as the WeChat transport. Zero-LLM outbound push via `hermes send`, and a persistent per-cwd session pool that reuses DSH agent sessions (15–20× cheaper than one-shot headless invocations).

微信 ↔ DSH 双向桥插件：入站调度（微信消息 → DSH agent 执行）+ 出站推送（任务进度/结果 → 微信）。出站走 `hermes send` 零 LLM 消耗；按工作目录复用常驻会话，比一次性 headless 调用省 15–20× token。

> **⚠️ Read this first — environment assumptions.** This plugin was developed against one specific environment (see [Environment assumptions](#environment-assumptions)). DSH and Hermes deployments vary wildly between users; this plugin **cannot** work out-of-the-box everywhere. Please review the assumptions and adapt the configuration to your setup before expecting it to run.
>
> **⚠️ 先读环境假设。** 本插件基于特定开发环境编写（见「环境假设」章节）。DSH 与 Hermes 的部署方式千奇百怪，本插件**无法**开箱即用于所有环境，请先核对假设并适配你的配置。

## Why

The one-way manual chain "WeChat → Hermes skill → `dsh --profile headless`" works but burns tokens on cold starts, loses session context between messages, and cannot notify you when a long task finishes. This plugin productizes the chain as a first-class DSH plugin:

- **Session reuse** — agents stay alive per working directory (`ctx.agents.create/resume + followup`), so follow-up messages continue the same conversation.
- **Automatic pushback** — every task reports `接单 → 开跑 → 完成/失败` to WeChat with structured `changes / verification / leftovers`.
- **Zero-LLM outbound** — notifications go through `hermes send` (iLink REST), no model call, no gateway dependency for bot-token platforms.
- **Web UI visible** — tasks are registered via `ctx.jobs` (falls back gracefully when the job controller is absent).

## How it works

```
WeChat ──▶ Hermes gateway ──▶ dsh-run.sh (bridge-first) ──▶ POST 127.0.0.1:8643/v1/tasks
                                                              │
                                                              ▼
                                              persistent session pool (per cwd)
                                                              │
                                          DSH agent (full toolset, followup + whenIdle)
                                                              │
WeChat ◀── hermes send ──◀── structured result pushback ──◀──┘
```

Inbound: Hermes (or any HTTP client) POSTs a task to the plugin's loopback endpoint. The plugin dispatches to the per-cwd resident agent session and pushes progress back via `hermes send`. If the bridge is down, the shell script falls back to one-shot `dsh --profile headless`.

## Environment assumptions

Developed and verified on **one specific machine** (see the deployment notes in `DEVELOPMENT.md`). Your environment will differ; check each item:

| Assumption | Value used here | What to adapt on your side |
|---|---|---|
| DSH version | `0.1.0-rc.7` (Node ≥ 22) | `ctx.agents` / `ctx.agentPresets` / session APIs are **rc-stage snapshots** — a DSH upgrade may break them. Pin the rc range you run, or adjust code. |
| DSH profile | **web profile** (persistent host; `dsh web` keeps the plugin resident) | A headless-only deployment must host the plugin some other way (its HTTP loopback must stay alive). |
| DSH model config | `provider: tokenrhythm / model: deepseek-v4-flash-0731` (from your `~/.dsh/settings.yaml` `agent-default-model`) | Point `provider`/`model` at **your** default model. `{{model}}` is resolved from `agentOptions.model` — if the persona template says `{{model}} has no value`, you are missing `model`. |
| Hermes install | venv at `~/.hermes/hermes-agent/venv/bin/hermes`, gateway service `hermes-gateway.service` (user systemd) | `hermesBin` config must point at your hermes CLI; the gateway service name/port may differ. |
| WeChat channel | iLink personal-bot channel (`ilinkai.weixin.qq.com`) reached by Hermes | Your channel may be Telegram/Discord/Slack/etc. The **outbound** path only needs `hermes send --to <platform>:<target>` — switch `pushTarget` accordingly. The **inbound** trigger (Hermes skill / hook) is channel-specific. |
| `hermes send` targets | verified with `hermes send --list` | Run `hermes send --list` yourself; chat IDs are environment-specific. |
| HTTP loopback | `127.0.0.1:8643` | Change `port` if it collides; the host is hardcoded to loopback (security). |
| Session persistence | `~/.dsh/sessions` (per-user) | If your `DSH_HOME` differs, session resume paths change accordingly. |

**Known limits (not bugs):**

- **WeChat rate limit**: the iLink channel throttles `sendmessage` (`ret=-2` → 30s cooldown, handled by Hermes). Bursts of pushes can be dropped/serialized. Keep push volume low (the plugin pushes once per task state, which is fine).
- **No auth layer on the host**: `dsh web` has no authentication by design. Run it loopback-only; do not expose it.
- **rc-stage API drift**: any DSH upgrade needs a regression pass (see `DEVELOPMENT.md` for what to re-verify).

## Install

From GitHub (npm publish pending — package name reserved as `@dsh-pulse/dsh-hermes-bridge`):

```bash
git clone https://github.com/dsh-pulse/dsh-hermes-bridge.git
cd dsh-hermes-bridge && npm install   # installs peer deps if missing

# register in your web profile patch
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'
- insert:
    - id: hermes-bridge
      name: 'file:/absolute/path/to/dsh-hermes-bridge/lib/index.js'
      config:
        port: 8643
        authToken: '${env.DSH_BRIDGE_TOKEN}'   # REQUIRED — plugin refuses to start without it
        pushTarget: 'weixin:<chat_id>'          # REQUIRED
        hermesBin: '/path/to/hermes'            # optional, default 'hermes'
        workspaceRoots: ['/path/to/workspace']  # optional cwd whitelist
EOF
```

Requires `@deepseek-ai/cordis` (peer dependency) — ships inside DSH. The plugin is designed for the **web profile** (persistent host); do not install into `headless`.

## Configuration (Config schema)

| key | type | default | description |
|---|---|---|---|
| `port` | number | `8643` | loopback listen port (host is hardcoded `127.0.0.1`) |
| `authToken` | string | — | **required**; Bearer token checked on every request (constant-time compare) |
| `pushTarget` | string | — | **required**; e.g. `weixin:<chat_id>` — resolved by `hermes send` |
| `hermesBin` | string | `hermes` | path to the hermes CLI |
| `retries` | number | `1` | outbound push retries |
| `maxTextLen` | number | `1500` | push text truncation |
| `preset` | string | `standard` | agent preset mounted in session setup |
| `provider` / `model` | string | dsh defaults | agent model (align with your `agent-default-model`) |
| `workspaceRoots` | string[] | `[]` | cwd whitelist (realpath prefix check; empty = unrestricted) |
| `maxAgents` | number | `3` | resident session cap (LRU eviction) |
| `maxQueue` | number | `8` | task queue cap (429 when full) |
| `taskTtlMs` | number | `86400000` | finished task retention (24h) |

## API (all endpoints require `Authorization: Bearer <token>`)

| Endpoint | Description |
|---|---|
| `POST /v1/tasks` | Inbound task `{task, context?, cwd?, sessionId?, title?}` → `202 {taskId}` |
| `GET /v1/tasks/:id` | Task status + structured result (`changes/verification/leftovers`) |
| `POST /v1/tasks/:id/cancel` | Cancel (queued → failed immediately; running → intent flagged) |
| `POST /v1/notify` | Pure push `{text}` (no agent involved) |
| `GET /v1/health` | Liveness |

Pushback messages (one per state, no spam):

```
📥 已接单 br-xxxxxxxx
🔧 开跑 br-xxxxxxxx
✅ br-xxxxxxxx（6m12s）
改动：…
验证：…
遗留：…
```

## Security

- **Loopback only**: `server.listen(port, '127.0.0.1')` — the host is hardcoded, exposing it requires source changes.
- **Auth required**: `authToken` is mandatory; the plugin refuses to activate without it. Token lives in your profile patch (600 perms) or env, never in code.
- **cwd whitelist**: when `workspaceRoots` is set, paths outside it are rejected (`403`) both at ingress and inside `executeTask`.
- **Zero shell**: all child processes use `spawn(args[])` — task text never passes through a shell.
- **Redaction**: outbound push strips `sk-`/`sk_tr_`/`ghp_` token patterns and credentials paths before sending.

> ⚠️ This plugin executes arbitrary DSH agent work with full tool access. Only feed it trusted instructions (keep the WeChat-side discipline in your Hermes skill layer), and never expose the HTTP port beyond loopback.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `prompt variable "{{model}}" has no value` | `agentOptions.model` missing — set `model` (align with your `agent-default-model`). |
| Task reports `done` but result is empty | Check the session log for `turn/end` with `reason.kind == "error"` — the plugin now flags those as `failed`; verify model/provider. |
| `hermes send` fails `Could not resolve target` | Run `hermes send --list`, put the exact target in `pushTarget`. |
| `EADDRINUSE` on the port | Another instance holds it — change `port`, or restart the host once after code edits (ESM module cache). |
| WeChat pushes missing/serialized | iLink rate limit (`ret=-2`, 30s cooldown) — keep push volume low. |
| Hermes still runs headless instead of bridge | The plugin is invoked via `dsh-run.sh` which **internally tries the bridge first** (then falls back). If your skill calls something else, point it at `dsh-run.sh`. See `DEVELOPMENT.md` §Troubleshooting-Hermes. |

## Development

See **`DEVELOPMENT.md`** (EN) / **`DEVELOPMENT.zh-CN.md`** (中文) — architecture decisions, the problems we hit and how they were solved, test strategy, and what to re-verify after a DSH upgrade.

## License

MIT
