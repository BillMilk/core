# Provider 执行权限位置与警示层级返修 Implementation Plan

- 日期：2026-07-15
- Spec：`.agent-tower/spec/2026-07-15-provider-permission-placement-polish-spec.md`
- Spec 状态：User Confirmed = 是，Verdict = `READY_FOR_TECH_PLAN`
- 覆盖关系：本 spec 覆盖旧 follow-up spec/prototype 中“高级配置首部”“折叠红色状态”“大面积红色权限区”的结论
- 参考 Prototype：`.agent-tower/prototypes/2026-07-15-provider-effort-permission-followup-prototype.md`，仅继续参考滑杆、确认弹窗和 JSON 错误，不参考已过时的权限位置/颜色
- 架构基线：`.agent-tower/architecture.md`
- 编码规范：`.agent-tower/coding-standards.md`

## Goal

将四类 Agent 的执行权限结构化入口从高级配置移动到基本配置底部，并把正常开启态从大面积 destructive 红色收敛为中性背景配合轻量 warning/amber 多通道提示；保持权限能力、确认、JSON 双向同步、校验、持久化和 executor 行为完全不变。

## Architecture

本轮只调整同一 React 表单草稿的渲染位置与视觉 token，不改变 shared/server/executor 边界。

```text
shared capability + provider.config（唯一状态源，不变）
                    |
                    v
ProviderFormData.config
  |-- 基本配置底部：结构化 Switch + 中性/warning 状态（移动后）
  `-- 高级配置：运行 JSON/env/settings 专家入口（保留）
                    |
                    v
现有 save/test/server/executor 链路（不变）
```

关键不变量：

- 权限 Switch 与运行 JSON 继续读写同一 `ProviderFormData.config`，不新增镜像 state。
- `capability.executionPermission.path` 继续决定字段；页面不复制四类字段映射。
- 关闭/缺失、开启、非布尔错误的语义与门禁不变；仅正常状态视觉分层变化。
- 首次结构化开启确认保留 destructive 风险表达；正常开启态用 warning；真实配置错误继续 destructive。

## Prototype

旧 prototype 的滑杆、确认弹窗、JSON 错误仍可参考；Advanced 权限卡片、折叠红色状态和大面积红色摘要已经被新 spec 覆盖，不得实现。新 spec 已完整定义位置、桌面/390px 和状态层级，本轮不补新 prototype。

## Tech Stack / Constraints

- React 19、TypeScript 5、TailwindCSS v4、现有 `Switch`、`ConfirmDialog`、lucide warning icon 与 neutral/warning/destructive tokens。
- 用户文案通过 `useI18n`；不引入新依赖或新颜色系统。
- 桌面与 390px 保持稳定布局，Switch 热区至少 44px；不得挤压思考强度滑杆。
- 不修改 shared capability、server、API、service、executor、Provider persistence 或 CLI 全局文件。

## Global Constraints

- 范围仅为 Provider 编辑弹窗权限区域位置/样式、高级折叠表现、详情摘要层级和对应 web tests/E2E。
- 高级配置只保留 JSON/env/TOML 专家入口，不重复权限开关、不因权限开启自动展开、不显示折叠高风险状态。
- 关闭态完全中性；开启态不得使用大面积 red/destructive 背景，必须同时有 warning 图标、已开启文字和 Switch 状态。
- 确认弹窗与非布尔错误仍可使用 destructive；不能把真实错误降级为 warning。
- 不改变思考强度、API/Key/模型、secret、冲突、导入导出、内置恢复、测试配置和任务选择行为。

## Files And Responsibilities

| File | Responsibility |
| --- | --- |
| `packages/web/src/pages/ProviderSettingsPage.tsx` | 将权限子区移动至基本配置底部，移除高级折叠状态/自动展开，调整 normal/warning/destructive 层级与详情摘要。 |
| `packages/web/src/components/provider/ProviderExecutionPermissionSection.tsx` | 封装基本配置中的单一权限展示区，接收既有状态/切换回调并表达 neutral/warning/destructive 层级。 |
| `packages/web/src/components/provider/__tests__/ProviderExecutionPermissionSection.test.tsx` | 覆盖关闭/开启/错误样式、多通道状态、44px Switch 热区和切换回调。 |
| `packages/web/src/lib/i18n/messages.ts` | 仅在现有文案无法复用时补状态文案；不改四类权限名称和风险含义。 |
| `packages/web/src/components/provider/__tests__/provider-draft.test.ts` | 保留/补充 JSON 双向、非布尔和未知 config 回归，若现有覆盖足够则不修改。 |

不得修改 `packages/shared/`、`packages/server/`、executor、Prisma 或无关设置页。页面中的状态源、确认流程和草稿更新仍留在 `ProviderSettingsPage.tsx`，展示组件不得持有第二份权限状态。

## Technical Decisions

- 复用同一权限 JSX 子区并移动渲染点，而不是复制一份基本区入口：避免高级区残留第二份状态源或事件处理。
- 高级折叠的 `defaultOpen` 只由配置/格式/冲突错误决定，不再受权限开启影响；标题 trailing status 删除。
- 视觉使用标准 border + warning foreground/轻提示线，不新建顶层卡片：满足用户“不要那么红”，同时保留风险识别。
- 详情摘要与编辑态共享同一 normal/warning/destructive 语义，但不抽跨页面组件，除非现有代码已具备可复用边界。
- 本轮不更新 `.agent-tower/architecture.md`、`.agent-tower/coding-standards.md` 或 `agent-tower-dev` skill：模块职责、状态源、跨端契约和稳定编码规则均未改变。

## Task 1 - Permission Placement And Visual Polish

### Files

- 修改 `packages/web/src/pages/ProviderSettingsPage.tsx`
- 创建 `packages/web/src/components/provider/ProviderExecutionPermissionSection.tsx`
- 创建 `packages/web/src/components/provider/__tests__/ProviderExecutionPermissionSection.test.tsx`
- 按需修改 `packages/web/src/lib/i18n/messages.ts`
- 按需修改 `packages/web/src/components/provider/__tests__/provider-draft.test.ts`

### Interfaces

- 继续使用 `getExecutionPermissionState(formData.config, capability)` 与 `updateExecutionPermission(...)`，不改变签名。
- 权限区在基本配置容器内、思考强度或模型后渲染一次；高级配置不再包含该 JSX。
- `permissionState.enabled`：中性背景 + warning icon/状态/风险文案/轻边界；关闭：中性无警告；`permissionState.error`：destructive error。
- `ProviderExecutionPermissionSection` 通过 props 接收 label、enabled、error、risk copy、onToggle，不自行读取或缓存 config。
- ConfirmDialog 的 pending toggle、取消/确认与 dirty/test invalidation 逻辑不变。

### Verification

```bash
pnpm exec vitest run packages/web/src/components/provider/__tests__/provider-draft.test.ts packages/web/src/components/provider/__tests__/SegmentedEffortSlider.test.tsx packages/web/src/components/provider/__tests__/ProviderExecutionPermissionSection.test.tsx
pnpm --filter web build
git diff --check
```

期望：focused tests 与 web build 退出码 0；展示组件关闭/开启/错误视觉、多通道状态和 Switch 热区有断言；四类 Agent 只在基本配置出现一次权限入口、确认流程与高级区移除由浏览器 E2E 覆盖。

## Task 2 - Targeted Review And Browser E2E

### Review Scope

- 只读审查 Task 1 固定业务提交，不修改业务代码。
- 验证 diff 未触及 shared/server/executor，权限 state 没有复制，旧高级区状态完全移除。
- 检查 neutral/warning/destructive 语义、可访问名称、Switch 热区和 existing confirmation gate。

### Browser Scenarios

- 四类 Agent 编辑表单无需展开高级配置即可操作权限；Claude/Codex 位于滑杆后，Gemini/Cursor 位于模型后。
- 关闭态无 warning/destructive 容器、图标或风险徽标；开启态只有小 warning icon、已开启文字、风险文案和轻边界，中性背景无大面积红色。
- 高级区无重复入口、无折叠红色状态、权限开启不触发自动展开；JSON 修改仍反向更新基本区 Switch。
- 首次开启取消/确认、已有开启不重复确认、关闭无需确认；非布尔错误 destructive 且阻止 test/save。
- 详情摘要关闭中性、开启 warning、错误 destructive。
- 桌面 1440x900 与移动 390x844：不重叠、截断、横向溢出，44px 热区，不挤压滑杆，底部操作可见。
- API/Key/模型、思考强度、测试配置、导入导出、内置恢复和任务 Provider 选择做最小回归。

### Verification

```bash
pnpm exec vitest run packages/web/src/components/provider/__tests__/provider-draft.test.ts packages/web/src/components/provider/__tests__/SegmentedEffortSlider.test.tsx packages/web/src/components/provider/__tests__/ProviderExecutionPermissionSection.test.tsx
pnpm --filter web build
BASE_SHA=18549f25c4258f84dfd6cae069ea5d28f5ffc0cf
TARGET_SHA=$(git rev-parse HEAD)
git diff --check "$BASE_SHA".."$TARGET_SHA"
```

期望：targeted REVIEW=APPROVED；同 SHA targeted TEST=PASSED；source workspace clean、verdict matchesHead、merge readiness 无 blocker。

## Acceptance Mapping

| Spec AC | Coverage |
| --- | --- |
| 1-3 | Task 1 单一权限展示组件 + Task 2 four-Agent 位置/高级区 E2E |
| 4-6 | Task 1 visual-state assertions + Task 2 desktop/mobile visual inspection |
| 7-10 | Existing permission helpers + Task 1 error presentation tests + Task 2 confirmation/JSON E2E |
| 11 | Task 1 页面详情视觉调整 + Task 2 detail E2E |
| 12-13 | Task 2 1440px/390px layout, overflow, touch target and slider adjacency checks |
| 14 | Review diff boundary + existing executor regression evidence from unchanged final baseline |
| 15 | Task 2 minimal Provider workflow regression |

## Dependencies And Parallel Split

Task 1 is a single React form/state flow and must be handled by one implementation engineer to avoid conflicting edits in `ProviderSettingsPage.tsx`. After a clean business commit, dedicated reviewer and E2E tester can run Task 2 in parallel against the exact same SHA.

## Risks And Mitigations

- Moving a high-risk control into the basic section increases accidental activation: keep first-enable confirmation and 44px Switch target without enlarging the whole row into a toggle target.
- Reducing red can hide risk: require icon + “已开启” text + Switch and warning risk copy, not color alone.
- UI movement can accidentally leave duplicate handlers/markup: review DOM count and E2E advanced collapse explicitly.
- Existing built-ins are enabled by default, so warning content will be common: use neutral background and local warning accents to avoid dominating the form.
- Page tests may be sparse: prefer focused DOM assertions plus browser E2E; do not introduce a broad testing refactor.

## Plan Self-Review

- Spec coverage：15 条验收均映射到 Task 1-2；新 spec 覆盖旧 spec/prototype 的冲突点已明确。
- Scope：只允许 web UI/测试写入，明确禁止 shared/server/executor 与数据语义变化。
- Completeness：任务包含具体文件、接口、不变量、验证与期望结果，无未决产品问题。
- Interface consistency：沿用 `capability.executionPermission`、`getExecutionPermissionState`、`updateExecutionPermission` 与 `provider.config` 唯一状态源。
- Task granularity：单实现成员写同一页面；固定 SHA 后 reviewer/tester 并行，不存在并行写冲突。
- Architecture：确认本轮不改变架构/规范/skill，理由已记录。
- Merge gate：仅同 SHA APPROVED + PASSED、workspace clean、无 blocker 时合并。
