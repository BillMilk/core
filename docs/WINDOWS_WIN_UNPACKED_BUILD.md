# Windows `win-unpacked` 目录版制作说明

本文用于在 Windows x64 上把 Agent Tower 制作为 Electron 目录版。目标产物是：

```text
packages/desktop/release/win-unpacked/Agent Tower.exe
```

这不是安装包，也不是 portable 单文件。交付和运行时必须保留整个
`win-unpacked` 目录，不能只复制 `Agent Tower.exe`。

## 给后续 Codex 会话的规则

当用户要求 `win-unpacked`、目录版，或明确表示不要安装包/便携版时：

1. 使用本文的目录版流程。
2. 不要运行 `package:win`，因为它会生成 NSIS 安装包和 portable EXE。
3. 打包前编译当前工作区源码，不要直接复用旧的 `dist` 或旧的 `runtime`。
4. 不要清理、覆盖或提交用户无关的工作区修改。
5. 打包后必须运行 packaged smoke test，再把路径交给用户。

## 环境要求

- Windows x64。
- Node.js `>= 22.19.0`。
- pnpm `11.18.0`（仓库已通过 `packageManager` 固定版本）。
- 在仓库根目录执行命令，即包含根 `package.json` 的目录。
- 首次构建需要网络，以下载依赖、Electron 和 electron-builder 二进制文件。

检查版本：

```powershell
node --version
corepack pnpm --version
```

## 标准制作流程

打开 PowerShell，进入仓库根目录：

```powershell
Set-Location 'D:\project\multi-agent-research\core'
```

### 1. 安装或同步依赖

新环境、依赖发生变化，或者 `node_modules` 状态不确定时执行：

```powershell
$taskCorepackHome = Join-Path (Get-Location) '.corepack-cache'
$env:COREPACK_HOME = $taskCorepackHome
$env:CI = 'true'
corepack pnpm install
```

`CI=true` 可避免非交互会话因无法确认重建 `node_modules` 而中止。若依赖已确认完整且
锁文件没有变化，可以跳过本步骤。

### 2. 设置 Windows 无签名构建环境

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

镜像变量用于提高国内网络环境下的下载成功率；网络可以稳定访问官方源时可不设置两个
mirror 变量。`CSC_IDENTITY_AUTO_DISCOVERY=false` 表示制作本地未签名测试版本。

### 3. 只制作 Windows 目录版

```powershell
corepack pnpm desktop:package:win:dir
```

该专用命令内部也使用 Corepack，不要求系统已经全局安装 `pnpm.cmd`。在
electron-builder 收集依赖时，命令会创建临时 Corepack shim，并在构建结束后自动删除。

这个命令依次完成：

1. 编译 `shared`、`server`、`web` 和 `desktop`。
2. 重新生成 `packages/desktop/runtime`，包含 Node、服务端、Web 静态资源和生产依赖。
3. 调用 `electron-builder --dir --win --x64 --publish never`。
4. 输出 `packages/desktop/release/win-unpacked/`。

等价的底层命令是：

```powershell
corepack pnpm --filter @agent-tower/desktop package:prepare
Set-Location 'packages\desktop'
node .\node_modules\electron-builder\out\cli\cli.js --dir --win --x64 --publish never
Set-Location '..\..'
```

底层命令仅用于定位脚本或 PATH 问题；正常情况下使用一键命令。

## 验证产物

先确认文件存在：

```powershell
$exePath = 'packages\desktop\release\win-unpacked\Agent Tower.exe'
Get-Item -LiteralPath $exePath | Select-Object FullName, Length, LastWriteTime
```

然后运行完整的打包应用冒烟测试：

```powershell
$env:AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS = '180000'
$env:AGENT_TOWER_DESKTOP_SMOKE_TIMEOUT_MS = '240000'
$env:AGENT_TOWER_DESKTOP_VERIFY_AGENT_CLI = 'codex'
corepack pnpm desktop:package:smoke
```

只有出现以下最终结果才算验证通过：

```text
[desktop:smoke] Packaged smoke passed
```

冒烟测试会实际启动 `win-unpacked/Agent Tower.exe`，并验证：

- 后端 `/api/health`。
- Socket.IO `/events`。
- 独立终端的创建和删除。
- Web UI 加载。
- MCP 配置。
- 设置 `AGENT_TOWER_DESKTOP_VERIFY_AGENT_CLI=codex` 时，通过应用自己的 API 检查 Codex CLI。

可选：生成最终 EXE 的 SHA-256：

```powershell
Get-FileHash -LiteralPath $exePath -Algorithm SHA256
```

## Codex CLI 检测修复检查

Windows 上全局安装的 Codex 通常通过 `codex.cmd` 启动。当前实现对 `.cmd`/`.bat`
调用使用 `windowsVerbatimArguments`，避免 `cmd.exe` 对带空格路径和引号进行二次转义。

如果本次构建涉及 Codex CLI 检测，请在打包后确认修复已进入运行时：

```powershell
Select-String `
  -LiteralPath 'packages\desktop\runtime\server\dist\services\agent-cli\command-runner.js' `
  -Pattern 'windowsVerbatimArguments'
```

该命令应至少返回一处匹配。若没有匹配，不要交付旧产物，应重新执行完整目录版构建。

## Git 初始化检查

桌面程序会在启动后重新读取 Windows 当前的系统和用户注册表 `Path`，再把合并后的环境传给后端。
这样即使资源管理器仍保留安装 Git 之前的旧环境，从桌面双击启动后创建空项目也可以找到 Git；不需要用户从
PowerShell 启动程序，也不要求 Git 安装在默认盘符。

涉及 Git 或 Windows PATH 修复时，打包后的冒烟测试应额外启用以下两项：

```powershell
$env:AGENT_TOWER_DESKTOP_VERIFY_GIT_INIT = '1'
$env:AGENT_TOWER_DESKTOP_TEST_STALE_PATH = '1'
corepack pnpm desktop:package:smoke
```

测试会把打包程序的初始 `PATH` 限制为 Windows 系统目录，模拟 GUI 进程拿到旧 PATH，然后通过应用 API
创建空项目。只有输出 `Git init verification passed with packaged backend` 才表示注册表 PATH 恢复和
`git init` 都已在 `win-unpacked` 中实际通过。

## 常见问题

### `pnpm install` 提示没有 TTY 并中止

在同一个 PowerShell 会话中设置 CI 后重试：

```powershell
$env:CI = 'true'
corepack pnpm install
```

### Electron 下载失败或 `electron.exe` 不存在

先设置镜像，再重跑安装：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
corepack pnpm install
node .\packages\desktop\node_modules\electron\install.js
```

### 用户说 portable 打不开

不要继续生成 portable。让用户运行：

```text
packages/desktop/release/win-unpacked/Agent Tower.exe
```

并提醒用户：`resources`、DLL、`.pak` 等同目录文件都是运行依赖，必须整体复制
`win-unpacked` 文件夹。

### `release` 根目录里仍有旧安装包或 portable 文件

目录版命令只以 `release/win-unpacked/` 为交付目标。旧文件不会改变本次目录版结果，
也不要把它们误当作新产物交付。除非用户明确要求，否则不要擅自删除旧产物。

## 最终交付清单

- `packages/desktop/release/win-unpacked/Agent Tower.exe` 的时间是本次构建时间。
- `runtime/server` 和 `runtime/web` 来自当前源码。
- Codex CLI 检测修复检查通过（适用时）。
- `desktop:package:smoke` 输出 `Packaged smoke passed`。
- 告知用户复制和保留整个 `win-unpacked` 目录。
- 不把 NSIS 或 portable 文件作为本次交付物。
