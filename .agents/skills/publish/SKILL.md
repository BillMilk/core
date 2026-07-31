---
name: publish
description: "发布 agent-tower 包到 npm registry。当用户要求发布、publish、更新 npm 包、发新版本时使用此 skill。"
---

# Publish to npm

## 流程

### 1. 版本号处理

- 读取 `packages/server/package.json` 中的当前版本号
- 询问用户选择版本升级类型：
  - **patch** (x.y.Z): bug 修复、小改动（默认）
  - **minor** (x.Y.0): 新功能
  - **major** (X.0.0): 破坏性变更
  - 或用户直接指定版本号
- 更新 `packages/server/package.json` 中的 `version` 字段
- 正式版从 prerelease 转正时去掉后缀，例如 `0.5.4-beta.10` → `0.5.4`
- 在构建前提交版本变更并保持工作区干净，保证 npm `gitHead` 可追溯

### 2. 构建

```bash
node scripts/build-publish.mjs
```

此脚本会：清理旧产物 → 构建 shared → server → web → 组装到 `packages/server/publish/`

Prisma 安装必须只有一个 Client 生成者。发布包捆绑 `@prisma/client`，但删除其中的 `generate`、`postinstall` 和可选 `prisma` peer；`prisma` CLI 作为与 Client 精确同版本的普通 dependency 安装，由 Agent Tower 根包的 postinstall 在目标机器生成本机 Client 和 engine。发布包还捆绑 `@agent-tower/shared`、包含多平台 prebuilds 的 `@shitiandmw/node-pty`，以及不含原生二进制和 postinstall 的 cloudflared JS 包装层；cloudflared 二进制由 server 在首次 Tunnel 启动时按目标平台下载。

### 3. 打包检查与冒烟

```bash
cd packages/server/publish
npm pack --dry-run
cd ../../..
pnpm publish:smoke
```

- 确认 tarball 包含已净化的 `node_modules/@prisma/client`，但不含 `node_modules/prisma`、预生成的 `node_modules/.prisma` 或 `node_modules/cloudflared/bin`
- `pnpm publish:smoke` 必须从最终 tarball 做隔离全局安装，检查生成 Client 的语法、应用 Prisma 模块加载和 query engine
- 验证首次 Tunnel 启动能安装目标平台 cloudflared
- 正式版发布前至少验证 macOS、Windows、Linux 的安装和 CLI 启动

### 4. 发布

```bash
cd packages/server/publish && npm publish --tag latest
```

beta 版本使用 `npm publish --tag beta`，不得依赖 npm 默认 tag。

### 5. 验证

发布成功后使用 `npm view agent-tower dist-tags version --json` 验证版本与 dist-tag，并告知用户新版本号。

## 注意事项

- 版本号冲突会返回 403，需升级版本号重试
- 禁止从含未提交源码改动的工作区发布
- 确保 npm 已登录（`npm whoami`）
