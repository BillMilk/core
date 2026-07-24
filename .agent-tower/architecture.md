# Provider 简化配置架构基线

## 边界

Provider 草稿只存在 Agent Tower 的 `providers.json` 数据边界内。运行时由 executor factory 将 `env`、`config` 和 `settings` 注入子进程；绝不读写 `~/.codex`、`~/.claude` 等 CLI 全局配置。

## 分层与数据流

```text
web ProviderSettings
  -> draft mapper / validator (未保存草稿，脱敏 key)
  -> REST /api/providers + /api/providers/test
  -> server provider config service
  -> lossless env/config/settings mapper + effective connection resolver
  -> providers.json persistence
  -> executor factory (env/config/settings runtime injection)
```

共享包定义 `Provider`、能力矩阵和脱敏/写入式字段契约；server 负责解析、合并、持久化、测试与响应脱敏；web 负责简化/高级双向编辑、冲突状态和未保存草稿测试。

`/providers/test` 与 executor 必须消费同一个 normalized Provider 草稿和同一套 effective connection resolver。对于支持 API 探测的连接，测试不是 CLI 安装检查的别名：它必须对草稿解析出的目标地址发起有超时的最小请求，并按 validation/network/TLS/auth/model/rate-limit/server 分类返回脱敏结果。测试不持久化草稿，也不发送任务 Prompt 或项目内容。

Codex 连接以当前激活 model provider 为准：内置 OpenAI provider 使用 `settings.openai_base_url`，自定义 provider 使用 `settings.model_provider` 与 `settings.model_providers.<id>.base_url/env_key`；Codex 保留的 native/local provider（如 `oss`、`ollama`、`lmstudio`、`amazon-bedrock`）保留 CLI 原生连接与认证行为，不要求自定义 provider 表。`env.OPENAI_BASE_URL` 只作为旧数据兼容读取源，不作为新写入或运行时真相；用户修改连接字段后才做无损迁移。API key 仍以 provider env 的写入式 secret 保存，executor 在每次 spawn 时投影为 Codex 当前 provider 真正消费的变量，并屏蔽会覆盖显式 Provider 凭证的父进程旧变量。

Provider 更新同步刷新内存缓存；新 session 和任何后续新 spawn 在启动时重新解析 Provider。已经运行的 CLI 子进程持有启动快照，不热更新环境或参数。

执行权限沿用同一边界：shared 能力矩阵声明各 Agent 的单一高风险布尔字段，值只存在 `provider.config`。web 简化表单隐藏权限控件，Advanced JSON 仍编辑同一份草稿；server 依据能力矩阵严格校验布尔类型，executor 继续消费既有 config 字段生成 CLI 参数，不得在 UI 或 server 复制第二份权限状态。Codex 缺失或非严格 boolean `true` 时使用 `-c approval_policy=never -c sandbox_mode=workspace-write`，只有严格 `true` 使用 `--dangerously-bypass-approvals-and-sandbox` 且不附加这两个默认覆盖。每个新 spawn 创建不可热更新的有效权限快照。

Codex Responses transport 选项沿用相同的单一状态边界：`provider.config.disableResponsesWebsocket` 只接受 boolean，缺失或 false 不改变现有 argv。true 时 executor 在 raw settings 和 effective connection 之后追加最终 transport override：自定义 Provider 写入 active `model_providers.<id>.supports_websockets=false`；内置或 legacy OpenAI 切换到固定 `agent-tower-openai-http` runtime alias，并投影等价的 base URL、Responses wire API、OpenAI auth 语义和 `supports_websockets=false`。内置 `openai` 不可用同名配置覆盖；native/local Provider 已是非 WebSocket transport，不生成 alias 或 removed feature flags。Provider secret 仍只进入 child env。每次新 spawn 解析最新 Provider，resume 与其 fallback 共享同一 executor 快照，运行中的 child 不热更新。

## 密钥边界

读取响应只返回 key 是否已配置及 env key 名，不返回原值。编辑请求使用 `keep`、`replace`、`clear` 三态语义；未改变的 key 由 server 保留原值。日志、错误和测试结果必须经过统一脱敏。

## 无损更新

映射器只改能力矩阵声明的路径，未知 env、未知 config、TOML/JSON 注释和未映射文本片段保留原文。解析失败时保留历史原文并返回字段级错误，禁止静默重写。
