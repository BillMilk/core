# Core 增强版差异与待完善清单

> 文档状态：当前实现快照与后续改造依据
> 记录日期：2026-08-18
> 原始版本边界：`95538f99b0981fb7adac424583db79c1f5eab3be`（包含该提交及其以前的历史）
> 增强版范围：基线之后的两次提交，加当前本地未提交工作区
> 当前分支：`main`

## 1. 结论

当前 Core 可以定义为：

> 原始 Agent Tower + Stoneforge 风格的后端任务编排基础层 + Windows 桌面端与本地 CLI 深度适配 + Agent 运行可观测性增强。

从能力结构看，当前版本已经吸收了类似 Stoneforge 的任务依赖、编排状态机、Worker 认领、租约心跳、异常恢复和事件审计设计。不过，仓库中没有 Stoneforge 的代码引用或来源标记，因此只能确认“能力和架构风格相近”，不能将其表述为完整 Stoneforge 移植。

任务编排已经具备后端控制面和 Web 最小操作界面：任务详情可以维护依赖、查看 Readiness/blocker、Worker 租约信息和 TaskEvent 时间线，看板会区分编排状态，Web 也会实时消费编排事件。自动任务拆解、TeamRun 自动派发和实际合并执行器仍未形成完整闭环。

## 2. 差异范围

### 2.1 原始版本

以下提交及其以前的内容统一视为原始版本：

```text
95538f99b0981fb7adac424583db79c1f5eab3be
feat: 调整文档网站首页并加入两个演示动图
```

### 2.2 已提交增强

原始版本之后正好有两次提交：

| 提交 | 日期 | 内容 |
|---|---|---|
| `11fa84509657e270d6ffd11ab64ac82fa243a7b0` | 2026-08-17 | 增加任务编排基础层 |
| `ce5859e7f8f29438a4382bbcbc8f8d16afb65663` | 2026-08-17 | 修复 Electron 打包时 Prisma runtime 不一致 |

这两次提交合计涉及 18 个文件，约 `+1896/-3`。

### 2.3 本地未提交增强

记录本文档之前，工作区包含：

- 22 个已跟踪文件修改。
- 7 个新增未跟踪文件。
- 已跟踪文件差异约 `+440/-35`。
- 没有 staged 修改。

这些修改尚未被 Git 提交，不应当被视为已经形成可回退、可追踪的正式版本。

## 3. 已提交增强：任务编排基础层

对应提交：`11fa84509657e270d6ffd11ab64ac82fa243a7b0`

### 3.1 独立编排状态机

原版主要使用看板状态：

```text
TODO → IN_PROGRESS → IN_REVIEW → DONE
```

增强版在保留看板状态的同时，增加独立编排状态：

```text
BACKLOG
READY
ASSIGNED
RUNNING
REVIEW
MERGING
DONE
BLOCKED
HANDOFF
RECOVERING
MERGE_FAILED
CANCELLED
```

已完成能力：

- 为全部编排状态定义合法迁移关系。
- 非法状态迁移返回明确错误。
- 关键编排状态同步回原有看板状态。
- 保持旧 Task API 和看板逻辑兼容。
- 记录认领人、认领时间、心跳时间、尝试次数和最后错误。

主要实现：

- `packages/server/src/services/task-orchestration.service.ts`
- `packages/server/prisma/schema.prisma`
- `packages/shared/src/types.ts`

### 3.2 任务依赖 DAG

新增 `TaskDependency` 数据模型和服务接口。

已完成能力：

- 添加、删除和查询任务依赖。
- 同时查询前置任务和后继任务。
- 禁止任务依赖自身。
- 禁止跨项目依赖。
- 建立依赖前检测循环引用。
- 删除任务时级联清理依赖。
- 前置任务未完成时阻止当前任务进入 Ready/Claim 流程。

### 3.3 Ready Queue

新增依赖感知的可执行任务队列。

进入 Ready Queue 的任务必须满足：

- 编排状态为 `READY` 或 `RECOVERING`。
- 所有前置依赖已经完成。
- 任务未被其他 Worker 占用。

队列排序规则：

```text
priority 降序
→ position 升序
→ createdAt 升序
```

### 3.4 Worker 原子认领

已完成能力：

- Worker 认领指定任务。
- Worker 自动认领下一个 Ready Task。
- 使用条件更新减少并发重复认领。
- 校验 Worker 所有权。
- 每次认领增加 attempt count。
- 认领后写入持久化事件。

### 3.5 心跳、租约和崩溃恢复

已完成能力：

- `ASSIGNED` 和 `RUNNING` 任务支持 Worker heartbeat。
- 默认每 30 秒扫描一次超时任务。
- 默认 10 分钟无心跳视为租约失效。
- 超时任务进入 `RECOVERING`。
- 清除旧 Worker 认领信息，使任务可重新认领。
- 保存恢复原因并写入审计事件。
- 服务端启动和关闭时同步启停恢复 Scheduler。

### 3.6 持久化任务事件

新增 append-only 的 `TaskEvent` 数据模型。

当前事件覆盖：

- 任务创建、更新、删除。
- 看板或编排状态变化。
- 添加和删除依赖。
- Worker 认领、开始、释放和恢复。
- 任务完成和失败。

事件可记录：

- 前后状态。
- actor 类型和 actor ID。
- JSON payload。
- 幂等键。
- 创建时间。

### 3.7 REST 和 Socket 接口

新增 REST 能力：

- 查询项目 Ready Tasks。
- Claim Next。
- 查询、添加、删除依赖。
- 查询 Readiness 和 blockers。
- 查询 Task Events。
- Mark Ready。
- Claim 指定任务。
- Heartbeat。
- 编排状态迁移。

新增 Socket 事件：

```text
task:orchestration_updated
```

后端已经能够广播编排状态变化，但当前 Web 前端尚未订阅并呈现该事件。

### 3.8 Session 与 Task 生命周期联动

当前联动关系：

- Agent Session 启动时，Task 进入 `RUNNING`。
- Task 的全部 Session 结束时，Task 进入 `REVIEW`。
- Task 重试时，编排状态返回 `BACKLOG`。
- 重试会清除认领、心跳和最后错误。
- 生命周期变化写入 TaskEvent。

### 3.9 数据迁移和旧数据兼容

数据库迁移按原看板状态回填编排状态：

| 原看板状态 | 新编排状态 |
|---|---|
| `TODO` | `BACKLOG` |
| `IN_PROGRESS` | `RUNNING` |
| `IN_REVIEW` | `REVIEW` |
| `DONE` | `DONE` |
| `CANCELLED` | `CANCELLED` |

迁移同时创建依赖表、事件表及查询索引。

### 3.10 已有测试

提交内已经包含：

- Task Orchestration Service 测试。
- Task Orchestration Route 测试。
- 依赖阻塞与完成后解锁测试。
- Ready Queue 和 Claim Next 测试。
- 状态迁移测试。
- Worker 租约过期恢复测试。
- 应用启动时 Scheduler 生命周期测试。

## 4. 已提交增强：Electron Prisma 打包一致性

对应提交：`ce5859e7f8f29438a4382bbcbc8f8d16afb65663`

原版风险：

- `pnpm deploy --legacy` 可能解析出和工作区不同的 Prisma patch 版本。
- 工作区生成的 Prisma Client 可能与打包 runtime 中的 Prisma runtime/engine 不一致。
- 开发环境可以运行，但 `win-unpacked` 中的后端可能启动失败。

当前修复：

- 从工作区解析实际使用的 Prisma 包。
- 替换 runtime 中的 `prisma` 和 `@prisma/client`。
- 同步 Prisma engines、engine version、fetch engine、platform 和 debug 包。
- 保持生成客户端和 runtime 二进制版本一致。

同步的主要包：

```text
prisma
@prisma/client
@prisma/engines
@prisma/engines-version
@prisma/fetch-engine
@prisma/get-platform
@prisma/debug
```

## 5. 本地未提交增强：Windows Git 和 CLI 检测

### 5.1 Electron 启动时刷新 PATH

新增 `packages/desktop/src/windows-path.ts`。

当前实现会读取：

- 当前进程 PATH。
- `HKLM` 系统 PATH。
- `HKCU` 用户 PATH。

随后：

- 展开 Windows 环境变量。
- 合并并去除重复目录。
- 统一 `PATH`、`Path`、`path` 的键名。
- 将最新 PATH 传递给打包后的后端。

该实现没有写死 Git 安装目录。只要 Git 位于 Windows 当前注册表 PATH 中，即使 Explorer 仍保留旧环境，桌面应用也可以在启动后发现 Git。

### 5.2 `git init failed` 修复

原版问题：Electron 从 Explorer 双击启动时可能继承安装 Git 之前的旧 PATH，导致创建空项目时找不到 `git`。

当前修复通过刷新注册表 PATH 解决该问题，并为 packaged smoke 增加真实验证：

- 将初始 PATH 限制为 Windows 系统目录。
- 启动 `win-unpacked` 中的 EXE。
- 通过应用 API 创建空项目。
- 验证 `.git` 目录实际生成。

### 5.3 Codex `.cmd` 启动修复

针对 npm 全局安装的 `codex.cmd`：

- `.cmd` 和 `.bat` 通过 `cmd.exe` 执行。
- 启用 `windowsVerbatimArguments`。
- 修复带空格路径的引号被重复转义。
- 避免 `cmd.exe` 把带引号的完整路径误识别为命令名。

### 5.4 Windows 命令直接解析

当 `where.exe` 失败或返回空结果时，新增直接扫描 PATH 的回退逻辑。

支持查找：

```text
.cmd
.bat
.exe
.com
```

支持带引号及包含空格的 PATH 条目，并忽略无权限访问的 PATH 目录。

### 5.5 Grok 和 OpenCode

Windows 用户目录回退路径新增：

```text
%USERPROFILE%\.grok\bin
%USERPROFILE%\.opencode\bin
```

ACP native agent 不再强制将无扩展名命令改为 `.cmd`，从而允许正确发现 `grok.exe` 等原生 Windows 可执行文件。HOME 缺失时使用 USERPROFILE。

### 5.6 Agent CLI 与 Provider 检测统一

Agent CLI 环境页和 Provider 可用性检测开始复用相同的 Windows 命令解析机制，用于解决以下不一致：

```text
Agent CLI 环境：可用
Agent 配置/Provider：不可用
```

### 5.7 ACP 与 CLI 展示语义

Provider 页面当前显示：

```text
Codex (CLI)
OpenCode (CLI · ACP)
Grok Build (CLI · ACP)
```

`CLI · ACP` 的含义是本地运行 CLI、通过 ACP 适配层通信，而不是“没有 CLI”。默认 Provider 名称也改为 `Local CLI via ACP`，降低用户误解。

## 6. 本地未提交增强：Agent 运行可观测性

新增 `RuntimeObservabilityBar`，已经接入：

- Agent Session Panel。
- Task Detail 标准视图。
- Task Detail 紧凑视图。

当前展示：

- Agent 类型。
- CLI/ACP Runtime 类型。
- 当前运行阶段。
- 当前工具名称。
- 会话持续时间。
- Tool Call 数量。
- 消息数量。
- Token 使用量。
- Context Window 使用率和预警颜色。

运行阶段包括：

```text
starting
thinking
tool
output
waiting
permission
cancelling
completed
failed
cancelled
idle
```

Context 数据只显示 CLI 实际上报的数据。Core 当前不自行估算、截断或压缩模型上下文。

## 7. 本地未提交增强：创建任务弹窗

修复项目或 Provider 列表为空时仍显示空白 Popover/白边的问题。

当前行为：

- 无项目时禁用项目选择按钮。
- 无 Provider 时禁用 Agent 选择按钮。
- 无选项时不显示下拉箭头。
- 无选项时不渲染空菜单。
- 数据变为空时自动关闭已经打开的菜单。
- 增加 `aria-expanded` 和 `role="menu"`。

对应测试确认无项目、无 Provider 时不会渲染空白菜单。

## 8. 本地未提交增强：Windows `win-unpacked`

新增专用命令：

```powershell
corepack pnpm desktop:package:win:dir
```

目标产物：

```text
packages/desktop/release/win-unpacked/
```

当前改进：

- 只构建 Windows x64 目录版。
- 不生成 NSIS 安装包。
- 不生成 portable 单文件 EXE。
- 重新构建 shared、server、web 和 desktop。
- 重新生成完整 desktop runtime。
- 使用临时 Corepack shim，减少对全局 `pnpm.cmd` 的依赖。
- 禁止 electron-builder 重复执行 npm rebuild。
- server build 和 runtime prepare 优先使用 Corepack/pnpm 当前版本。
- 增加面向后续会话的制作说明。
- 明确交付整个 `win-unpacked`，不能只复制其中的 EXE。

详细流程见 `docs/WINDOWS_WIN_UNPACKED_BUILD.md`。

## 9. 本地未提交增强：打包后验证

packaged smoke 当前可以验证：

- 后端健康接口。
- Socket.IO `/events`。
- 独立终端创建和删除。
- Web UI 加载。
- MCP 配置。
- 限制初始 PATH 后的 `git init`。
- Codex CLI 检测。
- Grok、OpenCode、Codex Provider 可用性。
- 打包 runtime 是否真正包含当前源码修复。

## 10. 尚未形成闭环的能力

### 10.1 编排 UI 已实现最小闭环

状态：本轮已实现桌面端和移动端 Task Detail 编排面板，并在看板任务卡片显示独立编排状态。

已实现：

- 前置任务和后继任务列表。
- 添加、删除依赖的交互，以及后端循环依赖错误提示。
- Readiness、blocker 和可领取状态展示。
- 编排状态与普通看板状态的区分展示。
- Worker、attempt、claim、heartbeat 和 last error 展示。
- 后端状态机允许的人工状态流转、人工认领和心跳操作。
- TaskEvent 时间线。
- 归档项目只读保护，以及桌面端和移动端适配。

仍待完善：项目级 DAG 图、关键路径和瓶颈可视化，以及更适合大量任务的依赖搜索和分页。

### 10.2 前端已消费编排 Socket 事件

状态：Web 全局实时同步已订阅 `task:orchestration_updated`，并失效任务详情、编排查询、项目任务列表和看板缓存。

服务端在依赖添加/删除和 Worker heartbeat 后也会广播该事件，外部 Worker 的操作可触发 UI 刷新。

### 10.3 TeamRun 未接入 Ready Queue

状态：`claim-next` API 已有，但 TeamRun 调度器没有自动调用。

缺少：

- 按成员能力筛选任务。
- 自动从 Ready Queue 认领任务。
- Worker 并发上限控制。
- Agent 忙碌时的 backpressure。
- Agent 完成后的自动领取下一任务。
- Controller/Worker 的正式派发协议。

影响：任务依赖和 Worker 租约目前更接近可供外部调用的控制面，而不是开箱即用的 Multi-Agent 自动调度。

### 10.4 缺少自动任务拆解

状态：未实现。

当前 Core 不会自动将一个用户目标拆成：

- 原子任务。
- 依赖 DAG。
- 角色和能力要求。
- 输入输出契约。
- 验收条件。
- 合并或审查节点。

需要额外的 Planner/Controller 或确定性脚本生成这些任务。

### 10.5 `MERGING` 只是状态

状态：状态机已定义，实际动作未实现。

缺少：

- 从 `REVIEW` 自动进入合并。
- 选择需要合并的 Workspace。
- 执行 Git merge/rebase。
- 冲突检测和冲突修复派发。
- 合并成功后进入 `DONE`。
- 合并失败后自动进入 `MERGE_FAILED` 并生成修复任务。

影响：当前不能把 `MERGING` 理解为已经具备自动合并引擎。

### 10.6 Review/Handoff 缺少产品化流程

状态：后端状态存在，UI 和角色动作未闭环。

缺少：

- Reviewer 选择。
- Review 结论和原因表单。
- 驳回后返回原 Worker。
- Handoff 目标成员和交接摘要。
- Review/Handoff 历史展示。

### 10.7 调度公平性和重试策略有限

当前 Ready Queue 只按 priority、position、createdAt 排序。

后续需要考虑：

- 不同项目之间的公平性。
- 成员能力与任务标签匹配。
- 最大 attempt 限制。
- 指数退避或延迟重试。
- 永久失败和人工接管。
- 同一 Worker 连续失败后的隔离。
- 任务级超时配置。

### 10.8 Event Log 尚未完全事件化

虽然已经有 TaskEvent，但当前系统仍以 Task 表当前状态作为主要事实源。事件写入失败时，部分原有 TaskService 操作会继续成功。

因此它目前是审计日志，不是严格的 Event Sourcing。后续需要明确：

- TaskEvent 是否必须与状态变更同事务成功。
- 哪些事件允许幂等重放。
- 是否支持从事件恢复状态。
- 事件保留和归档策略。

### 10.9 本地 CLI 检测仍有边界

当前实现依赖：

- 注册表 PATH。
- 当前进程 PATH。
- 已知用户目录回退路径。

仍需覆盖：

- 用户手工配置但未写入 PATH 的 CLI。
- PowerShell alias/function。
- Windows App Execution Alias。
- Scoop、Chocolatey、Volta、fnm、nvm-windows 的更多变体。
- CLI 安装后运行期间的自动刷新提示。
- 同一 CLI 多版本冲突和优先级展示。

### 10.10 Provider 可用性需要统一产品语义

虽然 CLI/ACP 标签已经修复，但还需要明确区分：

- CLI 文件已找到。
- CLI 可以成功执行。
- CLI 已登录。
- ACP adapter 可以启动。
- Provider 可以真正创建会话。

建议 UI 使用分层状态，而不是单一“可用/不可用”。

### 10.11 Runtime Observability 仍是推导状态

当前 thinking、tool、output 等阶段主要从 runtime state 和日志推导。

仍需完善：

- 不同 CLI 输出格式的一致性。
- Tool Call 唯一 ID 和生命周期。
- 并行工具调用展示。
- 子 Agent/子任务状态聚合。
- Context Window 缺失时的明确原因。
- Provider/Model 维度的 token 成本统计。
- 历史运行指标和趋势。

### 10.12 未提交代码尚未版本化

Windows PATH、CLI 检测、Provider 标签、运行状态条、弹窗修复和目录版打包流程已提交到 `326a27e`。当前未版本化的是本轮任务编排 UI、查询 hooks、Socket 缓存同步、服务端补充广播、测试和本文档更新。

风险：

- Git 清理可能导致修改丢失。
- 新环境无法通过 commit 精确复现。
- 当前 EXE 和 Git HEAD 不完全对应。
- 后续排查难以定位某项修复属于哪个版本。

## 11. 建议完善顺序

### P0：先固化现有增强

1. 对当前未提交代码运行完整测试和 packaged smoke。
2. 修复测试或文档中发现的问题。
3. 将本地增强拆分为可审查的提交。
4. 为增强版增加明确版本号或 build metadata。
5. 保存 EXE SHA-256、Git commit 和构建时间的对应关系。

### P1：完成任务编排最小闭环

1. [x] Web 端订阅 `task:orchestration_updated`。
2. [x] 在 Task Detail 展示编排状态、blockers、Worker、attempt 和 last error。
3. [x] 增加依赖列表以及添加/删除依赖 UI。
4. [x] 在任务看板标识 READY、BLOCKED、RUNNING、REVIEW 等编排状态。
5. TeamRun 接入 Ready Queue 和 Claim Next。
6. [部分完成] 已有 Worker heartbeat API 和人工操作 UI；任务完成后的自动推进尚未接入 TeamRun。
7. 实现并发上限和 Agent 忙碌 backpressure。

### P1：完成 Review、Handoff 和 Merge

1. 增加 Reviewer 操作入口和审查结论。
2. 增加 Handoff 目标和交接摘要。
3. 将现有 Workspace merge 能力连接到 `MERGING`。
4. 合并成功进入 `DONE`。
5. 合并失败进入 `MERGE_FAILED` 并产生修复任务。
6. 在 TaskEvent 时间线中展示整个过程。

### P2：实现任务拆解与能力路由

1. 定义 Task Contract：目标、输入、输出、写入范围、依赖和验收命令。
2. 增加 Planner/Controller，把目标拆成 DAG。
3. 按 Agent 能力、Provider、Workspace Policy 和任务标签派发。
4. 支持人工确认和自动模式。
5. 增加最大重试、失败隔离和人工接管。

### P2：增强可观测性

1. 增加项目级 Multi-Agent 运行总览。
2. 展示 Ready、Running、Blocked、Review 和 Recovering 数量。
3. 展示依赖关键路径和当前瓶颈。
4. 展示每个 Agent 的任务、工具、token、持续时间和错误。
5. 增加历史运行和失败原因统计。

## 12. 建议的最小验收标准

任务编排可以被称为“前后端闭环”前，至少满足：

- [x] 用户可以在 UI 创建和删除任务依赖。
- [x] UI 能显示 blockers 和 Ready 状态。
- [x] 前端实时消费编排 Socket 事件。
- TeamRun Worker 能自动领取依赖已完成的任务。
- 两个 Worker 不会同时认领同一任务。
- Worker 崩溃后任务能自动恢复并重新分配。
- Review 可以批准或退回。
- Merge 状态会实际执行 Workspace 合并。
- 合并失败会产生可见错误和修复流程。
- [x] TaskEvent 时间线能展示状态流转、操作者和事件 payload。
- 从创建依赖 DAG 到全部任务完成可以不调用隐藏 REST API 手工推进。

Windows 桌面增强可以被称为“正式版本”前，至少满足：

- Codex、Grok、OpenCode 在干净 Windows 用户环境中均完成检测验证。
- GUI 使用旧 PATH 启动时仍能执行 `git init`。
- CLI 安装路径包含空格时仍能执行。
- Agent 环境页与 Provider 页面结果一致。
- `desktop:package:win:dir` 可以从干净工作区重复构建。
- packaged smoke 全部通过。
- 产物记录对应 Git commit、构建时间和 SHA-256。

## 13. 新会话接手说明

后续会话分析或完善当前增强版时，应先运行：

```powershell
git status --short
git log --oneline --decorate -n 5
git diff --stat 95538f99b0981fb7adac424583db79c1f5eab3be..HEAD
git diff --stat
```

然后读取：

1. 本文档。
2. `packages/server/src/services/task-orchestration.service.ts`。
3. `packages/server/src/services/task-orchestration-scheduler.ts`。
4. `packages/server/src/routes/tasks.ts`。
5. `packages/server/prisma/schema.prisma`。
6. `packages/desktop/src/windows-path.ts`。
7. `packages/server/src/services/agent-cli/command-runner.ts`。
8. `packages/server/src/utils/process-launch.ts`。
9. `packages/web/src/components/agent/RuntimeObservabilityBar.tsx`。
10. `docs/WINDOWS_WIN_UNPACKED_BUILD.md`。

不要仅根据本文档假定某项本地修改仍然存在；必须以当时的 Git 状态和实际文件为准。

可使用以下接手指令：

```text
请以 95538f99b0981fb7adac424583db79c1f5eab3be 为原始版本基线，先读取 docs/CORE_ENHANCEMENTS_SINCE_95538F9.md，再核对当前 Git 提交和未提交差异。继续完善时优先完成编排 UI、Socket 实时订阅、TeamRun Ready Queue 自动派发，以及 Review/Handoff/Merge 的端到端闭环；不要把已有后端状态机误认为功能已经完整产品化。
```
