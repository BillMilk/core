# Pipeline、Executor 与 Parser

## 职责

```text
SessionManager -> RuntimeCoordinator -> CLI Driver -> Executor / PTY / AgentPipeline / Parser
                                     -> ACP Driver -> ACP Agent Registry -> Agent Definition
                                                   -> ACP SDK / adapter or native ACP CLI / Projector
                                     -> MsgStore / EventBus
```

- `SessionManager` 拥有 Session/Task/TeamRun 业务状态、环境组装、snapshot、auto-commit 和结束后处理，不持有 PTY/Pipeline。
- `RuntimeCoordinator` 按 Tower session 隔离 DriverSession，维护单 active turn、turnId/sequence、权限状态、迟到事件过滤和可等待销毁。
- CLI Driver 选择 Executor，并拥有 PTY、AgentPipeline、Parser、early event 和真实 child 退出跟踪。
- 通用 ACP Driver 拥有 adapter/native ACP process、initialize、session new/load、prompt/cancel、权限响应和协议清理；ACP stdout 不进入普通日志。
- ACP Agent Registry 按 `AgentType` 选择 Definition；Definition 负责 Provider 投影、可执行文件/adapter 解析、可用性、Session metadata 与 Agent 专属 model/effort/mode 配置。新增 ACP Agent 不复制 Driver。
- 用户可见的稳定 ACP Definition 包含 Claude Code、Codex、Qwen Code、Gemini CLI、Cursor Agent、Kiro CLI、OpenCode、Pi Coding Agent 和 Grok Build。Minion Code 仅保留历史兼容：保留 `AgentType`、Definition 和 legacy 内置 Provider ID，供已有 Session/Provider 按 ID 解析，但不得加入用户创建选项、公开 Agent/Provider 列表、Provider capability 响应或公开文档。`AgentType` 表示身份，不能再为 adapter 另造 `PI_ACP` 一类身份；运行协议只由 `RuntimeType.ACP` 表达。
- Native ACP 客户端共用 Definition 工厂完成可执行文件解析、Provider 投影和 Session 配置。Claude Code 与 Codex 的 adapter 及兼容 Runtime 通过 server 的固定 adapter 依赖随 Agent Tower 发布，显式 executable env 有效时才覆盖内置 Runtime；Pi CLI 作为 server production dependency 发布，默认解析 server `node_modules/.bin/pi`，仅由有效的 `PI_CODING_AGENT_PATH`/`PI_PATH` 覆盖。Pi MCP 通过隔离 `PI_CODING_AGENT_DIR`、Pi settings 和 `pi-mcp-adapter` 接入，Minion MCP 通过隔离 `PYTHONPATH` bridge 接入。不要 patch 第三方 adapter，也不要写用户全局配置。
- Agent Tower 托管的 MCP 启动配置统一由 `mcp-config.service.ts` 生成；Route、ACP Driver 和 Agent Definition 不得自行按 `import.meta.url` 推断 entry。源码开发态使用 server 自带的绝对 `tsx` loader 运行 `src/mcp/index.ts`，编译 CLI 与桌面 runtime 使用各自 `dist/mcp/index.js`；每次启动必须注入当前服务实例的 URL 与 internal token，入口或实例地址缺失时显式失败，不能降级为空 MCP 列表或静默连接默认端口。
- Definition 创建的临时配置可能包含内部 MCP token，必须使用 `0700` 目录和 `0600` 文件，并把幂等 cleanup 交给 ACP Driver；启动/握手失败、正常 close 和进程意外退出都必须触发清理。
- Runtime/Agent 专属的 Provider 协议元数据与兼容 Header 放在 Definition 投影层，并合并用户自定义配置；通用 ACP Driver 不感知具体网关认证或来源标识。
- Parser/ACP Projector 将输出转为 `NormalizedEntry` JSON Patch；MsgStore 生成统一 snapshot。
- ACP `tool_call_update` 是按 `toolCallId` 发送的局部更新；Projector 必须累计并合并工具状态，省略字段沿用旧值、显式 `null` 清除字段。保留 title/kind/status/content/locations/input/output 的结构化语义，不能用单次 update 重建并覆盖完整工具条目；ACP `pending` 也不等同于独立的 permission request。
- ACP adapter 可能用伪 `tool_call` 转发运行时诊断（例如 `mcp_startup.*`）；这类事件不计入用户工具调用，非阻塞失败应投影为警告日志并保留诊断内容，真正导致 turn/session 失败的错误仍使用错误日志。

DriverSession 可以跨 turn 保留协议连接和 external session id，但 MsgStore 是 turn-bound 资源，必须由 `runTurn` 注入。idle DriverSession 不得捕获 MsgStore，否则 SessionManager 释放 snapshot store 后，延迟 follow-up 会把输出写入失效对象并造成大对象常驻。

托管 Agent 的 workspace-service opaque credential 与 DriverSession/MCP transport 同生命周期：逻辑 turn 自然完成不撤销，CLI/ACP follow-up 继续使用原 credential；DriverSession dispose、显式 Session stop/delete、启动失败和 app destroy 必须撤销。显式 stop 因此会关闭 ACP DriverSession，后续 follow-up 通过持久化 external session id 重开连接并获得新 credential；sendMessage 为替换 active turn 做的健康 cancel 仍可复用连接。

ACP 在 sendMessage 替换 active turn 时先用 `session/cancel` 等待 prompt 收敛，健康 DriverSession 可供该 follow-up 复用；只有取消失败或超时才销毁连接。用户显式停止整个 Tower Session 时关闭 DriverSession，以便同步撤销其 credential。用户主动取消造成的 prompt rejection 不得投影为连接错误。同一 Tower Session 真正重连使用 `session/load`；agent 回放的历史必须先投影到临时 MsgStore，再与本地 snapshot 按稳定 ACP entry ID 做线性合并，本地 user message 保持权威，并以单个 `/entries` replacement patch 提交，不能逐条追加回放事件。跨 Tower Session 只续接原生上下文时优先使用 Agent 声明支持的 `session/resume`；不支持时回退 `session/load`，但 load 阶段的旧历史不得导入新的 Tower Session。

`Session.status = RUNNING` 跟随逻辑 Runtime turn 启动，每次初始 prompt 和 follow-up 都必须在 `startTurn` 边界持久化；不能依赖 OS process `started`，因为 ACP 会跨 turn 复用同一进程。process 事件只维护 `ExecutionProcess`，停止操作也必须优先检查 active turn，再使用持久化终态作兜底。

Route 不直接 spawn PTY，Parser 不更新 Prisma 或 Task 状态。

## 启动与结束

spawn 与 Pipeline attach 之间存在竞态。保留 `collectEarlyPtyEvents()` / `takeEarlyEvents()` 一次性交接，否则短命进程可能丢失 exit 并永久停在 RUNNING。

Session 结束后的 DB 状态、snapshot、auto-commit、commit message、Task review 和 TeamRun reconciliation 由 SessionManager/Team services 负责。OS child 使用独立 `runtimeInstanceId` 记入 `ExecutionProcess`，真实退出才写 exitCode，不能把 turn completion 当作 process exit。修改结束路径时覆盖正常完成、非零退出、stop、启动失败、并发删除和 server shutdown。

`AgentType` 表示 Agent 身份，`RuntimeType` 表示 CLI/ACP 执行协议。Provider 选择两者，Session 创建时固化 Runtime；创建时必须通过 shared Runtime 支持矩阵校验，纯 ACP Agent 不得无 Provider 回退到 CLI。同一 Session follow-up 不允许跨 Runtime 切换。TeamRun 存活判断使用 `hasActiveTurn()`，`AWAITING_PERMISSION` 是活跃且由用户控制的等待，不触发 heartbeat nudge。

`session:patch` 只标记 snapshot dirty；运行中按低频 checkpoint 持久化，所有 session 的 snapshot DB 写入经单一串行 writer 排队，相同 snapshot 跳过。external session id 持久化也复用该 writer，避免与 snapshot update 倒序提交。COMPLETED/FAILED/CANCELLED、pipeline 替换等边界必须 `await` 强制 flush；不能恢复为每 patch 写库或不断重置的短 debounce。

Codex `exec --json` 的成功 `turn.completed` 是逻辑完成边界，不必继续等待包装进程退出。Pipeline 必须先保留 raw stdout、处理完该 frame 的最终消息/usage 并标记 MsgStore finished，再通知 SessionManager 持久化 `COMPLETED`；残留 PTY 只在后台短暂宽限后清理。`turn.failed` 同样是一次性的失败逻辑边界，必须优先于随后 0/undefined PTY exit，持久化 `FAILED` 且不得触发成功 auto-commit/Task review。逻辑完成后的 auto-commit 绑定 generation，并在 follow-up 开始前完成或放弃，不能与新轮 Git 操作重叠。`turn.failed`、用户 stop、非零提前退出仍走各自失败/取消路径，logical completion、PTY exit 与 destroy 竞争时只允许一次终态和一次 parser finish。

## AgentPipeline

`OutputParser` 至少实现 `processData(data)` 和 `finish(exitCode?)`；支持逻辑完成边界的 parser 可选提供一次性的 `onTurnCompleted(listener)` 或 `onTurnFailed(listener)`。`onPatch` / `onSessionId` 属于 MsgStore，不是 Parser 接口；Parser 构造时接收 MsgStore，Pipeline 监听这些 MsgStore 事件后发 EventBus。

保持以下不变量：

- raw stdout 先写入 MsgStore；parser 失败仍可恢复日志。
- 捕获 `processData`/`finish` 异常，不从 node-pty callback 抛出。
- exit/destroy 竞争时 `finish()` 只运行一次。
- destroy 先 flush parser，再解除 patch listener。
- 所有退出路径释放 listener、PTY 和 cancellation 资源。

## Executor

实现 `BaseExecutor` 时提供 `agentType`、`displayName`、`buildCommandBuilder()` 和 `getAvailabilityInfo()`；按能力覆盖 slash commands、capabilities、follow-up 和 MCP config path。基类 `spawnFollowUp()` 默认抛 unsupported。

使用 `CommandBuilder`、`ExecutionEnv` 和跨平台 PTY wrapper，不拼 shell 字符串。处理 Windows ConPTY、executable 解析、stdin 临时文件权限/清理。日志不记录完整 prompt 或 secret；credential 参数加入 redaction 测试。

Provider 是主要配置入口，profiles 只保留兼容。Executor factory 根据 `AgentType` 和 provider config 动态创建实例。

Provider 显式连接凭证必须在每次 spawn 时从当前 Provider 重新解析，并通过单次 executor 环境投影。投影时显式覆盖或屏蔽父进程中会抢优先级的旧认证变量；运行中的 child 保持启动快照，不热更新 env/args。

自定义 Provider 的动态 credential `env_key` 不得使用 ExecutionEnv 已保护的 Agent Tower subprocess、TeamRun/MCP identity 或 service env 名；resolver/normalization 必须在 probe/save/spawn 前返回字段诊断，不能放宽子进程环境过滤来允许覆盖内部变量。

## Parser 与 MsgStore

Claude Code、Cursor Agent、Codex 有结构化 parser；Gemini 当前保留 raw stdout。Parser 缓冲不完整 frame，使用 `output/utils/patch.ts` 生成 RFC 6902 patch，并在 finish 处理残留数据。不要按任意 PTY chunk 直接 `JSON.parse`，未知或坏 frame 不能阻断后续输出。

改变 `NormalizedEntry` 时同步 `shared/log-adapter.ts` 和前端 LogStream/Todo/Token。使用导出的 `sessionMsgStoreManager`，不存在公共 `SessionMsgStoreManager.getInstance()`。

MsgStore patch `seq` 单调递增，并在内存上限下把淘汰消息折叠进 base snapshot。修改时验证 seq/stale replace、memory cap、token/session/message id、snapshot restore/persist，以及前端 seq-gap 恢复。

## 新增 Agent

检查这些接触点：

1. shared `AgentType` 与公开类型。
2. shared Runtime 支持矩阵、Provider capability/default provider，以及 Provider UI 的 Agent + Runtime 组合。
3. CLI Agent 检查 executor、command config、factory/export 和 parser；ACP Agent 检查 Registry Definition、启动/可用性、Provider 投影、Session 配置和 Projector 特例。
4. 前端 agent meta、provider/model selector、logo 和 capability 展示。
5. slash command、skill/MCP config；只有纳入本机安装能力时才加入 CLI environment manifest，不能因支持 ACP 就假装支持安装。
6. shared/server/web 构建与公开 provider 文档。

测试覆盖 early data/exit、parser throw、重复 exit/destroy、spawn failure、cancel/follow-up 和 snapshot restore。
