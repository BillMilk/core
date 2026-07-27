---
title: Tunnel
description: 从外网访问本机 Agent Tower。
---

# Tunnel

Tunnel 用来把本地 Agent Tower 临时暴露到外网，方便手机或其他设备访问。

首次启动 Tunnel 时，Agent Tower 会按当前操作系统和 CPU 架构下载对应的 `cloudflared` 二进制。此步骤需要能够访问 GitHub Releases；后续启动会复用已经下载的文件。

## 接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/tunnel/status` | 查看当前 tunnel 状态 |
| `GET /api/tunnel/health` | tunnel 健康检查 |
| `POST /api/tunnel/bootstrap` | 前端启动时用 token 换取 session cookie |
| `POST /api/tunnel/start` | 启动 tunnel |
| `POST /api/tunnel/regenerate` | 重新生成访问 token 并启动 tunnel |
| `POST /api/tunnel/stop` | 停止 tunnel |

## 状态返回

本地请求会返回：

- tunnel 状态
- token
- shareableUrl

## 使用建议

- 只在需要远程查看时开启
- 关闭后再继续本地开发
- 不要把公开链接长期暴露给不信任的人
