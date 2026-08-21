# dsh-hermes-bridge

DSH ↔ 微信双向桥插件：**入站调度（微信消息 → DSH agent 执行）+ 出站推送（任务进度/结果 → 微信）**，微信通道由 [Hermes](https://github.com/NousResearch/hermes-agent) gateway 承载。出站走 `hermes send` 零 LLM 消耗；按工作目录复用常驻会话，比一次性 headless 调用省 15–20× token。

> **插件边界**：本插件是 DSH 的**任务队列执行端点**——它**不实现微信协议本身**。微信侧（入站触发与传输）依赖**自部署的 Hermes Agent gateway** 加你自己的入站脚本；没有这些，微信那一半链路不会工作。

> **⚠️ 使用前必读——环境假设。** 本插件是基于**开发者本人的一套特定环境**开发验证的（见「环境假设」章节）。DSH 与 Hermes 的部署方式千奇百怪，本插件**无法**开箱即用于所有环境。请先逐条核对假设并适配你的配置，再期望它跑起来。

## 为什么做（Why）

「微信 → Hermes skill → `dsh --profile headless`」的单向手工链路能用，但每次冷启动烧 token、消息间丢失会话上下文、长任务跑完无法主动通知。本插件把这条链路产品化为 DSH 一等公民插件：

- **会话复用**：agent 按工作目录常驻（`ctx.agents.create/resume + followup`），后续消息续接同一会话。
- **自动回推**：每个任务推送 `接单 → 开跑 → 完成/失败`，带结构化 `改动/验证/遗留`。
- **零 LLM 出站**：通知走 `hermes send`（iLink REST），不发模型请求；bot-token 平台无需 gateway 在线。
- **Web UI 可见**：任务经 `ctx.jobs` 登记（无 job controller 时优雅降级）。

## 工作方式（How it works）

```
微信 ──▶ Hermes gateway ──▶ dsh-run.sh（bridge 优先）──▶ POST 127.0.0.1:8643/v1/tasks
                                                          │
                                                          ▼
                                          常驻会话池（按 cwd）
                                                          │
                                      DSH agent（全工具集, followup + whenIdle）
                                                          │
微信 ◀── hermes send ◀── 结构化结果回推 ◀──────────────────┘
```

入站：Hermes（或任意 HTTP 客户端）POST 任务到插件回环端点；插件分发给按 cwd 常驻的 agent 会话，并通过 `hermes send` 回推进度。bridge 不可用时，脚本自动回退一次性 `dsh --profile headless`。

## 环境假设（务必逐条核对）

本插件在**一台特定机器**上开发验证（部署细节见 `DEVELOPMENT.zh-CN.md`）。你的环境必然不同，请逐项适配：

| 假设 | 本项目取值 | 你需适配的 |
|---|---|---|
| DSH 版本 | `0.1.0-rc.7`（Node ≥ 22） | `ctx.agents`/`ctx.agentPresets`/session API 是 **rc 阶段快照**——DSH 升级可能破坏兼容。钉住你运行的 rc 版本，或改代码。 |
| DSH profile | **web profile**（常驻宿主，`dsh web` 保活插件） | 纯 headless 部署需自行保活插件（其 HTTP 回环必须长驻）。 |
| DSH 模型配置 | `provider: tokenrhythm / model: deepseek-v4-flash-0731`（取自 `~/.dsh/settings.yaml` 的 `agent-default-model`） | `provider`/`model` 指向**你的**默认模型。persona 模板报 `{{model}} has no value` = 缺 `model`。 |
| Hermes 安装 | venv 在 `~/.hermes/hermes-agent/venv/bin/hermes`，服务 `hermes-gateway.service`（用户 systemd） | `hermesBin` 配置指向你的 hermes CLI；服务名/端口可能不同。 |
| 微信通道 | iLink 个人 bot 通道（`ilinkai.weixin.qq.com`，经 Hermes 接入） | 你的通道可能是 Telegram/Discord/Slack 等。**出站**只需 `hermes send --to <平台>:<目标>`——改 `pushTarget` 即可；**入站**触发（Hermes skill / hook）随通道而异。 |
| `hermes send` 目标 | 经 `hermes send --list` 实测 | 自己跑 `hermes send --list`；chat id 是环境相关的。 |
| HTTP 回环 | `127.0.0.1:8643` | 端口冲突改 `port`；host 硬编码回环（安全）。 |
| 会话持久化 | `~/.dsh/sessions`（按用户） | 若你的 `DSH_HOME` 不同，resume 路径随之变化。 |

**已知限制（非 bug）：**

- **微信限流**：iLink 通道对 `sendmessage` 限频（`ret=-2` → 30s 冷却，Hermes 已处理）。推送突发会被丢弃/排队。保持推送频率低（插件每任务状态推一次，正常够用）。
- **宿主无认证层**：`dsh web` 本身无认证（设计如此）。只跑回环，勿对外暴露。
- **rc 阶段 API 漂移**：DSH 任何升级都需回归（见 `DEVELOPMENT.zh-CN.md` 需复验清单）。

## 安装

从 npm 安装（已发布 `@dsh-pulse/dsh-hermes-bridge`）：

```bash
dsh plugin --profile web add @dsh-pulse/dsh-hermes-bridge
```

或从 GitHub 分发：

```bash
git clone https://github.com/dsh-pulse/dsh-hermes-bridge.git
cd dsh-hermes-bridge && npm install   # 缺 peer 依赖时补装

# 在 web profile patch 注册
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'
- insert:
    - id: hermes-bridge
      name: 'file:/绝对路径/dsh-hermes-bridge/lib/index.js'
      config:
        port: 8643
        authToken: '${env.DSH_BRIDGE_TOKEN}'   # 必填——缺了插件拒绝激活
        pushTarget: 'weixin:<chat_id>'          # 必填
        hermesBin: '/path/to/hermes'            # 可选，默认 'hermes'
        workspaceRoots: ['/path/to/workspace']  # 可选 cwd 白名单
EOF
```

需要 `@deepseek-ai/cordis`（peer 依赖）——DSH 自带。插件面向 **web profile**（常驻宿主）设计，勿装进 headless。

## 配置（Config schema）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `port` | number | `8643` | 回环监听端口（host 硬编码 `127.0.0.1`） |
| `authToken` | string | — | **必填**；每个请求校验 Bearer（恒定时间比较） |
| `pushTarget` | string | — | **必填**；如 `weixin:<chat_id>`——由 `hermes send` 解析 |
| `hermesBin` | string | `hermes` | hermes CLI 路径 |
| `retries` | number | `1` | 出站推送重试次数 |
| `maxTextLen` | number | `1500` | 推送文本截断 |
| `preset` | string | `standard` | 会话 setup 挂载的 agent preset |
| `provider` / `model` | string | dsh 默认 | agent 模型（对齐你的 `agent-default-model`） |
| `workspaceRoots` | string[] | `[]` | cwd 白名单（realpath 前缀校验；空 = 不限制） |
| `maxAgents` | number | `3` | 常驻会话上限（LRU 淘汰） |
| `maxQueue` | number | `8` | 任务队列上限（满则 429） |
| `taskTtlMs` | number | `86400000` | 已完成任务保留时长（24h） |

## API（所有端点需 `Authorization: Bearer <token>`）

| 端点 | 说明 |
|---|---|
| `POST /v1/tasks` | 入站任务 `{task, context?, cwd?, sessionId?, title?}` → `202 {taskId}` |
| `GET /v1/tasks/:id` | 任务状态 + 结构化结果（`changes/verification/leftovers`） |
| `POST /v1/tasks/:id/cancel` | 取消（queued → 立即 failed；running → 标记意图） |
| `POST /v1/notify` | 纯推送 `{text}`（不经 agent） |
| `GET /v1/health` | 存活检查 |

回推消息（每状态一条，不刷屏）：

```
📥 已接单 br-xxxxxxxx
🔧 开跑 br-xxxxxxxx
✅ br-xxxxxxxx（6m12s）
改动：…
验证：…
遗留：…
```

## 安全

- **仅回环**：`server.listen(port, '127.0.0.1')`——host 硬编码，要暴露需改源码。
- **必填认证**：`authToken` 必填，缺了拒绝激活。token 只存在于 profile patch（600 权限）或 env，绝不写进代码。
- **cwd 白名单**：配置 `workspaceRoots` 后，白名单外路径在入站与 `executeTask` 内均被拒（`403`）。
- **零 shell**：子进程一律 `spawn(args[])`——任务文本永不过 shell。
- **出站脱敏**：推送前剥掉 `sk-`/`sk_tr_`/`ghp_` token 模式与 credentials 路径。

> ⚠️ 本插件执行任意 DSH agent 工作（全工具权限）。只喂可信指令（微信侧纪律由你的 Hermes skill 层维持），且永不把 HTTP 端口暴露到回环之外。

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `prompt variable "{{model}}" has no value` | 缺 `agentOptions.model`——设置 `model`（对齐你的 `agent-default-model`）。 |
| 任务报 `done` 但结果为空 | 看会话日志里 `turn/end` 的 `reason.kind == "error"`——插件现已把这类标为 `failed`；核对模型/provider。 |
| `hermes send` 报 `Could not resolve target` | 跑 `hermes send --list`，把准确目标写进 `pushTarget`。 |
| 端口 `EADDRINUSE` | 另一实例占用——改 `port`，或改代码后重启宿主一次（ESM 模块缓存）。 |
| 微信推送丢失/排队 | iLink 限流（`ret=-2`，30s 冷却）——保持推送频率低。 |
| Hermes 仍走 headless 不走 bridge | 插件经 `dsh-run.sh` 调用，该脚本**内部先试 bridge**（失败才回退）。若你的 skill 调别的脚本，指向 `dsh-run.sh`。见 `DEVELOPMENT.zh-CN.md`。 |

## 开发文档

见 **`DEVELOPMENT.zh-CN.md`**（中文）/ **`DEVELOPMENT.md`**（英文）——架构决策、踩坑与解决、测试策略、DSH 升级后需复验清单。

## License

MIT
