# ACP Runtime 支持实施计划

- 日期：2026-07-23
- 状态：Implemented（Codex ACP 首个纵向切片）
- 架构决策：`docs/adr/2026-07-23-agent-runtime-core-and-drivers.md`
- 参考 Demo：`/Users/shitian/Work/shitian/test/.worktrees/at/ae4c61da`

## 1. 目标

在不破坏现有 CLI Session、Solo、Conversation 和 TeamRun 行为的前提下，引入 Runtime Core +
Runtime Drivers，并以 ACP Driver 跑通以下闭环：

```text
Provider 选择 ACP
  -> 创建或恢复 RuntimeSession
  -> initialize + session/new|load
  -> prompt
  -> message/tool/plan/usage 流式更新
  -> permission request/response
  -> cancel 或 turn completion
  -> snapshot / auto-commit / Task / TeamRun 后处理
  -> follow-up
```

首个纵向切片建议使用 Codex ACP，现有 CLI Provider 保持默认行为。

## 2. 实施原则

1. 先建立 Runtime 契约和 CLI 等价适配，再接 ACP。
2. `SessionManager` 保留业务不变量，Runtime 不直接操作 Task/TeamRun。
3. Provider 缺少 `runtimeType` 时默认 CLI，升级不改变已有用户行为。
4. ACP stdout 是协议流，不进入 `session:stdout` 或普通 snapshot。
5. 所有跨端状态放在 `@agent-tower/shared`。
6. 所有 Socket 状态都有 REST/snapshot 重连补偿。
7. ACP capabilities 以 initialize 协商结果为准。
8. adapter、SDK 和真实 smoke 使用精确版本，不使用未经验证的浮动范围。
9. 先覆盖 macOS/Linux 开发运行，再以实际产品范围验证 Windows、Desktop 和 Docker。
10. 每个 Phase 保持可构建；CLI 回归失败时不继续推进 ACP 功能。

## 3. 当前接触面

| 层 | 当前模块 | 预计变化 |
| --- | --- | --- |
| Shared | `packages/shared/src/types.ts` | RuntimeType、capabilities、permission/runtime state DTO |
| Shared Socket | `packages/shared/src/socket/events.ts` | permission/runtime state 实时事件 |
| Prisma | `packages/server/prisma/schema.prisma` | Session 固化 runtimeType 和 externalSessionId |
| Process ledger | `ExecutionProcess`、SessionManager/Runtime lifecycle sink | 按真实 child 启动/退出维护，不按 turn 完成维护 |
| Provider | `packages/server/src/executors/providers.ts` | runtimeType/acp config 兼容读写与备份 |
| Session | `packages/server/src/services/session-manager.ts` | 委托 RuntimeCoordinator，保留业务 finalization |
| CLI | `executors/`、`pipeline/`、`output/` | 包装为 CLI Driver，保留现有实现和不变量 |
| ACP | 新增 `packages/server/src/runtime/drivers/acp/` | SDK、连接、进程、映射、能力和权限 |
| Container | `packages/server/src/core/container.ts` | RuntimeCoordinator 单例生命周期 |
| App | `packages/server/src/app.ts` | `onClose` await runtime disposal |
| Routes | `packages/server/src/routes/sessions.ts` | runtime state 与 permission response |
| EventBus/Socket | server/shared gateway | permission 通知和 listener cleanup |
| TeamRun | reconciler、scheduler、heartbeat | active turn 和 pending approval 语义 |
| Web | session hook、agent panel、Provider settings | Runtime 选择、权限 UI、重连恢复 |
| MCP | `mcp-config.service.ts` | 构造 ACP `mcpServers`，隔离 TeamRun identity |
| Publish | server publish、Desktop、Docker | SDK/adapter/node runtime 打包与 smoke |
| Docs | skill reference、公开 integrations/provider 文档 | 实现落地后同步真实边界与用户行为 |

## 4. 目标目录

```text
packages/server/src/runtime/
├── contracts.ts
├── runtime-registry.ts
├── runtime-coordinator.ts
├── runtime-session.ts
├── runtime-event-sink.ts
├── errors.ts
├── drivers/
│   ├── cli/
│   │   ├── cli-runtime-driver.ts
│   │   └── cli-driver-session.ts
│   └── acp/
│       ├── acp-runtime-driver.ts
│       ├── acp-driver-session.ts
│       ├── process-manager.ts
│       ├── capabilities.ts
│       ├── event-projector.ts
│       ├── permission-registry.ts
│       └── agents/
└── __tests__/
```

CLI 的 `BaseExecutor`、`AgentPipeline` 和 Parser 暂时保留原目录。CLI Driver 通过组合使用它们，
不在本项目中进行无关目录重排。

## 5. Phase 0：兼容性与协议探针

**目标：** 在修改产品契约前固定实际依赖和能力范围。

当前 Demo 的已知基线是 Node `>=22.12.0`、`@agentclientprotocol/sdk@1.2.1` 和
`@agentclientprotocol/codex-acp@1.1.2`；Agent Tower 当前 npm 契约仍为 Node `>=18.0.0`。
这些版本只作为探针起点，不直接成为 Agent Tower 的发布承诺。

### 工作项

- 固定并记录 `@agentclientprotocol/sdk` 和第一批 adapter 的精确版本。
- 用 Demo 的 probe/smoke 验证当前机器上的 initialize、new、load、prompt、cancel 和 permission。
- 在 Node 18、20、22 上运行 SDK import、fake agent contract 和真实 adapter smoke。
- 检查当前 Electron 33 的 Node ABI/runtime 是否能执行 SDK 和 adapter。
- 检查 Docker 内的 CLI 路径、HOME、凭据和 adapter 启动方式。
- 确认 Codex ACP 的能力：`loadSession`、prompt capability、session mode/config options。
- 确认 adapter 是否需要补丁；补丁必须幂等并有版本断言。
- 输出兼容矩阵，不把单机验证结果扩写为通用承诺。

### 建议复用 Demo

- `src/main/acp/runtime.ts`
- `src/main/acp/process-manager.ts`
- `src/main/acp/capabilities.ts`
- `src/main/acp/errors.ts`
- `src/main/acp/agents/`
- `scripts/probe-acp.mts`
- `scripts/smoke-acp.mts`
- `tests/unit/runtime/`

### 验收

- 已选择首版 SDK/adapter 精确版本。
- 已决定保留 Node 18 或提升最低 Node 版本。
- 已明确 npm、Desktop 和 Docker 的 adapter 来源。
- fake agent 可以稳定复现 completion、permission、cancel、timeout 和 process exit。

## 6. Phase 1：Shared 与持久化契约

**目标：** 建立向后兼容的数据和跨端类型基础。

### Shared 类型

建议新增：

```ts
export enum RuntimeType {
  CLI = 'CLI',
  ACP = 'ACP',
}

export type RuntimeTurnState =
  | 'IDLE'
  | 'RUNNING'
  | 'AWAITING_PERMISSION'
  | 'CANCELLING'
  | 'DISPOSED'
```

同时定义：

- `RuntimeCapabilities`
- `RuntimePermissionRequest`
- `RuntimePermissionOption`
- `RuntimeStateDto`
- `RuntimeErrorDto`
- Provider 的 ACP 配置类型

Provider backup/import schema 增加可选 `runtimeType` 和 ACP config；旧 backup 缺少字段时视为 CLI。

### Prisma

建议在 `Session` 增加：

```prisma
runtimeType      String @default("CLI")
externalSessionId String?
```

`externalSessionId` 替代从 `logSnapshot.sessionId` 猜测恢复 identity 的主路径。读取时暂时保留 snapshot
fallback，以兼容升级前的 Session；写入新 external session ID 时同时更新 MsgStore 和字段。

若 SQLite `db push` 对已有数据库的非空 default 字段可安全应用，则不需要历史数据重写。仍需增加升级
测试；若需要转换历史数据，则提升 `dataMigrationVersion` 并在 startup migration 中幂等处理。

### 验收

- 旧 Provider JSON、旧 backup 和旧 Session 可读取。
- 新 Session 固化 runtimeType。
- Provider 后续修改不会改变 Session runtimeType。
- Prisma generate、shared build、server build 通过。

## 7. Phase 2：Runtime Core 与 CLI 等价迁移

**目标：** 在没有 ACP 产品行为的情况下，让现有 CLI 通过 Runtime Core 运行。

### Runtime Core

实现：

- `RuntimeRegistry`：静态注册 CLI/ACP Driver；本阶段只启用 CLI。
- `RuntimeCoordinator`：按 Tower sessionId 管理 RuntimeSession。
- `RuntimeSession`：维护 runtimeInstanceId、状态、turnId、sequence、capabilities 和 DriverSession。
- `RuntimeEventSink`：校验 sessionId/turnId，只接收 patch、identity、permission、usage 和 progress；
  `runTurn()` settlement 由 Runtime Core 转换为唯一 terminal event。
- Runtime lifecycle sink：用 sessionId/runtimeInstanceId 关联 child/connection 的启动与退出，不把它们
  伪装成 turn terminal event。
- `disposeAll()`：有界、幂等、可等待。

### CLI Driver

CLI Driver 组合现有：

- Provider -> Executor factory
- `ExecutionEnv`
- `BaseExecutor.spawn/spawnFollowUp`
- `AgentPipeline`
- Parser
- MsgStore

建议先把现有行为包装成 DriverSession，而不是移动代码。需要维持：

- early PTY events。
- raw stdout fallback。
- terminal exactly-once。
- `runTurn()` settlement 与 PTY exit/logical completion 的竞态只能形成一个 Runtime terminal event。
- Codex logical completion/failed 优先级。
- sendMessage generation 和 auto-commit reservation。
- stop、并发删除、spawn failure 和 shutdown 补偿。
- terminal input/resize 仅在 CLI capability 下可用。

### SessionManager 迁移

- `pipelines` 和 `pendingSpawns` 的所有权逐步转入 CLI Driver/RuntimeCoordinator。
- SessionManager 调用 `openSession/runTurn/cancel`，不直接选择 Executor。
- `hasActivePipeline()` 新增兼容代理并迁移为 `hasActiveTurn()`。
- `session:turn-completed`、`session:turn-failed` 和 `session:exit` 逐步收敛为 Runtime terminal event。
- finalization、snapshot writer 和 generation 逻辑暂不下沉。
- `ExecutionProcess` 按实际 child 建账：启动时创建，真实退出时更新；turn completion 不结束记录。
  ACP child 跨 turn、Runtime 重建产生新记录、旧 runtime exit 迟到都要有契约测试。

### 验收

- 所有现有 SessionManager lifecycle tests 通过。
- CLI start、follow-up、stop 和 Provider switch 行为无变化。
- TeamRun 调度、heartbeat、orphan recovery 无变化。
- Conversation 和 workspace Session 都通过。
- Server shutdown 不遗留 CLI 子进程。
- `ExecutionProcess` 的 pid/exitCode 与真实 CLI child 生命周期一致。

### 发布门槛

本 Phase 可以单独合并。ACP Driver 未启用时，用户可见行为应为零变化。

## 8. Phase 3：ACP Driver 内核

**目标：** 使用 fake ACP Agent 跑通协议生命周期，不接前端权限 UI。

### 进程与连接

从 Demo 移植并适配：

- ACP process group spawn/TERM/KILL。
- NDJSON 流验证和 frame size bound。
- stderr bounded diagnostics。
- initialize timeout、protocol mismatch 和 stream close 分类。
- `connection.closed`、child exit 和 prompt promise 的竞态收敛。
- ACP child 可以跨 turn；prompt completion 不关闭或结束 `ExecutionProcess`，dispose/进程退出才结束。
- Runtime error 分类与脱敏。

适配点：

- 使用 server 的 `writeErrorLog`。
- 使用 `ExecutionEnv` 的安全环境合并规则。
- workingDir 接受 Workspace 或 Conversation 的真实目录，不要求等于 Project root。
- 不使用 Electron IPC、Demo local store 或 public session ID encoding。
- 每个 Tower Session 创建独立 ACP DriverSession。

### Session 生命周期

实现：

- connect + initialize。
- `session/new`。
- `session/load` capability gate。
- `session/prompt`。
- `session/cancel`。
- dispose/restart。
- session update replay buffering，防止 new/load 返回前 update 丢失。
- turn idle timeout，以新 activity 重新计时。

### ACP Projector

映射：

| ACP update | Normalized output |
| --- | --- |
| agent message chunk | assistant_message，按 message identity 增量 replace |
| user message chunk | user_message，避免与本地 optimistic entry 重复 |
| thought chunk | thinking |
| tool call/update | tool_use，按 toolCallId replace |
| plan/update/remove | 单个 plan/todo entry replace/remove |
| usage update | token_usage_info |
| unknown update | bounded diagnostic 或 system entry |

必须复用 Demo 的 streaming redaction、message identity、unknown update bound 和 tool location 校验。

### 验收

- Fake Agent 覆盖 initialize/new/load/prompt/cancel。
- chunk 边界与未知 update 不会中断后续事件。
- external session ID 写入 Session 字段和 MsgStore。
- ACP frame 不出现在 session stdout、snapshot 或浏览器。
- completion、failure、process exit、cancel 竞争只产生一个终态。

## 9. Phase 4：ACP 纵向 Session 集成

**目标：** Codex ACP Provider 可以在真实 Workspace/Conversation 中完成无权限交互的一轮和追问。

### Provider

- Provider create/update/backup/import 支持 `runtimeType = ACP`。
- Availability 根据 Runtime Driver 检测，而不是继续调用 CLI Executor availability。
- 首版新增显式 ACP Provider，不修改现有 built-in CLI Provider 默认值。
- 同一 Session 禁止跨 runtimeType 切换 Provider。
- Provider secret 仍只在 server 侧读取，不回显完整值。

### Start/follow-up/stop

- `start()` 创建 RuntimeSession 和新 ACP session。
- `sendMessage()` 优先复用内存 ACP session。
- Runtime 已回收时重新 initialize，并仅在 advertised 时调用 load。
- 无 load 能力时返回明确的恢复错误，不静默声称恢复。
- `stop()` 先 cancel，超时后 close/kill，并走现有 CANCELLED finalization。

### MCP

复用 `buildMcpConfigResponse()` 生成 command/args/base env，再追加当前 invocation identity：

```text
AGENT_TOWER_SESSION_ID
AGENT_TOWER_INVOCATION_ID
AGENT_TOWER_TEAM_RUN_ID
AGENT_TOWER_MEMBER_ID
```

把这些值放进 ACP `mcpServers[].env`，不放进用户可配置的通用 Provider env，不允许 Agent 或请求 body
覆盖。

### 验收

- Codex ACP 完成 Workspace 和 Conversation 首轮。
- follow-up 在内存复用和 load 恢复两条路径都通过。
- MAIN_DIRECTORY、WORKTREE 和非 Git Conversation 目录都通过。
- MCP 可以读取正确 workspace/TeamRun context。
- auto-commit、Task IN_REVIEW 和 token usage 行为正确。

## 10. Phase 5：权限、Runtime State 与实时同步

**目标：** 完成 ACP 双向权限闭环，并支持浏览器重连。

### Server

新增 `PermissionRegistry`，key 至少包含 sessionId、turnId 和 requestId。提供：

```text
GET  /api/sessions/:id/runtime-state
POST /api/sessions/:id/permissions/:requestId/respond
```

REST route 只解析输入和映射错误；SessionManager/RuntimeCoordinator 校验：

- Session 和 active turn 匹配。
- requestId 尚未失效。
- optionId 是 Agent 原样提供的选项。
- 重复提交只允许一次成功。

新增 shared Socket 事件：

```text
session:permission_requested
session:permission_invalidated
session:runtime_state_changed
```

Socket 事件是实时信号；页面首次加载和 reconnect 都请求 REST runtime state。
permission requested/resolved/invalidated 同时发出 `team-run:invalidated`（仅关联 TeamRun 时），让成员
聚合状态重新读取 Runtime authoritative state。

### Permission policy

- `ASK`：等待用户选择 exact option ID。
- `AUTO_APPROVE`：服务端根据明确策略选择 allow option。
- 建议 request fallback 优先 `allow_once`；Agent 提供原生 bypass/yolo mode 时按 Provider 显式配置。
- 没有可识别 allow option 时不猜测，进入 ASK 或失败策略。

### Web

- Tool card 附近展示 permission request。
- 提供 Agent 原样选项名称和 allow/reject 语义。
- 提交期间防重复点击，失败恢复可重试状态。
- turn cancel、ACP connection close 或 terminal 后使操作失效；Browser/Socket 断线本身不使请求失效。
- 移动端与桌面端都能完成权限选择，内容不溢出。

### 验收

- 权限请求不会阻塞其他 Session。
- 页面刷新和 Socket 重连后可恢复 pending permission UI。
- 重复、过期、跨 Session 和伪造 option ID 被拒绝。
- stop、ACP connection close 和 server close 会取消 pending resolver；Browser reconnect 后仍可继续处理。
- AUTO_APPROVE 在浏览器不在线时仍可完成。

## 11. Phase 6：TeamRun 集成

**目标：** ACP Session 成为 TeamRun 的一等执行方式。

### 改造

- `TeamReconcilerSessionMessenger.hasActivePipeline` 迁移到 `hasActiveTurn`。
- `hasActiveTurn` 在 `RUNNING`、`AWAITING_PERMISSION`、`CANCELLING` 返回 true；idle ACP connection
  不算 active invocation。
- RuntimeCoordinator 提供按 sessionId 批量读取的只读 runtime state view，TeamRunService 在
  `deriveTeamMemberStatuses` 中优先把等待权限的 RUNNING invocation 映射为 Member
  `PENDING_APPROVAL`，避免逐成员查询。
- permission request 期间 `AgentInvocation` 保持 `RUNNING`，Runtime turn state 为
  `AWAITING_PERMISSION`，仅 TeamMember 聚合状态派生为 `PENDING_APPROVAL`。
- permission resolved 后 TeamMember 聚合状态恢复 `RUNNING`；不复用 WorkRequest 的
  `PENDING_APPROVAL`。若未来要扩展 `AgentInvocationStatus`，另做状态迁移和恢复设计。
- watchdog 对 `AWAITING_PERMISSION` 暂停静默补催；权限处理后重置补催计时，但不把它计为 Agent
  progress。
- content/tool/plan/usage/progress 刷新 heartbeat。
- 本地 user message patch 仍不计 Agent progress。
- watchdog nudge 通过同一 RuntimeSession follow-up 入口发送。
- server 重启后 RUNNING invocation 仍按 orphan 规则回收，不声称重接旧进程。

### 并发测试

- 同一 TeamRun 两个成员同时运行两个 ACP RuntimeSession。
- 一个成员等待权限时另一个继续输出。
- 等待权限的成员不会收到 heartbeat nudge，也不会因 Agent 静默预算被提前回收。
- cancel 一个成员不影响另一个 connection、permission 或 MsgStore。
- shared/dedicated workspace 的 MCP identity 和资源锁不串线。
- Team 静默、失败、permission pending 和 ready-for-review 推进正确。
- permission pending 期间 Invocation 仍为 `RUNNING`，Member 显示 `PENDING_APPROVAL`。

## 12. Phase 7：空闲回收、诊断与恢复

**目标：** 控制长期运行资源并提供可定位故障信息。

### RuntimeCoordinator

- 仅回收 `IDLE` RuntimeSession。
- 配置 idle TTL 和最大空闲 Runtime 数量。
- follow-up 到来时取消正在进行的 eviction。
- dispose 幂等，确认 child exit 后才从 map 移除。
- server `onClose` await `disposeAll()`，再关闭 Socket/进程相关依赖。

### Runtime state/diagnostics

可暴露脱敏后的：

- runtimeType、turnState、capabilities。
- protocol version、Agent name/version。
- last activity、connection state、retryable error code。
- 是否可以 load/resume。

不得暴露：

- 完整环境变量。
- Provider token/secret。
- internal token 或 TeamRun identity。
- 原始 ACP frames。
- 未限长的 tool input/output 或 stderr。

### 验收

- TTL 不回收 running/permission/cancelling Runtime。
- 并发 follow-up 与 eviction 不会创建两个 active RuntimeSession。
- server close 在 deadline 内确认所有 adapter child 退出。
- timeout/process exit 后已收到的日志仍可读取。

## 13. Phase 8：多 Agent ACP 与 Provider UI

**目标：** 在 Codex 纵向闭环稳定后扩展当前已有 AgentType。

建议顺序：

1. Codex adapter。
2. Claude Code adapter。
3. Gemini CLI native ACP。
4. Cursor Agent native ACP。

每个 Agent definition 负责：

- adapter/native executable discovery。
- 受控启动参数。
- Provider env/settings 映射。
- session metadata。
- mode/model/config option 设置。
- 特定 initialize timeout。

不因为 ACP Demo 支持更多 Agent 就在本阶段扩大 Agent Tower 的 `AgentType` enum。新增 Agent catalog 是独立产品变更。

Provider 设置页按 runtimeType 展示字段：

- CLI：沿用现有 config/settings。
- ACP：adapter/agent executable、permission mode、initial mode、model 和 Agent 特定设置。
- 不允许通过 Provider 覆盖 command、fixed args、PATH/HOME/NODE_OPTIONS 等受保护启动字段。

## 14. Phase 9：打包、发布与公开文档

### npm publish

- 更新 `packages/server/package.json` 依赖。
- 更新 `scripts/build-publish.mjs` 的 files/bundledDependencies 或依赖安装策略。
- 从最终 tarball 中执行 adapter resolution 和 fake/real smoke。
- 验证 global install 不依赖仓库 node_modules 或 pnpm symlink。

### Desktop

- `prepare-runtime.mjs` 验证 ACP SDK 和所需 adapter 文件真实存在。
- packaged runtime 不从 `app.asar` 内执行可变脚本。
- 验证 macOS/Windows/Linux 的 Node executable、路径和进程组清理。
- 更新 packaged smoke，确认窗口关闭后 adapter child 不存在。

### Docker

- 明确 adapter 与 CLI 安装版本。
- 验证 non-root user、`/data`、`/workspace`、HOME 和凭据目录。
- ACP 不得依赖宿主 Electron 环境。
- Docker health 和 shutdown 能回收 adapter child。

### 文档

实现落地后更新：

- `.agents/skills/agent-tower-dev/references/pipeline-patterns.md`
- `docs/ARCHITECTURE.md`
- `packages/docs-site/docs/` 中的 Provider/Agent/ACP 集成说明
- Desktop 和 Docker 的兼容范围

ADR 和本实施计划是内部文档，不代替用户文档。

## 15. 测试矩阵

### Runtime Core

- 同一 Session 并发 runTurn 被拒绝。
- 不同 Session 可并发运行。
- stale turnId event 被丢弃。
- completed/failed exactly-once。
- cancel/complete/dispose race。
- idle eviction/follow-up race。
- disposeAll 幂等和 deadline。
- child process 跨 turn，turn completion 不结束进程记录。
- runtime 重建产生新进程记录，旧 runtime 的迟到 exit 只更新旧记录。

### CLI 回归

- early data/exit。
- Parser process/finish throw。
- logical complete/fail 与 PTY exit。
- spawn failure、stop、follow-up fallback。
- snapshot restore、seq gap 和 memory cap。
- Windows process wrapper 与 stdin file cleanup。

### ACP contract

- malformed/oversized frame。
- handshake timeout/protocol mismatch。
- new/load replay update ordering。
- message identity 与 streaming redaction。
- tool/plan/usage/unknown update。
- permission exact option ID 和 abort。
- cancel timeout、process exit、connection close。
- load unsupported/load failed。

### 跨层

- Provider CRUD/backup/import compatibility。
- REST auth、CSRF、Socket auth 和 reconnect。
- permission runtime-state recovery。
- Workspace/Conversation/TeamRun。
- Task auto-revert/auto-review、auto-commit。
- server restart orphan recovery。

### 分发

- source build。
- npm pack/global install smoke。
- Desktop packaged smoke/acceptance。
- Docker build/run/shutdown smoke。
- 真实 adapter authenticated smoke，仅输出脱敏结果分类。

## 16. 每阶段验证命令

按改动范围从窄到宽执行：

```bash
pnpm exec vitest run <runtime-test-files>
pnpm exec vitest run packages/server/src/pipeline/__tests__/agent-pipeline.test.ts
pnpm exec vitest run packages/server/src/services/__tests__/session-manager.lifecycle.test.ts
pnpm exec vitest run packages/server/src/services/__tests__/session-manager.team-run.test.ts
pnpm --filter @agent-tower/shared build
pnpm --filter @agent-tower/server build
pnpm --filter web build
pnpm build
pnpm build:publish
pnpm desktop:package:smoke
```

涉及 UI permission flow 时增加浏览器 E2E；Desktop 重点验证功能、布局、console error、进程清理和
reconnect。

## 17. 建议合并顺序

为降低单次改动风险，建议拆成独立 PR/提交：

1. ADR、探针和 compatibility report。
2. Shared/Prisma/Provider 向后兼容契约。
3. Runtime Core + CLI Driver 等价迁移。
4. ACP process/SDK/projector + fake agent tests。
5. Codex ACP Provider 纵向 Session 集成。
6. Permission REST/Socket/Web 闭环。
7. TeamRun active turn/pending approval 集成。
8. Idle eviction、diagnostics 和 shutdown。
9. 多 Agent ACP definitions。
10. npm/Desktop/Docker 打包与公开文档。

禁止把 Phase 2 CLI 等价迁移和 Phase 3 ACP 新行为压进一个不可回滚的大提交。

## 18. 完成定义

ACP Runtime 支持完成需要同时满足：

- 旧 CLI Provider、旧 Session、Solo、Conversation 和 TeamRun 无行为回归。
- ACP Provider 可完成新建、流式输出、工具、计划、usage、权限、取消和 follow-up。
- Runtime 重建只在 capability 允许时声称恢复。
- 每个 TeamRun member 的 runtime、permission、MCP identity 和日志严格隔离。
- Browser reconnect 可恢复 snapshot 和 pending runtime state。
- Server/Desktop/Docker shutdown 不遗留 adapter child。
- npm、Desktop 和 Docker 的已承诺平台完成 smoke。
- 公开文档、内部 architecture 和 agent-tower-dev skill 与真实实现一致。
