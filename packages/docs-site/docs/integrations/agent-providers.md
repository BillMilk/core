---
title: Agent Provider
description: 为不同任务选择不同 agent 配置。
---

# Agent Provider

Provider 是 agent 的具体配置实例。它决定某个任务使用哪种 Agent 身份、哪种 Runtime、哪些环境变量和运行参数。

## 支持的 agent

当前支持：

- Claude Code（CLI、ACP）
- Gemini CLI（CLI、ACP）
- Cursor Agent（CLI、ACP）
- Codex（CLI、ACP）
- Qwen Code（ACP）
- Kiro CLI（ACP）
- OpenCode（ACP）
- Pi Coding Agent（ACP）
- Grok Build（ACP）
- Minion Code（ACP）

## Runtime

Provider 的 `runtimeType` 有两种选择：

| Runtime | 行为 | 当前 Agent 支持 |
| --- | --- | --- |
| `CLI` | 启动本机 CLI，通过 PTY、Parser 和 MsgStore 处理输出 | Claude Code、Gemini CLI、Cursor Agent、Codex |
| `ACP` | 通过 Agent Client Protocol 双向通信，支持能力协商、session 恢复和权限请求 | Claude Code、Gemini CLI、Cursor Agent、Codex、Qwen Code、Kiro CLI、OpenCode、Pi Coding Agent、Grok Build、Minion Code |

旧 Provider 和旧备份没有 `runtimeType` 时按 `CLI` 读取，因此升级不会改变已有配置。同一 Agent 的 CLI 与 ACP 是两个独立默认项；设置其中一个不会取消另一个的默认状态。

Provider 页面不会使用 CLI/ACP Tab。创建配置时，Agent 下拉会直接显示 `Claude Code`、`Claude Code (ACP)`、`Codex`、`Codex (ACP)` 和 `Qwen Code (ACP)` 等可用组合。系统内部仍分别保存 `AgentType + RuntimeType`，Runtime 不会变成独立的顶层配置视图。

ACP Provider 可以选择权限策略：

- `ASK`：Agent 请求工具权限时，在 Session 面板中等待用户选择 Agent 提供的选项。
- `AUTO_APPROVE`：自动选择 Agent 提供的允许选项；如果没有允许选项则取消该请求。

ACP Provider 沿用对应 Agent 的认证与模型配置，而不是使用一套 ACP 专属密钥：

| Agent | 连接配置 |
| --- | --- |
| Codex (ACP) | 内置 Codex Runtime；配置 `OPENAI_API_KEY`、API 地址、模型、推理强度和 Codex TOML；第三方 OpenAI-compatible 网关会投影为独立的 Codex model provider |
| Claude Code (ACP) | 内置 Claude Runtime；配置 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、模型、effort 和 Claude settings JSON |
| Qwen Code (ACP) | `OPENAI_API_KEY`、`OPENAI_BASE_URL`、模型和权限策略 |
| Gemini CLI (ACP) | `GEMINI_API_KEY`、模型和权限策略；根据已安装版本选择 `--acp` 或 `--experimental-acp` |
| Cursor Agent (ACP) | Cursor 登录状态或高级环境变量、模型和权限策略 |
| Kiro CLI (ACP) | Kiro/AWS 登录环境、模型、effort 和权限策略 |
| OpenCode (ACP) | OpenCode 登录状态，或 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和模型 |
| Pi Coding Agent (ACP) | 内置 Pi Runtime；配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、模型和思考强度，或 Pi 支持的环境变量认证 |
| Grok Build (ACP) | `OPENAI_API_KEY` 会映射为 `XAI_API_KEY`，并支持 API 地址、模型和权限策略 |
| Minion Code (ACP) | `OPENAI_API_KEY`、`OPENAI_BASE_URL`、模型和权限策略 |

启动时，通用 ACP Driver 会按 Agent Definition 将 Provider 配置投影为对应 adapter 或原生 ACP CLI 的启动参数、环境变量和 Session 配置。

Claude Code 与 Codex 的 ACP adapter 及其兼容 Runtime 随 Agent Tower 发布，默认不要求全局安装 `claude` 或 `codex`；可以分别通过 `CLAUDE_PATH`/`CLAUDE_CODE_EXECUTABLE` 和 `CODEX_PATH` 显式覆盖。Pi Coding Agent 的 npm Runtime 同样随 Agent Tower 发布，可以通过 `PI_CODING_AGENT_PATH` 或 `PI_PATH` 覆盖。

每个 Pi 会话使用隔离的 `PI_CODING_AGENT_DIR`；Agent Tower 会在其中生成 `settings.json`、`mcp.json` 和需要时的 `models.json`，通过 Pi settings 加载随 Agent Tower 发布的 `pi-mcp-adapter`。Minion Code 使用会话级 `PYTHONPATH` bridge，把 ACP Session 下发的 MCP server 转成 Minion 工具。两个方案都不会改写用户或项目的 settings/MCP 配置；受管目录权限为 `0700`、文件权限为 `0600`，并在进程结束后清理。`pi-acp` 仍会按上游约定在 `~/.pi/pi-acp` 维护 ACP session 映射，供 session 恢复使用。

## 为什么要按任务选择 Provider

不同任务适合不同成本和能力组合。

例如：

- 简单的文本调整可以用更便宜的配置
- 复杂重构可以用更强的模型
- 需要特定 CLI 行为时可以切到对应 provider

## Provider 包含什么

一个 provider 通常包含：

- 名称
- agentType
- runtimeType
- 环境变量
- Agent 运行配置
- settings
- 是否默认

创建 Session 后，`agentType` 和 `runtimeType` 会固化到 Session。后续消息只能切换到相同 Agent 和相同 Runtime 的 Provider；CLI 与 ACP 之间切换需要创建新 Session。

## 常见操作

Provider 页面支持：

- 列出所有 provider
- 创建 provider
- 更新 provider
- 删除 provider
- 导出备份
- 从备份导入
- 重新加载配置

Agent 环境页面支持检测和引导安装部分本机 Agent CLI。安装前会展示官方来源、下载摘要、风险提示和校验信息。Claude Code 与 Codex 的安装入口面向 CLI Runtime；它们的 ACP Runtime 已内置。Qwen Code、Kiro CLI、OpenCode、Grok Build 和 Minion Code 当前不在安装清单中，需要用户自行安装对应 CLI；Pi Coding Agent 已内置，Provider 可用性会直接检测随 Agent Tower 发布的 Runtime。

当前环境引导支持：

| CLI | 支持平台 | 安装方式 |
| --- | --- | --- |
| Codex | macOS、Linux | 下载官方安装脚本并执行 |
| Claude Code | macOS、Linux | 下载官方安装脚本并执行 |
| Cursor CLI Agent | macOS、Linux | 下载官方安装脚本并执行 |
| Gemini CLI | macOS、Linux、Windows | 仅检测已安装状态 |

安装相关接口只允许本机访问，避免通过远程 tunnel 触发本机安装操作。

## 备份和导入

备份接口导出的主要是用户层配置，不是仓库代码。

你可以先预览导入结果，再真正导入，避免覆盖不符合预期的配置。

## 使用建议

- 为每类 agent 维护一个稳定默认配置
- 不要把太多临时实验配置直接当主配置
- 当 provider 失效时，先 reload，再检查本机 CLI 是否可用
