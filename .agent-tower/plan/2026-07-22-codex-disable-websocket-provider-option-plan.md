# Codex Disable WebSocket Provider Option Implementation Plan

## Goal

在 Codex Provider 的简化配置中增加“禁用 WebSocket”开关。默认关闭时保持现有行为；开启后，每个新启动、重试、follow-up、resume 失败 fallback 的 Codex 进程都必须使用当前 Provider 快照，通过 CLI `-c` 配置确保 Responses API 不使用 WebSocket/WSS。运行中的子进程不热更新。保存、重新打开、高级 JSON 编辑和实际 argv 投影必须一致，且不得改变 URL、Key、模型、思考强度、权限或其他 Agent 的现有语义。

## Spec Gate

- 负责人确认这是已确认 Codex Provider 简化配置上的单一布尔增量，用户目标、范围、验收与非目标明确，跳过 PM 和 prototype。
- 交互沿用 `ProviderSettingsPage` 的“基本配置 + 高级配置”模式，不重构页面。
- 官方依据（2026-07-22）：
  - [Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml) 定义 `model_providers.<id>.supports_websockets: boolean`，用于声明 Provider 是否支持 Responses API WebSocket transport。
  - [Codex config JSON schema](https://developers.openai.com/codex/config-schema.json) 为 `ModelProviderInfo.supports_websockets` 声明默认值 `false`。
  - 本机已验证使用的 Codex CLI 为 `0.144.4`；对应官方源码 tag `rust-v0.144.4` 是本轮运行时优先级依据。

## Version / Priority Conclusion

Codex CLI `0.144.4` 的实际选择逻辑不是同时读取三个开关：

1. `core/src/client.rs::responses_websocket_enabled()` 只在 active provider 的 `supports_websockets=true` 且本 session 未触发 fallback 时启用 WebSocket。
2. `features.responses_websockets` 和 `features.responses_websockets_v2` 在该版本已标记 `Stage::Removed`，默认 false，client 选择逻辑不再读取它们。Agent Tower 不生成这两个失效参数。
3. 自定义 Provider 的 `supports_websockets` 缺省 false；在 argv 尾部追加 `-c model_providers.<id>.supports_websockets=false` 可覆盖高级 TOML 中较早的 true。
4. 内置 `openai` 在源码中固定 `supports_websockets=true`，且 `merge_configured_model_providers()` 对同名内置 Provider 使用 `or_insert`，因此 `-c model_providers.openai.supports_websockets=false` 会被忽略，不能作为验收实现。
5. 开启禁用选项时，内置 OpenAI 必须切换到 Agent Tower 注入的唯一 runtime provider alias。该 alias 投影与当前 effective OpenAI connection 等价的 `name/base_url/wire_api/requires_openai_auth`，并显式设置 `supports_websockets=false`；`model_provider` 的最后一个 `-c` 指向 alias。Provider secret 仍只在 env 中，不进入 alias argv。
6. `ollama`、`lmstudio`、`amazon-bedrock` 和现有 native/OSS 路径在 `0.144.4` 源码中已为 `supports_websockets=false`，且部分内置 Provider不可覆盖。本轮不为它们制造无效 feature flag 或脆弱 alias；UI 应明确该开关仅对可使用 Responses WebSocket 的 OpenAI/custom 路径生效。

版本策略：实现保证 `0.144.4` 与当前官方 schema。未来 Codex 若允许覆盖内置 Provider，应在独立兼容升级中移除 alias；本轮不得通过猜测未来行为简化当前正确性。

## Architecture

```text
ProviderSettingsPage (Codex-only toggle)
        |
        | provider.config.disableResponsesWebsocket: boolean
        | same field edited by simple control and Advanced JSON
        v
Provider draft normalization / boolean validation
        |
        +--> providers.json + redacted GET/list/detail
        |
        v
getExecutorByProvider() on every new spawn
        |
        v
CodexExecutor.buildConfigOverrides()
        |
        +--> toggle off: existing argv unchanged
        +--> custom: final model_providers.<id>.supports_websockets=false
        +--> built-in openai: final runtime alias + supports_websockets=false
        +--> native: existing provider is already HTTP-only
        v
codex exec | codex exec resume | resume fallback to codex exec
```

### Runtime Contract

- Canonical Agent Tower field: `provider.config.disableResponsesWebsocket`.
- Missing/false means “do not override Codex transport”; this preserves existing Provider behavior and any explicit advanced Codex setting.
- True means “force non-WebSocket transport for an applicable active provider”. It is an Agent Tower runtime control, not a second secret or connection field.
- The executor appends transport overrides after raw `settings` and effective connection overrides. Last-write order prevents advanced `supports_websockets=true` from defeating the explicit disable control.
- Built-in alias id is a constant owned by `codex.executor.ts`, uses only safe config values, and cannot be derived from a user-controlled id. It must not collide with a user Provider table; choose an Agent Tower-reserved id and document it in tests.
- `getExecutorByProvider()` constructs a fresh executor snapshot for each new spawn. Existing PTY behavior remains unchanged.
- Provider connection probe remains HTTP `/models` verification and does not claim to verify Codex transport. It only validates the new boolean type as part of draft validation.

## Prototype

不涉及 prototype。沿用当前基本配置区与现有二进制控件样式；Codex-only 开关使用现有 toggle/checkbox 组件约定，标题为“禁用 WebSocket”，辅助文案准确限定为 Responses API transport。不得新增营销说明、页面卡片或跨 Agent 控件。

## Tech Stack / Constraints

- React 19、TanStack Query v5、TypeScript strict、Fastify/Zod、`smol-toml`、pnpm monorepo。
- shared 定义跨端 capability/path/diagnostic；server service 做 Provider draft 校验；executor 独占 argv 投影；web 只编辑同一份本地 draft。
- 使用 `CommandBuilder` 和现有 `toTomlLiteral()`，不拼 shell 字符串。
- API Key、token、完整 env 不得进入 argv、日志、截图、Room 或测试 snapshot。
- 不启动真实外部 API 请求作为自动化依赖；传输验证使用合成 Provider、fake Codex/argv capture 和必要的 loopback HTTP/WS 观察。

## Global Constraints

- 不改 Claude/Gemini/Cursor Provider UI 或 capability。
- 不改 URL、Key、model、effort、permission、legacy `OPENAI_BASE_URL`、全局 `CODEX_HOME` 或配置文件治理语义。
- 不将 `features.responses_websockets*` 写入新配置。
- 不写 `~/.codex/config.toml`，不发布、不 push。
- 只更新本功能稳定边界相关的 `.agent-tower` 架构/编码规范；该字段是局部功能，不扩写 `agent-tower-dev` skill，除非实现发现可复用边界发生变化。

## Files / Responsibilities

- `packages/shared/src/provider-capabilities.ts`, `packages/shared/src/types.ts`: Codex-only runtime boolean capability与 diagnostic field。
- `packages/shared/src/__tests__/provider-capabilities.test.ts`: capability path、Codex-only 和默认语义。
- `packages/server/src/services/provider-config.service.ts`: boolean type validation；保持无损 config/settings/env 映射。
- `packages/server/src/services/__tests__/provider-config.service.test.ts`: save/reopen、invalid type、advanced round-trip、其他字段保留。
- `packages/server/src/executors/codex.executor.ts`, `packages/server/src/executors/index.ts`: runtime flag、custom final override、built-in alias、native boundary和 argv ordering。
- `packages/server/src/executors/__tests__/codex.executor.test.ts`: exact argv、toggle on/off、secret absence、built-in/custom/legacy/native。
- `packages/server/src/services/__tests__/session-manager.lifecycle.test.ts`: new spawn、restart/follow-up/fallback 重新解析和旧 executor snapshot。
- `packages/server/src/routes/__tests__/providers.test.ts`: REST draft/save/read/test normalization，不改变 probe 语义。
- `packages/web/src/components/provider/provider-draft.ts`, `packages/web/src/pages/ProviderSettingsPage.tsx`, focused tests: Codex-only control、Advanced JSON 双向同步、draft invalidation、保存重开。
- `packages/web/src/lib/i18n/messages.ts`: 中英文文案。
- `.agent-tower/architecture.md`, `.agent-tower/coding-standards.md`: 记录 transport runtime option、`-c` ordering、built-in alias和 secret 边界。

## Technical Tradeoffs

- 选择 `provider.config.disableResponsesWebsocket`，而不是直接改 raw TOML：当前 Codex 不允许同名配置覆盖内置 OpenAI，单纯写 `[model_providers.openai]` 会显示已保存但运行无效。runtime config 能让 simple/advanced JSON 共用唯一状态，并由 executor做版本正确的投影。
- 只在 toggle=true 时创建 built-in alias，避免默认行为、ChatGPT/API auth 或用户全局设置发生无意变化。
- alias 是当前版本的必要兼容层而非通用 Provider 重构。实现必须最小复制内置 OpenAI 所需字段，并用 argv/真实 CLI smoke 测试确认认证选择与 HTTP transport；若 CLI 拒绝 alias 或无法保持现有 auth，立即停止并由负责人向用户说明版本限制，不可降级成无效开关。
- native Provider 已从源码保证 HTTP-only；为其追加 removed feature flags会制造虚假安全感，因此不做。

## Task 1: Shared Contract, Mapping And Architecture

Files:
- `packages/shared/src/provider-capabilities.ts`
- `packages/shared/src/types.ts`
- `packages/shared/src/__tests__/provider-capabilities.test.ts`
- `packages/server/src/services/provider-config.service.ts`
- `packages/server/src/services/__tests__/provider-config.service.test.ts`
- `.agent-tower/architecture.md`
- `.agent-tower/coding-standards.md`

Interfaces:
- 在 `ProviderCapability` 增加可选 Codex runtime boolean capability，path 固定为 `disableResponsesWebsocket`；只有 `AgentType.CODEX` 声明。
- Provider draft 对该 path 只接受 boolean；缺失等价 false，不将 truthy 历史值静默转换。
- simple control 与 Advanced JSON 都读写 `provider.config.disableResponsesWebsocket`；不复制第二份 `ProviderSimplifiedConfig` 状态。
- `redactProvider()` 原样返回该非敏感 boolean；secret 路径不变。
- connection probe 不受开关影响，但 invalid boolean 必须阻止 save/test并返回字段诊断。

Verification:

```bash
pnpm exec vitest run packages/shared/src/__tests__/provider-capabilities.test.ts packages/server/src/services/__tests__/provider-config.service.test.ts
pnpm --filter @agent-tower/shared build
```

Expected: Codex true/false/missing round-trip，非法字符串/数字被拒绝；unknown config、TOML 注释、URL/Key/model/effort/permission 和其他 Agent fixtures 不变。

## Task 2: Codex Argv Projection And Lifecycle

Files:
- `packages/server/src/executors/codex.executor.ts`
- `packages/server/src/executors/index.ts`
- `packages/server/src/executors/__tests__/codex.executor.test.ts`
- `packages/server/src/services/__tests__/session-manager.lifecycle.test.ts`
- 必要时 `packages/server/src/routes/__tests__/providers.test.ts`

Interfaces:
- `CodexConfig.disableResponsesWebsocket?: boolean` 由 Provider `config` 进入 executor。
- `buildConfigOverrides()` 的 transport block 位于 raw settings 与 effective connection之后。
- Toggle false/missing：argv byte-for-byte 不新增 WebSocket相关 `-c`。
- Custom：最终包含 `-c model_providers.<active-id>.supports_websockets=false`；即使 raw TOML earlier true，最后值为 false。
- Built-in OpenAI/legacy OpenAI：最后切换 reserved runtime alias，并投影等价 connection fields和 `supports_websockets=false`；secret只通过现有 `CODEX_API_KEY`/env链路。
- Native/local：不创建 alias；断言 active provider源码/配置已为 non-WebSocket，并保持原有 argv/env。
- `spawn()` 与 `spawnFollowUp()` 共用同一 `buildConfigOverrides()`；resume失败的 `executor.spawn()` fallback自动继承同一配置。

Required actual argv example for enabled custom Provider:

```text
codex ...
  -c 'model_provider="proxy"'
  -c 'model_providers.proxy.base_url="https://provider.invalid/v1"'
  -c 'model_providers.proxy.env_key="PROXY_API_KEY"'
  -c 'model_providers.proxy.supports_websockets=false'
  exec --json --skip-git-repo-check -
```

Built-in example must show the final reserved alias `model_provider` and alias `supports_websockets=false`; no key value may appear.

Verification:

```bash
pnpm exec vitest run packages/server/src/executors/__tests__/codex.executor.test.ts packages/server/src/services/__tests__/session-manager.lifecycle.test.ts packages/server/src/routes/__tests__/providers.test.ts
pnpm --filter @agent-tower/server build
```

Expected: built-in/custom/legacy/native, toggle off/on, advanced true overridden, new spawn/restart/follow-up/fallback, old executor snapshot全部通过；argv/log JSON不含合成 secret。

Version smoke check in the implementation workspace:

```bash
codex --version
codex -c 'model_provider="agent-tower-openai-http"' \
  -c 'model_providers.agent-tower-openai-http.name="OpenAI"' \
  -c 'model_providers.agent-tower-openai-http.base_url="http://127.0.0.1:PORT/v1"' \
  -c 'model_providers.agent-tower-openai-http.wire_api="responses"' \
  -c 'model_providers.agent-tower-openai-http.requires_openai_auth=true' \
  -c 'model_providers.agent-tower-openai-http.supports_websockets=false' \
  exec --json --skip-git-repo-check -
```

Expected: CLI version记录；受控 loopback只收到 HTTP Responses 请求或在更早的非 transport 校验阶段失败，绝不能收到 WebSocket upgrade。测试不得使用真实 key/URL。

## Task 3: Codex-only UI And Round-trip

Files:
- `packages/web/src/components/provider/provider-draft.ts`
- `packages/web/src/components/provider/__tests__/provider-draft.test.ts`
- `packages/web/src/pages/ProviderSettingsPage.tsx`
- 邻近 `ProviderSettingsPage` component tests
- `packages/web/src/lib/i18n/messages.ts`

Interfaces:
- 基本配置仅 Codex显示“禁用 WebSocket”二进制控件；默认 off。
- 开关直接更新 `config.disableResponsesWebsocket`、Advanced JSON text、dirty state并 invalidate在途测试结果。
- Advanced JSON 合法编辑反向更新开关；非法类型显示字段错误并阻止 test/save。
- Agent 类型切换清除 Codex-only字段；Claude/Gemini/Cursor不显示、不提交该控件。
- 保存、列表刷新和重新打开显示持久化值；导入/导出沿用现有 config passthrough。
- 文案不承诺禁用所有 WebSocket，只说明禁用 Codex Responses API WebSocket transport；native状态不得误导。

Verification:

```bash
pnpm exec vitest run packages/web/src/components/provider/__tests__/provider-draft.test.ts
pnpm --filter web build
```

Expected: simple -> JSON、JSON -> simple、save/reopen、toggle期间deferred test、Codex-only、desktop/mobile layout测试通过。

## Task 4: Targeted Review And Browser E2E

实现工程师提交 clean SHA 后，针对同一固定交付并行派发 dedicated reviewer 与 E2E tester。两份 WorkRequest 必须绑定相同：

- `targetSourceWorkspaceId`
- `targetHeadSha`
- `targetBranchName`
- `targetPurpose=REVIEW` 或 `TEST`

Reviewer重点：
- CLI `0.144.4` 优先级结论是否被准确实现；没有依赖 removed feature flags。
- built-in alias是否保持有效 auth/base URL/wire API且只在 toggle=true出现。
- custom最后覆盖、native边界、argv顺序、secret redaction、spawn snapshot。
- UI单一状态源、invalid type、advanced round-trip、其他 Provider回归和架构文档同步。

Tester使用隔离 data dir、合成 secret、fake Codex与受控 loopback：
- 1440x900 与 390x844 打开 Codex Provider，验证开关、保存、重开、Advanced JSON双向同步和无溢出。
- Toggle off不得新增 transport override；toggle on的 built-in/custom argv含最终 false。
- 触发 new session、retry/start、follow-up resume与resume失败 fallback，确认每次新 spawn重新读取；旧运行进程不变。
- loopback分别记录 HTTP request与WebSocket upgrade计数，Room/截图/日志不得包含 header/key。

任何返修产生新 SHA 后，旧 REVIEW/TEST verdict失效，必须重新绑定新 SHA。

## Acceptance Mapping

| Acceptance | Coverage |
| --- | --- |
| Codex-only“禁用 WebSocket”开关，默认不改变行为 | Task 1 capability + Task 3 UI |
| 开启后 built-in/custom强制非 WSS | Task 2 exact argv + loopback smoke + Task 4 |
| 不依赖 removed feature flags | Version Conclusion + Task 2 review |
| 保存重开、Advanced JSON 双向一致 | Task 1/3 tests + Task 4 browser |
| new spawn/restart/follow-up/fallback使用最新值 | Task 2 lifecycle + Task 4 |
| 运行中 child保持启动快照 | Task 2 lifecycle |
| native/legacy边界正确 | Task 2 matrix + reviewer |
| Key不进入 argv/log/UI/Room | Task 2 secret assertions + Task 4 |
| 其他 Agent和现有字段无回归 | Task 1/3 focused regressions + builds |

## Dependencies / Parallel Split

- Task 1 的 capability/path 与 validation 是 Task 2/3共同前置。
- Task 2/3都依赖相同 Provider contract且可能修改 shared fixtures；当前只有一个实现工程师，为避免双写同一工作流，由一个实现工程师顺序完成 Task 1-3。
- 固定业务 SHA 后，REVIEW 与 TEST 为只读 dedicated workspaces，可并行。
- Review/Test都通过后才能评估 merge readiness；只有负责人已授权且 workspace ready时执行 merge，不发布或 push。

## Risks / Blocking Conditions

- 最大风险是内置 OpenAI 不允许同名 override。alias smoke若不能维持现有认证或 HTTP transport，必须停止并报告，不得把无效 `model_providers.openai.supports_websockets=false` 交付给用户。
- 当前官方 schema仍暴露 removed feature字段，单看 schema会误导；本轮按安装版本源码的 active selection逻辑实现并记录版本风险。
- `supports_websockets=false` 控制 Responses transport，不影响 Codex的 MCP、remote-control、realtime等其他 WebSocket用途；UI文案必须限定范围。
- 连接测试 `/models` 不验证 transport；验收必须包含 argv与loopback upgrade观察。
- Alias复制的内置 provider必要字段是版本兼容债；通过常量、集中 helper和版本回归测试控制，未来 CLI升级时单点移除。

## Plan Self-review

- Spec coverage：覆盖开关默认/开启、built-in/custom/legacy/native、save/reopen、advanced round-trip、new/restart/follow-up/fallback、旧 child快照、secret和E2E。
- Evidence：官方配置页、官方 schema、已安装 `0.144.4` 二进制符号和对应官方源码共同支持优先级结论。
- Unresolved markers：文档没有开放产品选择或含糊实现项；alias smoke失败被定义为明确阻塞条件。
- Interface consistency：所有任务统一使用 `config.disableResponsesWebsocket` 和 `CodexConfig.disableResponsesWebsocket`；没有第二份 boolean truth。
- Task granularity：一个实现成员顺序修改共享 contract、server/executor和web；review/test固定 SHA并行，不存在并行写冲突。
- Architecture/maintenance：实现保持 Provider -> executor runtime投影边界，不侵入 SessionManager生命周期、不扩大全局 Codex配置治理；`.agent-tower` 稳定规范同步纳入 Task 1。
