# Codex Provider Config Not Applied Implementation Plan

## Goal

修复 Codex Provider 修改 API URL / API Key 后测试结果和新会话不受影响的问题。未保存草稿测试、保存后测试和每次新 executor spawn 必须解析同一份 effective Provider connection；显式 Provider 地址/密钥不得被旧 env、Codex 本机登录或 TOML provider 优先级静默覆盖。保留 secret 写入式语义、未知 TOML/env/config 和其他 Agent 行为。

## Spec Gate

- 负责人确认这是已确认功能的缺陷排查，边界清楚，跳过新增 PM spec。
- 既有产品依据：`.agent-tower/spec/2026-07-15-simplified-provider-config-spec.md`（User Confirmed: 是，`READY_FOR_TECH_PLAN`）与 `.agent-tower/spec/2026-07-15-provider-effort-permission-followup-spec.md`。
- 核心既定语义：测试使用当前未保存草稿且不持久化；保存成功后新 Agent spawn 使用最新 Provider；Key 采用 `keep|replace|clear`；旧配置只在用户修改对应连接字段后迁移；不修改任何 `~/.codex` 全局文件。

## Root Cause

代码扫描与官方 Codex 配置语义共同确认两个缺陷：

1. `POST /api/providers/test` 调用 `smokeTestProviderConfiguration()`，后者只执行 `getAvailabilityInfo()` 和 `buildCommandBuilder()`。它不读取目标地址发请求，因此不可达 URL、旧/新 key 都可能得到相同的“Configuration and command construction succeeded”。这与既有 spec 的最小鉴权/模型探测要求相反。
2. shared 能力矩阵把 Codex API URL 声明为 `env.OPENAI_BASE_URL`，server mapper 将简化值写入该 env，executor 只把它注入子进程。当前 Codex 官方配置把连接地址定义为内置 provider 的 `openai_base_url`，或自定义 `model_provider/model_providers.<id>.base_url`；provider secret 由 active provider 的 `env_key` 读取，`CODEX_API_KEY` 是 `codex exec` 的单次 key 覆盖。`OPENAI_BASE_URL` 不是当前稳定直读变量，因此保存值存在但不控制请求。父进程 `CODEX_API_KEY`/本机认证也没有针对显式 Provider 做优先级隔离。

已核对的非根因：Web `handleTest()` 使用 `buildDraft()`，API Key replace 通过 env write 发送；server `normalizeProviderDraft()` 正确执行 keep/replace/clear；`updateProvider()` 原子写 `providers.json` 后同步替换内存 cache；`SessionManager` 在每次 spawn 前按 providerId 重新解析 executor/env。Web/cache 仍需补回归测试，避免修复过程中产生新的陈旧草稿问题。

官方依据：当前 Codex manual 的 Environment variables / Custom model providers 章节，以及本机 `codex-cli 0.144.4`。技术实现采用当前文档语义，不继续依赖 `OPENAI_BASE_URL`。

## Architecture

```text
Web local draft (URL + write-only key + config/settings)
        |
        | POST /providers/test, no persistence
        | POST/PUT /providers, atomic persistence
        v
normalizeProviderDraft(existing + keep|replace|clear)
        |
        v
resolveEffectiveProviderConnection  <----- one server source of truth
        |                                  - active Codex model provider
        |                                  - base URL
        |                                  - env_key / in-memory secret
        |                                  - conflict / legacy provenance
        |
        +--> bounded HTTP probe --> local/proxy endpoint --> redacted result
        |
        +--> providers.json/cache --> new SessionManager spawn
                                      |
                                      v
                          Codex -c overrides + sanitized env
```

### Canonical Codex Connection Contract

- Active built-in OpenAI provider: `settings.model_provider` absent or `openai`; URL comes from top-level `settings.openai_base_url` or the official default; canonical stored key remains provider env `OPENAI_API_KEY`, projected to `CODEX_API_KEY` for each `codex exec` spawn.
- Codex-reserved native/local providers supported by the installed CLI, including `oss`, `ollama`, `lmstudio` and `amazon-bedrock`, remain valid without a `model_providers.<id>` custom table. Resolver and normalization must preserve their CLI-native authentication/base URL behavior, must not manufacture simplified connection values, and must not block unrelated save/test/new-spawn flows merely because a custom table is absent. When no probeable HTTP connection is available, test results may report only local availability and must not claim connection success.
- Active custom provider: when `settings.model_provider` names a real `model_providers.<id>` table rather than a Codex-reserved native/local provider, resolve its `.base_url` and `.env_key`; the secret comes from provider env at that dynamic key. Executor masks inherited `CODEX_API_KEY` so it cannot override the selected custom provider credential.
- New simplified Codex connection without an advanced custom provider uses the built-in OpenAI provider and top-level `openai_base_url`, matching current official guidance. It does not create or edit `~/.codex/config.toml`.
- Legacy `env.OPENAI_BASE_URL`: display/read compatibility only. Metadata-only save preserves it byte-for-byte. The first explicit URL edit writes `settings.openai_base_url`, removes only the legacy mapped env entry, and preserves unrelated env/TOML/comments.
- Advanced custom provider conflicts are explicit. A simplified edit may update the uniquely active provider; ambiguous/missing provider tables, conflicting provider selection, or invalid TOML return field diagnostics and block test/save rather than choosing a hidden priority.
- `keep` uses the saved secret only inside server normalization; `replace` uses only the new draft value; `clear` removes the Provider-managed value. None are echoed to Web or Room messages.
- An already-running PTY keeps its startup args/env. A new Agent Tower session, restart, fallback spawn, or follow-up spawn resolves the current saved Provider again; no server restart is required.

## Prototype

本轮不新增 prototype。既有页面结构不变，只更新测试结果语义和必要的字段错误/状态文案；继续沿用当前响应式 Modal、390px 布局、Key 写入式交互和高级配置编辑器。不得重做权限、滑杆或整个 Provider 页面。

## Tech Stack / Constraints

- React 19 + TanStack Query v5；Fastify 4 + Zod；Node fetch/AbortController；`smol-toml`；TypeScript strict；pnpm monorepo。
- shared 只定义跨端能力/结果契约；server service 持有 effective connection、TOML/env 映射、探测和 secret 规则；route 只解析/响应；executor 只把已解析配置投影到命令/env。
- 不访问真实用户 Provider 数据。所有 server/browser/E2E 使用隔离 `AGENT_TOWER_DATA_DIR`、合成 key 和可控 loopback endpoint。
- 不打印 request Authorization、API key、完整 Provider、完整 env 或带密钥的测试 snapshot。

## Global Constraints

- 不修改 Provider 核心模型、CLI 全局文件、权限/思考强度 UI、导入导出格式、远端服务兼容策略或其他 Agent 映射。
- URL/key 测试失败不阻止保存；本地格式/冲突错误继续阻止测试和保存。
- URL 可为 localhost/LAN；探测必须设置短超时、只发最小无用户内容请求，并分类 validation、availability、network/DNS/TLS/timeout、authentication、model/permission、rate-limit、server 和 unknown。
- GET/list/detail/test/error/log 永不返回 secret；完整备份仍是既有明确例外。
- 未知 env/config、TOML 注释、表段、query params、headers 和未映射字段必须保留。

## Files / Responsibilities

- `.agent-tower/architecture.md`, `.agent-tower/coding-standards.md`: effective connection、真实探测、secret 优先级与 spawn 快照边界。
- `.agents/skills/agent-tower-dev/references/pipeline-patterns.md`: 稳定记录显式 Provider credential 必须在 spawn 屏蔽冲突继承认证；按 skill 要求运行 validator。
- `packages/shared/src/provider-capabilities.ts`, `packages/shared/src/types.ts`, `packages/shared/src/__tests__/provider-capabilities.test.ts`: Codex URL 改为 settings/active-provider 语义；扩展脱敏测试结果 stage/error kind，不承载 secret。
- `packages/server/src/services/provider-config.service.ts`, `packages/server/src/services/provider-effective-connection.service.ts`: active provider 解析、legacy 读取/迁移、动态 env_key、无损 TOML 更新、统一 effective connection。
- `packages/server/src/routes/providers.ts`: 对 normalized draft 调用真实 connection probe，做超时/错误分类/脱敏；保留 draft-only、不持久化语义。
- `packages/server/src/executors/index.ts`, `packages/server/src/executors/codex.executor.ts`, `packages/server/src/executors/execution-env.ts`, `packages/server/src/executors/command-builder.ts`: 新 spawn 复用 resolver，构造 `-c` 覆盖和明确 env mask/override；禁止记录 secret。
- `packages/server/src/services/session-manager.ts`: 仅在需要测试“每次 spawn 重新读取 Provider”时做最小可测试性适配，不改变生命周期。
- `packages/web/src/components/provider/provider-draft.ts`, `packages/web/src/pages/ProviderSettingsPage.tsx`, `packages/web/src/hooks/use-providers.ts`, `packages/web/src/lib/i18n/messages.ts`: dynamic env key、Codex settings 双向草稿、连续测试去陈旧结果、保存后 list/detail cache 刷新、结构化连接结果。
- Tests: 邻近 shared/service/route/executor/session/web tests；不得新增依赖真实外部 API 的不稳定测试。

## Task 1: Effective Connection And Lossless Mapping

Files: shared capability/types/tests；provider config service；新 effective connection pure service；架构/编码规范；provider service tests。

Interfaces:

- `resolveEffectiveProviderConnection(provider)` 返回非序列化 secret 的内部对象：agentType、provider kind/id、base URL、env key、server-only secret value、source/legacy provenance、diagnostics。公开 DTO 只保留非敏感 target/source/error kind。
- Codex built-in/custom provider 解析和 URL/key 正反向映射遵循 Canonical Contract；无效 TOML、找不到 active provider、非字符串 base_url/env_key 和重复冲突均产生字段诊断。
- Codex 保留的 native/local provider 不得因缺少 custom table 产生冲突；metadata-only、import 后读取和新 spawn 均保留原生配置。只有真正引用未知 custom provider 时才报告缺表诊断。
- 简化 URL/key 只更新目标路径；legacy `OPENAI_BASE_URL` 仅在显式连接编辑时移除；其他 TOML/env/config 原样保留。
- `ProviderSimplifiedConfig.apiKey.envKey` 可反映 active custom provider 的动态 env_key；Web 不再假定永远是 `OPENAI_API_KEY`。

Verification:

```bash
pnpm exec vitest run packages/shared/src/__tests__/provider-capabilities.test.ts packages/server/src/services/__tests__/provider-config.service.test.ts
pnpm --filter @agent-tower/shared build
pnpm --filter @agent-tower/server build
```

Expected: built-in OpenAI、reserved native/local、custom、legacy、URL-only/key-only/连续替换/clear/keep、invalid/ambiguous TOML、unknown/comment losslessness 全部通过；测试输出不含合成 secret。

## Task 2: Real Draft Connection Probe And Web State

Files: provider route、effective connection/probe service、route tests；provider draft/page/hooks/i18n 与 focused web tests。

Interfaces:

- `/providers/test` 先 normalize 当前 draft，再对 resolver 返回的 URL 发起 bounded minimal probe。Codex OpenAI-compatible 连接至少验证实际请求到达预期 base URL 且使用预期 bearer credential；不发送任务 Prompt/文件。
- Route 返回结构化 `ProviderDraftTestResult`，可区分 connection 成功与仅 availability/command 检查。HTTP 401/403、404/model/permission、429、5xx、timeout/DNS/TLS/network 有稳定分类；响应和错误经过统一 redaction。
- 无可探测 API 配置时可降级为 CLI availability，但 UI 必须明确“仅本机可用性检查”，不得显示“连接成功”。
- Web 测试始终提交当前 `buildDraft()`。所有草稿变更入口，包括结构化字段、Agent 类型切换、原始 JSON 和冲突处理，必须同时清除旧结果并使当前 test sequence 失效；连续 mutate 只接受最后一次请求对应结果，避免较慢旧请求覆盖新结果。
- UI 对连接探测结果展示脱敏的 `target.endpoint` 与本地化 `testedAt`，让连续测试不同有效地址时仍能辨认实际测试对象；不得显示 query credential 或 secret。
- 保存 mutation 用返回的 redacted Provider 更新/失效 `providers.all` 和对应 detail cache；重新打开编辑器显示最新 URL 与 key configured 状态。

Verification:

```bash
pnpm exec vitest run packages/server/src/routes/__tests__/providers.test.ts packages/web/src/components/provider/__tests__/provider-draft.test.ts
pnpm --filter web build
```

Expected: 隔离 loopback server 分别收到 URL A/URL B 和 key A/key B；只改 URL、只改 key、连续修改、Agent 类型/原始 JSON/冲突处理期间的 deferred request、未保存直接测试、保存后测试均可证明无 stale；UI 显示脱敏 target/time，HTTP body/log/snapshot 不含 key。

## Task 3: Codex Spawn Consumption And Inherited Credential Isolation

Files: executor factory、Codex executor、ExecutionEnv/CommandBuilder、focused executor/session tests、agent-tower-dev pipeline reference。

Interfaces:

- 每次 `getExecutorByProvider`/SessionManager spawn 读取当前 Provider cache 并调用同一 resolver；不缓存旧 effective connection 跨 spawn。
- Built-in OpenAI provider 把显式 canonical key投影到单次 `CODEX_API_KEY`，URL 通过 Codex `-c openai_base_url=...` 且 active provider 不被用户全局 TOML 抢占。
- Custom provider 使用其 `model_provider/model_providers.<id>.base_url/env_key` 和对应 env value；显式 mask 父进程 `CODEX_API_KEY`，避免旧 key 优先。
- Reserved native/local provider 保留 CLI 原生 provider 选择和认证/base URL 行为，不要求 custom table，不注入 OpenAI/custom credential override，也不因缺少 probeable URL 阻断 new session/restart/follow-up/fallback spawn。
- `ExecutionEnv`/`CmdOverrides` 如需支持 unset/mask，必须保留现有 blocked env、TeamRun/MCP 注入和 Claude ANTHROPIC 清理不变量。
- 已启动 child 不热更新；更新 Provider 后创建的新 session/follow-up spawn 使用新 URL/key。旧 spawn 的捕获参数/env 保持旧快照是预期行为。

Verification:

```bash
pnpm exec vitest run packages/server/src/executors/__tests__/codex.executor.test.ts packages/server/src/executors/__tests__/base.executor.test.ts packages/server/src/services/__tests__/session-manager.lifecycle.test.ts
pnpm --filter @agent-tower/server build
```

Expected: fake Codex executable/PTY capture 证明 URL/key A 保存后首个 spawn 使用 A，更新为 B 后新 spawn 使用 B；父进程放入不同 sentinel key 时 child 仍只使用 Provider key；custom env_key、reserved native/local 与缺省/local-login 分支正确且无 secret 日志。

## Task 4: Targeted Review And E2E

实现成员提交 clean 业务 SHA 后，同时派发 dedicated targeted REVIEW/TEST，二者绑定相同 `targetSourceWorkspaceId`、`targetHeadSha`、`targetBranchName` 和 purpose。任何修复产生新 SHA，旧 verdict 失效并重新派发。

Reviewer 检查：single resolver、Codex built-in OpenAI/custom/legacy/reserved native-local 映射、secret redaction/env mask、legacy 无损迁移、测试不假成功、所有草稿变更路径的 request sequence 失效、结果 target/time 可辨识、旧/new spawn 边界，以及 Claude/Gemini/Cursor/导入导出/权限/effort 回归。

Tester 使用隔离 data dir 和 loopback endpoint：桌面 1440x900、移动 390x844 编辑 Codex；依次验证仅 URL、仅 key、连续 URL/key、未保存测试不持久化、保存后重开/测试、新 session 参数级消费。loopback endpoint 只记录“请求已到达、鉴权 sentinel 是否匹配”，不得把 header/key写入截图、日志或 Room。无法安全跑真实外部 API 时，该本地端点加 fake Codex spawn 是验收依据。

## Acceptance Mapping

| Acceptance | Coverage |
| --- | --- |
| 稳定复现旧测试对任意 URL/key 结果相同 | Root Cause + Task 2 route regression |
| URL/key 当前草稿实际进入测试请求 | Task 1 resolver + Task 2 loopback probe |
| 保存后新 Codex session 使用最新连接 | Task 3 fake spawn/session test + Task 4 |
| keep/replace/clear、动态 env_key、连续修改无 stale | Task 1/2 tests |
| 旧 env/TOML/global auth 不静默抢占 | Task 1 conflict/legacy tests + Task 3 env mask |
| Reserved native/local Codex provider 不被误判为缺失 custom table | Task 1 resolver/normalize tests + Task 3 spawn + Task 4 |
| secret 不出现在浏览器、HTTP、日志、Room、snapshot | Task 1-4 redaction assertions |
| 旧 child 不热更新，新 spawn 读取最新 | Task 3 lifecycle assertions + final report |
| 其他 Agent、导入导出、冲突、权限、effort 无回归 | focused suite + targeted REVIEW/TEST |
| 桌面与 390px 可用 | Task 4 browser E2E |

## Dependencies / Parallel Split

- Task 1 是 Task 2/3 的共同前置，因为 probe 与 executor 必须共享 resolver。
- Task 2 与 Task 3 理论上可并行，但会同时修改 Provider contract/server tests，且当前只有一个实现工程师。为避免两套 connection truth 和文件冲突，本轮由一个实现工程师顺序完成 Task 1-3，不拆并行写入。
- REVIEW 与 TEST 在固定业务 SHA 后并行；两者均为只读 dedicated workspace。

## Risks / Tradeoffs

- 当前历史 Provider 可能同时含 legacy `OPENAI_BASE_URL`、custom model_provider、Codex-reserved native/local provider 和本机 auth。自动猜优先级会继续制造问题，因此仅真正未知/含糊的 custom 引用产生冲突；reserved native/local 分支按 CLI 原生语义保留。
- GET `/models` 并非每个兼容代理都支持；probe 实现需把“端点不支持该探测”与网络/认证失败区分，不能因探测策略误报保存无效。保存永远不依赖探测成功。
- `CODEX_API_KEY` 是 `codex exec` 单次 override；仅在 built-in OpenAI + Provider 显式 key 时投影。Custom provider 应使用其 env_key，避免用通用 key 覆盖 provider-specific auth。
- 运行中 process 不可能安全热换 env。用户可见承诺限定为新 spawn；如未来要在长驻进程中热更新，需要独立生命周期设计。
- 本次修复改变 Provider 连接测试的真实网络行为和 Codex credential trust boundary，因此必须同步 `.agent-tower` 架构/规范与 agent-tower-dev pipeline reference；不改变其他长期模块边界。

## Plan Self-review

- Spec coverage: 已覆盖草稿测试、保存/缓存、新 session、secret 三态、legacy/TOML/env 优先级、其他 Agent 回归、桌面/390px 和旧进程边界。
- Root cause evidence: route/executor/service 代码事实与当前 Codex manual 一致；不存在把用户主目录配置写入本轮范围的假设。
- Unresolved marker scan: 文档没有未决标记或开放产品选择；probe 对不支持 `/models` 的分类是实现要求，不是开放问题。
- Interface consistency: Tasks 1-3 统一引用 `resolveEffectiveProviderConnection`、normalized draft、`ProviderDraftTestResult` 和同一 canonical Codex contract。
- Task granularity: 一个实现成员顺序修改共享 resolver、probe/web、executor；targeted review/test 只读，不存在并行写冲突。
- Architecture/maintenance: 通过单一 resolver、显式 env mask 和 legacy edit-time migration 消除短期补丁与隐式优先级；没有扩大为 Provider 重构。
- Review feedback integration: 已吸收固定 SHA `94393cb1` 的 CHANGES_REQUESTED，修正“非 openai 一律 custom”的错误假设，并把所有草稿变更路径的测试序列失效及成功结果 target/time 可辨识纳入 Task 2/4 验收；不新增产品选择。
