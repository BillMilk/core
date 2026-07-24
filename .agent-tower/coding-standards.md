# Provider 配置编码规范

- shared 类型是 server/web 的唯一契约来源；不要在页面和路由重复声明能力枚举。
- 所有 Provider 输入在 Fastify 路由使用 Zod 校验，映射与无损更新逻辑放在 server service/纯函数模块，避免组件内字符串替换。
- secret 字段采用写入式三态，任何 GET、错误、日志、测试响应不得包含 secret 原值。
- JSON/TOML 使用解析器校验；未知字段和注释必须通过原文保留策略传递。
- React 表单以本地草稿为准，测试请求读取当前草稿，不触发持久化；测试失败不得阻止保存，格式错误才阻止保存。
- 测试连接和 executor 必须复用 server 的 effective Provider connection resolver；禁止用“CLI 已安装/命令可构造”冒充 API 地址或鉴权已验证。网络探测使用超时、最小无用户内容请求和结构化错误分类，测试只允许把合成 secret 留在内存断言中，不写日志、快照或响应。
- Codex 简化连接遵循 active model provider：内置 OpenAI 使用 `openai_base_url`，真正的自定义 provider 使用 `model_provider/model_providers.<id>.base_url/env_key`；Codex 保留的 native/local provider 不得因缺少自定义表被误判或注入 OpenAI/custom override。不得新增 `OPENAI_BASE_URL` 作为运行时真相。兼容旧字段只能按“读取旧值、连接字段被编辑时无损迁移”的方式实现。
- executor spawn 若使用 Provider 显式 secret，必须屏蔽或等值覆盖父进程中可能抢占优先级的旧认证变量；不要依赖父进程环境的偶然顺序。运行中的子进程不热更新，重新 spawn 时读取最新 Provider。
- Agent 专属高风险权限的字段路径由 shared capability 声明；简化 Provider 表单隐藏权限控件，Advanced JSON 与后端仍读写同一个 `config` 草稿。非布尔历史值不得按 truthy 规则解释，必须返回字段级错误并阻止测试/保存。Codex 只有严格 boolean `true` 才允许 full bypass；缺失/false 使用 `-c approval_policy=never -c sandbox_mode=workspace-write`。
- Codex `disableResponsesWebsocket` 由 shared capability 声明并只保存在 `provider.config`；false/缺失不得增加 argv。true 的 transport `-c` 必须位于 raw settings 与 effective connection 之后：custom active provider 最终强制 `supports_websockets=false`，内置/legacy OpenAI 使用固定 `agent-tower-openai-http` alias 保持 base URL、Responses wire API 与 OpenAI auth 语义。禁止写入已 removed 的 `features.responses_websockets*`，禁止用无效的 `model_providers.openai.supports_websockets=false`，native/local 不制造 alias。
- Codex transport alias 和其他 Provider argv 都不得包含 key/token；认证只通过既有 child env 投影。new/retry/follow-up/resume fallback 每次新 executor 使用最新 Provider，单次 resume 与 fallback 使用同一快照，运行中的 child 不热更新。
- 新增行为必须覆盖 shared/server 单元测试、REST 集成测试和 web 类型/构建；交互变化需补桌面与移动端 E2E。
