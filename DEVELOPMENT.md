# dsh-hermes-bridge — Development Notes

How this plugin was built, the problems we hit, how they were solved, and what to re-verify after a DSH upgrade. Written for developers maintaining or extending the plugin. For usage, see `README.md`.

## 1. Development environment (what it was verified against)

| Component | Version / path |
|---|---|
| DSH | `0.1.0-rc.7` (Node v22), installed at `~/.local/lib/node_modules/@deepseek-ai/dsh/` |
| DSH profile | `web` (persistent host, `dsh web`); session store `~/.dsh/sessions` |
| Default model | `provider: tokenrhythm / model: deepseek-v4-flash-0731` (`~/.dsh/settings.yaml` → `agent-default-model`) |
| Hermes | venv `~/.hermes/hermes-agent/venv/bin/hermes`, gateway `hermes-gateway.service` (user systemd, port 8642) |
| WeChat channel | iLink personal bot (`ilinkai.weixin.qq.com`), reached via Hermes `send_weixin_direct()` |
| Reference implementation | `chushixixin/dsh-harness-mcp-server` (6★) — cloned and read in full; its session-pool/executeTask patterns were absorbed |

The plugin intentionally has **zero runtime dependencies** besides `@deepseek-ai/cordis` (peer, ships inside DSH). During development, imports of `@deepseek-ai/dsh-llm` / `dsh-session` / `dsh-scope` were resolved by symlinking the DSH-internal `node_modules/@deepseek-ai` into the plugin's `node_modules` — the published package does not need this (cordis resolves peers at the host).

## 2. Architecture decisions (and why)

- **Outbound = `hermes send` CLI**, not an HTTP push. Zero LLM cost, works without the gateway for bot-token platforms, and `hermes send --list` makes target discovery explicit. The api_server cron HTTP path exists but burns an agent turn — rejected as primary.
- **Inbound = plugin-owned HTTP loopback** (`127.0.0.1:<port>`), not polling the gateway. Polling would require inventing a "pending task" mailbox; HTTP gives sub-second latency and clean failure semantics. The pattern is proven by the reference implementation (`http.createServer().listen(8090, '127.0.0.1')` inside `apply()`).
- **Session pool keyed by realpath(cwd)** with a per-key serial lock, LRU eviction, and resume-from-persistence on restart. This is the token saver: one resident session per working directory instead of a cold `dsh --profile headless` per message.
- **Tasks registered via `ctx.jobs` when available**, degrading silently when the job controller is absent (background jobs need `@deepseek-ai/dsh-tool-jobs` in the composition).
- **Bridge-first shell script**: the Hermes-side entry (`dsh-run.sh`) tries the bridge first and only falls back to headless. This is the load-bearing decision — see §4.

## 3. Problems we hit and how they were solved

### 3.1 `prompt variable "{{model}}" has no value` — tasks "succeed" with empty results

**Symptom**: every task ended `done` but the assistant text was empty; the session log showed `turn/end` with `reason.kind == "error"`, message `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona")`.

**Root cause**: the persona template is `You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.` and `{{model}}` is resolved from `context.agent.options.model` (`dsh-agent-loop` registers it via `ctx.systemPrompt.variable("model", (ctx) => ctx.agent?.options.model)`). We created agents without `agentOptions`, so `options.model` was `undefined`.

**Fix**: always pass `agentOptions: { provider, model }` in both `create` and `resume` (defaults aligned to `agent-default-model`). The reference implementation passes `provider` only and would hit the same issue in a web-profile run.

### 3.2 `whenIdle()` returns on error turns too — false "done"

**Symptom**: 3.1's tasks were reported `done` because `whenIdle()` resolves when the agent goes idle, including after an error turn.

**Fix**: after `whenIdle()`, scan the delta log for the last `turn/end` and throw if `reason.kind == "error"`. The task then fails with the real cause instead of a fake success.

### 3.3 cwd whitelist was only enforced inside `executeTask`

**Symptom**: a task with an out-of-whitelist cwd returned `202` (accepted), then failed asynchronously.

**Fix**: pre-check cwd at the HTTP ingress (`403 cwd not allowed`) in addition to the `realpath` check inside `executeTask`.

### 3.4 The Hermes side: three nested traps (the hard part)

The outbound/inbound plugin itself was straightforward. Wiring **WeChat → Hermes → plugin** took three rounds of root-causing:

**Trap 1 — the shell template made the agent expand scope.** The original `dsh-run.sh` injected `…了解进度后继续开发…` (understand progress, keep developing). A "list the .mjs files" request turned into a full project refactor (the agent built a whole GEO/JSON-LD feature set). **Fix**: the template now says *only execute the task; do not extend or "improve" anything unless the task explicitly asks*.

**Trap 2 — SKILL.md edits never took effect (two layers of caching).** We edited the Hermes skill file repeatedly; nothing changed. Reading `prompt_builder.py` revealed **two layers**:

- Layer 1: an **in-process cache** (`_SKILLS_PROMPT_CACHE`) keyed by dirs/tools/etc. — **not** by SKILL.md mtime. While the gateway process lives, edits never invalidate it.
- Layer 2: a disk **snapshot** (`.skills_prompt_snapshot.json`) whose manifest is mtime+size of every SKILL.md — checked only when Layer 1 misses.

**Fix**: restart the gateway (`systemctl --user restart hermes-gateway.service`). Only then does Layer 1 miss and Layer 2 rebuild with the new description.

**Trap 3 — the description is truncated to 60 chars, and Hermes never re-views the skill.** Two independent causes:

- `SKILL_PROMPT_DESC_LIMIT = 60` in `skill_utils.py`; `extract_skill_description` truncates (`desc[:57] + "..."`). Our carefully worded bridge instructions lived past char 60 and were **never seen** by the agent. **Fix**: put the load-bearing instruction in the first 60 chars: `指挥dsh→必须走dsh-bridge-push.sh派单(bridge常驻会话127.0.0.1:8643),禁...`.
- Even with the correct description, Hermes acted from **session memory**: the SQLite tool log showed it called `skill_view` once (on 8-17) and thereafter always ran `dsh-run.sh` directly from habit, never re-reading the skill. **Fix (load-bearing)**: make `dsh-run.sh` itself **bridge-first** — it curls `/v1/tasks` first and only falls back to headless. Whatever script Hermes calls, the bridge wins.

### 3.5 ESM module cache — plugin code edits need a host restart

The cordis loader imports the plugin with a plain dynamic `import()`; the same URL is cached for the process lifetime. **Fix**: after changing plugin code, restart the host once (`dsh web`; we keep a `restart-dsh-web.sh` that kills, relaunches with identical args, and health-checks 3080 + 8643).

### 3.6 `ctx.jobs` background jobs unavailable

`jobs.start(...)` threw `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)`. **Fix**: wrap in try/catch and fall back to direct execution; log a warning. Task pushback works regardless (it goes through `hermes send`, not the jobs UI).

### 3.7 WeChat/iLink rate limit

Sending many pushes in a burst hit `Weixin send failed: iLink sendmessage rate limited; cooldown active for 30.0s`. This is upstream (`RATE_LIMIT_ERRCODE = -2` in `gateway/platforms/weixin.py`). **Fix/mitigation**: keep push volume low (one per task state); the plugin retries once. Not fixable from the plugin.

### 3.8 `{{model}}`-style failures surfaced as "done" — regression guard

See 3.1/3.2: the turn-error check is the guard that keeps any future silent-turn-failure from being misreported.

## 4. Test strategy

- **`test-m0.mjs`** (11 cases): auth 401, health, JSON/body validation, retry-on-failure (fake target → 502 + retry timing), 404, redaction — drives `apply()` with a mock ctx, no real WeChat.
- **`test-m1.mjs`** (14 cases): full queue/state-machine lifecycle with a mock `ctx.agents` (create/resume/followup/whenIdle), session reuse (create called once for two tasks on the same cwd), resume branch, cwd whitelist 403, cancel, 404, health.
- **Real run**: `curl POST /v1/tasks` against the live host with a trivial task; verify `done` + structured result + WeChat pushback. Two consecutive tasks must share the same `sessionId`.
- **Hermes-side**: verify from the Hermes SQLite session store which script it actually ran (`hermes sessions export`), and check `.skills_prompt_snapshot.json` contains the current description.

## 5. What to re-verify after a DSH upgrade

The agent APIs are rc-stage. After any `npm install -g @deepseek-ai/dsh` bump:

1. `ctx.agents.create/resume` signatures still match (esp. `agentOptions` + `setup`).
2. `ctx.agentPresets.mount` + the `scopeOf` rc.6-bug guard still hold.
3. Session log event shapes (`assistant/message`, `turn/end`) — the extractor and error detection depend on them.
4. `ctx.jobs.start` contract (kind/label/run hooks) unchanged.
5. Re-run `test-m0.mjs` + `test-m1.mjs`, then one real task.

## 6. Roadmap

- **npm publish** (`@dsh-pulse/dsh-hermes-bridge` reserved) → unlocks dshhub auto-indexing (npm `dsh-plugin` keyword). Currently distributed via the GitHub repo.
- Session token-growth policy (fork old sessions when a session exceeds a size/age threshold — `ctx.sessions.fork()` exists; thresholds TBD).
- Optional heartbeat push for long tasks (config flag exists; off by default).
