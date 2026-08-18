# dsh-hermes-bridge — 开发笔记

本插件的构建过程、踩坑与解决、DSH 升级后需复验清单。面向维护/扩展本插件的开发者。使用说明见 `README.zh-CN.md`。

## 1. 开发环境（实测基准）

| 组件 | 版本 / 路径 |
|---|---|
| DSH | `0.1.0-rc.7`（Node v22），安装于 `~/.local/lib/node_modules/@deepseek-ai/dsh/` |
| DSH profile | `web`（常驻宿主，`dsh web`）；会话存储 `~/.dsh/sessions` |
| 默认模型 | `provider: tokenrhythm / model: deepseek-v4-flash-0731`（`~/.dsh/settings.yaml` → `agent-default-model`） |
| Hermes | venv `~/.hermes/hermes-agent/venv/bin/hermes`，gateway `hermes-gateway.service`（用户 systemd，端口 8642） |
| 微信通道 | iLink 个人 bot（`ilinkai.weixin.qq.com`），经 Hermes `send_weixin_direct()` 接入 |
| 参考实现 | `chushixixin/dsh-harness-mcp-server`（6★）——clone 通读，吸收其会话池/executeTask 设计 |

插件**除 `@deepseek-ai/cordis`（peer，DSH 自带）外零运行时依赖**。开发期通过把 DSH 内部 `node_modules/@deepseek-ai` 软链进插件 `node_modules` 来解析 `dsh-llm`/`dsh-session`/`dsh-scope` 的 import；发布包无需此步（cordis 在宿主侧解析 peer）。

## 2. 架构决策（及理由）

- **出站 = `hermes send` CLI**，不用 HTTP 推送。零 LLM 成本；bot-token 平台无需 gateway 在线；`hermes send --list` 让目标发现显式化。api_server 的 cron HTTP 路径存在但烧一次 agent turn——弃为主通道。
- **入站 = 插件自持 HTTP 回环**（`127.0.0.1:<port>`），不轮询 gateway。轮询需自造"待取任务"信箱；HTTP 秒级延迟 + 失败语义干净。模式已被参考实现验证（`apply()` 内 `http.createServer().listen(8090, '127.0.0.1')`）。
- **会话池按 realpath(cwd) 键控** + 每键串行锁 + LRU 淘汰 + 重启后从持久化 resume。省 token 的核心：每个工作目录一个常驻会话，而不是每条消息冷启动 `dsh --profile headless`。
- **任务经 `ctx.jobs` 登记（可用时）**，无 job controller 时静默降级（后台任务需组合加载 `@deepseek-ai/dsh-tool-jobs`）。
- **bridge 优先的 shell 脚本**：Hermes 侧入口（`dsh-run.sh`）先试 bridge，失败才回退 headless。这是承重决策——见 §4。

## 3. 踩坑与解决（按实际开发顺序）

### 3.1 `prompt variable "{{model}}" has no value` —— 任务"成功"但结果为空

**现象**：每个任务都 `done` 但 assistantText 为空；会话日志显示 `turn/end` 的 `reason.kind == "error"`，消息 `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona")`。

**根因**：persona 模板为 `You are a coding agent powered by the {{model}} model…`，而 `{{model}}` 取自 `context.agent.options.model`（`dsh-agent-loop` 通过 `ctx.systemPrompt.variable("model", …)` 注册）。我们 create 时没传 `agentOptions`，`options.model` 为 `undefined`。

**解决**：`create` 与 `resume` 都显式传 `agentOptions: { provider, model }`（默认对齐 `agent-default-model`）。参考实现只传 provider，在 web profile 跑同样会踩。

### 3.2 `whenIdle()` 在错误 turn 也会返回 —— 误报 done

**现象**：3.1 的任务被报 `done`，因为 `whenIdle()` 在 agent 空闲（含出错 turn）时就 resolve。

**解决**：`whenIdle()` 后扫描增量日志最后一个 `turn/end`，`reason.kind == "error"` 则抛错。任务以真实原因失败，而非虚假成功。

### 3.3 cwd 白名单只在 `executeTask` 内部校验

**现象**：白名单外 cwd 的任务返回 `202`（受理），随后异步失败。

**解决**：HTTP 入站预检 cwd（`403 cwd not allowed`），与 `executeTask` 内的 `realpath` 复检互补。

### 3.4 Hermes 侧：三层嵌套的坑（最耗时部分）

插件本身（出站/入站）很直接。**微信 → Hermes → 插件**的接线花了三轮根因：

**坑 1 —— shell 模板引导 agent 扩权。** 原 `dsh-run.sh` 注入「…了解进度后继续开发…」。「列一下 .mjs 文件」变成整个项目重构（agent 顺手实现了一套 GEO/JSON-LD 功能）。**解决**：模板改为「只执行任务本身，除非任务明确要求，否则不要扩展/顺手优化」。

**坑 2 —— 改 SKILL.md 永不生效（两层缓存）。** 反复改 skill 文件毫无变化。读 `prompt_builder.py` 发现**两层缓存**：

- 层 1：**进程内存缓存**（`_SKILLS_PROMPT_CACHE`），key 是目录/工具等——**不含 SKILL.md mtime**。gateway 进程活着，编辑永不失效。
- 层 2：磁盘**快照**（`.skills_prompt_snapshot.json`），manifest 是所有 SKILL.md 的 mtime+size——只在层 1 miss 时才检查。

**解决**：重启 gateway（`systemctl --user restart hermes-gateway.service`）。层 1 才 miss，层 2 才用新描述重建。

**坑 3 —— 描述被截断到 60 字符 + Hermes 从不重新看 skill。** 两个独立原因：

- `skill_utils.py` 的 `SKILL_PROMPT_DESC_LIMIT = 60`，`extract_skill_description` 截断（`desc[:57] + "..."`）。我们精心写的 bridge 指令在第 60 字符之后，agent **永远看不到**。**解决**：承重指令压进前 60 字符：`指挥dsh→必须走dsh-bridge-push.sh派单(bridge常驻会话127.0.0.1:8643),禁...`。
- 即使描述正确，Hermes 凭**会话记忆**行事：SQLite 工具日志显示它只在 8-17 调过一次 `skill_view`，此后一直凭习惯直接跑 `dsh-run.sh`，从不重新读 skill。**解决（承重）**：让 `dsh-run.sh` 本身 **bridge 优先**——先 curl `/v1/tasks`，失败才回退 headless。Hermes 调哪个脚本都绕不开 bridge。

### 3.5 ESM 模块缓存 —— 改插件代码需重启宿主

cordis loader 用普通动态 `import()` 加载插件，同一 URL 进程内永久缓存。**解决**：改完插件代码重启宿主一次（`dsh web`；我们备有 `restart-dsh-web.sh`：kill → 同参数拉起 → 健康检查 3080 + 8643）。

### 3.6 `ctx.jobs` 后台任务不可用

`jobs.start(...)` 抛 `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)`。**解决**：try/catch 包裹，降级直接执行并记日志。任务回推不受影响（走 `hermes send`，不依赖 jobs UI）。

### 3.7 微信/iLink 限流

突发连推触发 `Weixin send failed: iLink sendmessage rate limited; cooldown active for 30.0s`。这是上游限制（`gateway/platforms/weixin.py` 的 `RATE_LIMIT_ERRCODE = -2`）。**缓解**：保持推送频率低（每任务状态一条）；插件重试一次。插件侧无法根治。

### 3.8 静默 turn 失败的回归防线

见 3.1/3.2：turn 错误检测是防线，保证今后任何静默 turn 失败都不会被误报为 done。

## 4. 测试策略

- **`test-m0.mjs`**（11 例）：401 认证、health、JSON/请求体校验、失败重试（假 target → 502 + 重试耗时）、404、脱敏——mock ctx 驱动 `apply()`，不真发微信。
- **`test-m1.mjs`**（14 例）：完整队列/状态机生命周期（mock `ctx.agents` 的 create/resume/followup/whenIdle）、会话复用（同 cwd 两任务 create 只调一次）、resume 分支、cwd 白名单 403、cancel、404、health。
- **真实跑**：对线上宿主 `curl POST /v1/tasks` 提交琐碎任务，验证 `done` + 结构化结果 + 微信回推；连续两任务必须同 `sessionId`。
- **Hermes 侧**：从 Hermes SQLite 会话库确认它实际跑的脚本（`hermes sessions export`），并核对 `.skills_prompt_snapshot.json` 是否含当前描述。

## 5. DSH 升级后需复验清单

agent API 是 rc 阶段快照。任何 `npm install -g @deepseek-ai/dsh` 升级后：

1. `ctx.agents.create/resume` 签名仍匹配（尤其 `agentOptions` + `setup`）。
2. `ctx.agentPresets.mount` + rc.6 的 `scopeOf` 守卫仍成立。
3. 会话日志事件形状（`assistant/message`、`turn/end`）——提取器与错误检测依赖它们。
4. `ctx.jobs.start` 契约（kind/label/run hooks）未变。
5. 重跑 `test-m0.mjs` + `test-m1.mjs`，再跑一个真实任务。

## 6. Roadmap

- **npm 发布**（`@dsh-pulse/dsh-hermes-bridge` 已预留）→ 解锁 dshhub 自动收录（npm `dsh-plugin` 关键词）。当前经 GitHub 仓库分发。
- 会话 token 增长策略（会话超尺寸/轮龄阈值后 fork 归档——`ctx.sessions.fork()` 已有，阈值待定）。
- 长任务心跳推送（配置开关已有，默认关）。
