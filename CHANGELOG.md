# Changelog

## 0.1.0 (2026-08-18)

### feat(M0) — 出站推送最小闭环 / outbound push minimum loop

- `POST /v1/notify` + `GET /v1/health`，Bearer 认证，`hermes send` 零 shell 推送，token/凭据脱敏。
- Outbound notify + health endpoints, bearer auth, zero-shell `hermes send` push, credential redaction.

### feat(M1) — 入站调度 + 会话复用 / inbound dispatch + session reuse

- `POST /v1/tasks` 入站、任务队列、状态机（queued/running/done/failed）、按 cwd 常驻会话池、resume 接管指定会话、cwd 白名单、`ctx.jobs` 登记（Web UI 可见）。
- Inbound task dispatch, task queue with state machine, per-cwd persistent session pool, resume takeover, cwd whitelist, `ctx.jobs` registration.

### fix(M1)

- agent 任务真实执行修复 + 状态推送增强。
- Real agent task execution fix + richer status pushback.

### chore(M2) — npm 包化 / npm packaging

- scoped 包名 `@dsh-pulse/dsh-hermes-bridge`、README/DEVELOPMENT 双语、`publishConfig.access=public`、MIT license。
- Scoped package name, bilingual README/DEVELOPMENT, public publish config, MIT license.

## Unreleased

- 纳入 M0/M1 隔离测试（含 Node 18 全局 Web Crypto 垫片），新增 `npm test` 脚本与 GitHub Actions 测试工作流。
- Track M0/M1 isolated tests (with a Node 18 global Web Crypto shim), add `npm test` script and a GitHub Actions test workflow.
- 修复测试对本机 hermes 路径的依赖：改用假 hermes stub（延迟失败），重试断言在 CI 上确定成立。
- Fix the tests' dependence on a machine-local hermes path: a fake hermes stub (delayed failure) makes the retry assertion deterministic on CI.
