# Provider 思考强度与执行权限 Follow-up Implementation Plan

- 日期：2026-07-15
- Spec：`.agent-tower/spec/2026-07-15-provider-effort-permission-followup-spec.md`
- Spec 状态：User Confirmed = 是，Verdict = `READY_FOR_TECH_PLAN`
- Prototype：`.agent-tower/prototypes/2026-07-15-provider-effort-permission-followup-prototype.md`
- 架构基线：`.agent-tower/architecture.md`
- 编码规范：`.agent-tower/coding-standards.md`

## Goal

在不改变 Provider 持久化边界、内置默认与 executor 既有行为的前提下：

1. 将 Claude Code / Codex 思考强度改为能力矩阵驱动的五档离散滑杆，并把“跟随 CLI”实现为独立无值模式。
2. 在高级配置顶部恢复四类 Agent 的单一“执行权限”结构化开关，与原始运行配置 JSON 共用草稿、严格校验并持续呈现风险。
3. 保持 API 地址、Key、模型、冲突处理、secret 脱敏、导入导出、内置恢复、任务选择及 JSON/TOML 无损更新无回归。

## Architecture

权限不增加新的持久化字段。shared 只声明映射能力，web 和 server 读取同一契约，`provider.config` 仍是唯一状态源。

```text
shared PROVIDER_CAPABILITIES
  |-- reasoningEffort: path + ordered options
  `-- executionPermission: config path + risk kind
          |                         |
          v                         v
web Provider draft              server normalize/validate
  |-- segmented slider             |-- legal effort enum / unset
  |-- permission switch             |-- boolean / absent only
  |-- raw JSON/TOML                 |-- lossless mapped update
  `-- one config/settings draft     `-- providers.json
                                           |
                                           v
                                  existing executors -> CLI flags
```

数据流规则：

- `reasoningEffort === undefined` 表示未触碰；显式空字符串表示删除覆盖并跟随 CLI。Claude 删除 `config.effort`，Codex 通过 server 无损 mapper 删除顶层 `model_reasoning_effort`。
- 权限值不进入 `ProviderSimplifiedConfig`，避免同一布尔值在 `config` 与 simplified 中重复。能力描述符只提供 `kind: 'config'`、字段路径与稳定风险语义；用户文案由 web i18n 依据 Agent 类型呈现。
- Switch 与 JSON textarea 都更新 `ProviderFormData.config`。缺失/`false` 为关闭，`true` 为开启，其他类型产生 `executionPermission / INVALID_TYPE` 诊断。
- 结构化开关由关闭/缺失切换为开启时先确认；取消不修改草稿。已有 `true` 或 JSON 直接改为 `true` 不重复弹窗，但立即显示持续风险提示。该规则避免原始编辑器输入过程中反复弹窗，同时确保结构化主动开启有明确确认。
- 未触碰既有 Provider 不产生差异；新建自定义 Provider 继续从空 config 开始。四个内置 Provider 的现有 `true` 不迁移、不反转。

## Prototype

实现参考 `.agent-tower/prototypes/2026-07-15-provider-effort-permission-followup-prototype.md` 的信息层级、状态与响应式行为，不按像素级还原。风险确认复用现有响应式 Modal/ConfirmDialog；不新增 Sheet 依赖。滑杆用 React/HTML/CSS 实现，不引入图片或新的交互库。

## Tech Stack / Constraints

- React 19、TypeScript 5、TailwindCSS v4、现有 shadcn/Radix 组件、`useI18n`。
- shared 类型是 web/server 唯一跨端契约；server ESM import 保留 `.js`。
- 业务映射与验证放在 shared 描述符和 server service/纯 mapper；页面不得实现 TOML 字符串替换。
- 不写本机 CLI 全局文件，不新增细粒度 sandbox/approval policy，不改变 executor flag 语义。
- 不引入新的依赖；遵循 reduced-motion、键盘、ARIA、44px 触控热区和稳定尺寸要求。

## Global Constraints

- 范围仅限 Provider shared contract、server mapper/validator/route tests、现有 executor regression tests、Provider web draft/form/detail/i18n 与 focused tests。
- 原始 JSON/TOML 专家入口必须保留；未知 config 字段、TOML 注释、空行、表段和未映射内容必须保留。
- 格式/类型/非法枚举错误阻止测试与保存；联网 smoke test 失败仍不阻止保存。
- secret、备份例外和响应脱敏边界不得变化。
- 不重构 Provider 子系统、会话启动、executor factory、导入导出或任务选择工作流。

## Files And Responsibilities

| File | Responsibility |
| --- | --- |
| `packages/shared/src/provider-capabilities.ts` | 声明 ordered effort options 与四类 execution permission config path/risk kind。 |
| `packages/shared/src/types.ts` | 扩展能力/诊断契约，保持 config 为权限唯一状态源。 |
| `packages/shared/src/__tests__/provider-capabilities.test.ts` | 覆盖四类能力矩阵与五档顺序。 |
| `packages/server/src/services/provider-config.service.ts` | 严格权限类型校验、非法 effort 校验、无损映射与 read diagnostics。 |
| `packages/server/src/services/__tests__/provider-config.service.test.ts` | 覆盖新旧默认、非布尔、unset、未知字段与 TOML 无损。 |
| `packages/server/src/routes/__tests__/providers.test.ts` | 覆盖 create/update/test 响应及阻断语义。 |
| `packages/server/src/executors/__tests__/*.test.ts` | 证明四个既有 config 字段仍生成/不生成对应 CLI flag。 |
| `packages/web/src/components/provider/provider-draft.ts` | 纯函数读取/更新/校验 execution permission 草稿。 |
| `packages/web/src/components/provider/SegmentedEffortSlider.tsx` | 五档滑杆、跟随 CLI、pointer/keyboard/ARIA/reduced-motion。 |
| `packages/web/src/components/provider/__tests__/provider-draft.test.ts` | 覆盖 config 双向同步、非布尔和未知字段保留。 |
| `packages/web/src/components/provider/__tests__/SegmentedEffortSlider.test.tsx` | 覆盖点击/拖拽、方向键、Home/End、ARIA、unset/restore。 |
| `packages/web/src/pages/ProviderSettingsPage.tsx` | 集成滑杆、权限确认/警示/折叠状态、详情摘要与保存门禁。 |
| `packages/web/src/lib/i18n/messages.ts` | 增加用户可见标签、风险说明和错误文案。 |

不应修改 Prisma schema、Provider persistence 文件格式、CLI 全局配置、任务/会话 API 或无关设置页面。

## Technical Decisions

- 能力矩阵扩展优于页面常量：四类权限路径已有 executor 消费者，将它们提升为 shared capability 可防止 web/server 漂移，同时不改变数据模型。
- 不把权限塞进 simplified：它属于高级高风险配置，且 JSON 与开关应自然共享 `config`，新增镜像字段会制造冲突状态和迁移成本。
- 滑杆做领域组件：它有 pointer capture、键盘、ARIA、unset 和恢复最近值等独立状态，拆出组件可单测并避免 Provider 页面继续膨胀。
- TOML 写入继续只由 server 无损 mapper负责：web 只更新 simplified 草稿和解析有效高级值，不自行重写 TOML 行。
- 本轮更新项目架构/编码规范，但不更新 `agent-tower-dev` skill：这是 Provider 域内契约细化，没有改变可复用的仓库级模块、生命周期、认证或运行时边界。

## Task 1 - Shared Contract And Server Validation

### Files

- 修改 `packages/shared/src/provider-capabilities.ts`
- 修改 `packages/shared/src/types.ts`
- 修改 `packages/shared/src/__tests__/provider-capabilities.test.ts`
- 修改 `packages/server/src/services/provider-config.service.ts`
- 修改 `packages/server/src/services/__tests__/provider-config.service.test.ts`
- 修改 `packages/server/src/routes/__tests__/providers.test.ts`
- 必要时只补 `packages/server/src/executors/__tests__/` 中四类现有 flag 回归断言

### Interfaces

- `ProviderCapability.executionPermission?: ProviderMappedFieldCapability & { riskKind: ... }`，固定 `kind: 'config'`。
- `ProviderConfigDiagnostic.field` 增加 `executionPermission`；`code` 增加 `INVALID_TYPE`。
- 新的 mapper/validator 接收 `agentType + config`，返回 `boolean | undefined` 或字段级诊断；不对非布尔值做强制转换。
- 依赖：无；Task 2 依赖本任务的 shared contract。

### Verification

```bash
pnpm exec vitest run packages/shared/src/__tests__/provider-capabilities.test.ts packages/server/src/services/__tests__/provider-config.service.test.ts packages/server/src/routes/__tests__/providers.test.ts packages/server/src/executors/__tests__
pnpm --filter @agent-tower/shared build
pnpm --filter @agent-tower/server build
```

期望：所有 focused tests 通过；shared/server build 退出码 0；四类 true/false flag 映射、非布尔阻断、缺失兼容、unknown config 保留、effort enum/unset 和 Codex TOML 无损均有断言。

## Task 2 - Slider And Permission UI

### Files

- 创建 `packages/web/src/components/provider/SegmentedEffortSlider.tsx`
- 创建 `packages/web/src/components/provider/__tests__/SegmentedEffortSlider.test.tsx`
- 修改 `packages/web/src/components/provider/provider-draft.ts`
- 修改 `packages/web/src/components/provider/__tests__/provider-draft.test.ts`
- 修改 `packages/web/src/pages/ProviderSettingsPage.tsx`
- 修改 `packages/web/src/lib/i18n/messages.ts`

### Interfaces

- `SegmentedEffortSlider` 接收 ordered options、当前 `string | undefined/empty`、本地化标签、disabled/error 和 `onChange(value: string)`；空字符串表示用户选择跟随 CLI。
- 组件内部只记忆本次挂载最近合法显式档位；从 unset 关闭跟随模式时无历史则选择 `medium`。
- provider draft helper 依据 `capability.executionPermission.path` 读取状态、返回非布尔错误，并以不可变更新只修改该 key。
- `ProviderSettingsPage` 将错误并入 test/save gate；高级折叠标题支持可选风险状态；详情区用用户文案显示开启/关闭。
- 依赖：Task 1 shared contract；完成后进入 Task 3。

### Verification

```bash
pnpm exec vitest run packages/web/src/components/provider/__tests__/provider-draft.test.ts packages/web/src/components/provider/__tests__/SegmentedEffortSlider.test.tsx
pnpm --filter web build
```

期望：focused tests 通过；web build 退出码 0；点击/拖拽/方向键/Home/End、ARIA、跟随 CLI、恢复最近值、权限确认取消/接受、JSON 双向同步和门禁可被测试或可复现步骤覆盖。

## Task 3 - Integrated Verification, Review And E2E

### Scope

- 只读审查 Task 1-2 的固定业务提交，不修改业务代码。
- E2E 在同一固定提交验证桌面 1440x900 与移动 390px。
- 发现问题回派唯一实现工程师修复；新 SHA 重新绑定 review/test，旧 verdict 不沿用。

### Browser Scenarios

- Claude/Codex 五档映射、点击/拖拽/键盘/Home/End、跟随 CLI 清除和重新启用默认/最近档。
- 390px 下 44px 热区、无横向溢出、端点/当前值/错误不重叠，切换无布局跳动；reduced-motion 下不依赖动画表达状态。
- 四类 create/edit 的权限开关、首次开启确认取消/接受、已有 true 不重复确认、持续警示与折叠提示。
- JSON `true/false/missing/non-boolean` 双向同步与阻断；详情摘要；内置恢复。
- API/Key/模型、secret 不回显、冲突/格式错误、测试失败后保存、导入导出和任务 Provider 选择回归。

### Full Verification

```bash
pnpm exec vitest run packages/shared/src/__tests__/provider-capabilities.test.ts packages/server/src/services/__tests__/provider-config.service.test.ts packages/server/src/routes/__tests__/providers.test.ts packages/server/src/executors/__tests__ packages/web/src/components/provider/__tests__/provider-draft.test.ts packages/web/src/components/provider/__tests__/SegmentedEffortSlider.test.tsx
pnpm --filter @agent-tower/shared build
pnpm --filter @agent-tower/server build
pnpm --filter web build
BASE_SHA=$(git merge-base HEAD at/team/5553651b/main/9526a527)
TARGET_SHA=$(git rev-parse HEAD)
git diff --check "$BASE_SHA".."$TARGET_SHA"
```

期望：全部命令退出码 0；targeted REVIEW 为 APPROVED；同 SHA targeted TEST 为 PASSED；workspace clean 且 merge readiness 无 blocker。

## Acceptance Mapping

| Spec AC | Coverage |
| --- | --- |
| 1-5 | Task 2 slider component tests + Task 3 desktop/mobile/accessibility E2E |
| 6-7 | Task 1 mapper tests + Task 2 draft tests + Task 3 advanced sync/TOML regression |
| 8-13 | Task 1 permission contract/validation/executor tests + Task 2 UI/detail tests + Task 3 four-Agent E2E |
| 14 | Task 1 normalization tests + Task 2 dirty/test draft behavior + Task 3 save/test scenarios |
| 15 | Task 1 route/security regression + Task 3 import/export/restore/task selection regression |

## Dependencies And Parallel Split

Task 1 and Task 2 touch a shared contract and the same Provider draft lifecycle。当前团队只有一名实现工程师，因此由一名 full-stack 实现工程师按 Task 1 -> Task 2 串行完成，避免能力类型尚未稳定时并行复制映射。Task 3 的 reviewer 与 E2E tester 可在实现产出 clean commit 后针对同一 SHA 并行，只读执行。

## Risks And Mitigations

- Pointer slider 容易出现触摸滚动/关闭误触：使用 pointer capture、固定几何和 44px hit area，移动 E2E 验证横向溢出。
- 非布尔历史值会从过去的隐式 truthy 变成阻塞：保留 raw JSON 可编辑入口，错误明确指出字段必须为 `true` 或 `false`。
- 内置 Provider 默认高风险开启：保持兼容但在展开、折叠和详情三处持续提示，不在打开表单时重复确认。
- 页面与 server mapper 漂移：字段路径和 ordered options 只由 shared capability 提供；TOML 写入只在 server。
- 组件测试环境若无法可靠模拟 pointer geometry，键盘/ARIA 由单测覆盖，拖拽和触摸以桌面/390px 浏览器 E2E 作为最终证据。

## Plan Self-Review

- Spec 覆盖：15 条验收均映射到 Task 1-3；非目标与不修改范围已明确。
- 文档完整性：所有任务均有具体文件、接口、依赖、验证命令与期望结果，无未决实现占位。
- 类型一致性：统一使用 `executionPermission` capability、`executionPermission` diagnostic field、`INVALID_TYPE` code 和 `provider.config` 唯一状态源。
- 任务粒度：单一实现工程师串行完成重叠写入；review/test 仅在 clean 固定 SHA 后并行。
- 技术取舍：记录了 shared 能力驱动、无重复权限状态、server-only TOML 写入、风险确认边界和 skill 不更新原因。
- Merge gate：只有同 SHA APPROVED + PASSED、workspace clean、merge readiness 无 blocker 后才允许请求合并。
