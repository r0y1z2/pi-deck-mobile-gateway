[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

# Pi Deck Mobile Gateway

Pi Deck Mobile Gateway 是一个私有、移动端优先的 Web 网关，用于在手机上查看和管理
Windows PC 上运行的 PiDeck 任务。手机只作为远程控制器和状态显示界面，所有 Pi 任务
仍在 PC 上执行。

网关仅监听 `127.0.0.1`，设计用途是通过 Tailscale Serve 发布给同一 Tailscale 网络
（tailnet）中的设备。它不需要公网 IP、路由器配置或公网服务器。在受限网络中无法
建立直连时，Tailscale 可以使用加密的 DERP 中继。

本仓库是采用 MIT 许可证的 Pi monorepo 的非官方下游快照。归属说明和收录范围请参阅
[UPSTREAM.md](UPSTREAM.md)。

## 功能

- 通过移动端 PWA 查看当前、已完成、失败、已停止及历史 PiDeck 任务
- 在手机上继续已有的 PiDeck 会话
- 仅允许在 PC 端明确配置的工作区白名单中创建任务
- 一次性配对码和按设备持久保存的身份认证
- 仅监听回环地址的网关，并提供 Host、Origin 和代理请求头防护
- 通过 Tailscale Serve 部署，不对公网开放
- 兼容处理 PiDeck 0.7.0 会话内重复发送提示词的问题

## PiDeck 0.7.0 兼容性

PiDeck 0.7.0 的 `/api/chat` 路由会将会话 ID 复用为请求 ID。其运行时协调器会对该键
去重，因此同一会话中的第二条提示词可能已被记录，却没有实际分发。本网关绕过了受
影响的路由：先打开会话流，再使用唯一请求 ID 提交每条提示词。对于上游已持久保存
助手回复、但未发送结束事件而转为静默的流，本网关也能正确处理。

相关兼容行为由 `packages/server/test/deck.test.ts` 中的回归测试覆盖。

## 环境要求

- Windows 10 或 Windows 11
- PiDeck 0.7.0，其 Web 服务可通过 `http://127.0.0.1:8765` 访问
- Node.js 22.19.0 或更高版本
- PC 和手机均安装 Tailscale，并登录同一个 tailnet
- 一个或多个本地工作区目录，供手机端创建的任务使用

不要为端口 `8765` 或 `31415` 添加入站防火墙规则。

## 一句话交给 AI 安装

将下面这句话完整交给 AI coding agent：

```text
请在这台 Windows 新电脑上从 https://github.com/r0y1z2/pi-deck-mobile-gateway 克隆项目，优先使用仓库现有的 scripts/pideck-mobile 脚本完成 PiDeck Mobile Gateway 的安装和启动、配置通过 Tailscale 从手机访问，完成后运行仓库提供的健康检查并告诉我手机应打开的访问地址；不得代替我登录 GitHub 或 Tailscale，不得输出或保存任何密钥，不得覆盖已有的 Pi/PiDeck 数据，遇到需要账号登录、管理员权限或发现数据冲突时必须暂停并请求我确认。
```

## 安装

在仓库根目录打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\pideck-mobile\install.ps1
```

安装脚本会运行 `npm ci --ignore-scripts` 和 `npm run build:offline`，根据仓库中提交的
锁文件和模型数据快照构建完整 monorepo。构建产物和依赖有意不提交到仓库。

## 启动网关

先启动 PiDeck 及其 Web 服务。然后传入所有允许手机端新建任务使用的工作区：

```powershell
.\scripts\pideck-mobile\start-gateway.ps1 -WorkspacePath 'C:\work\project-a'
```

可以传入多个工作区：

```powershell
.\scripts\pideck-mobile\start-gateway.ps1 `
  -WorkspacePath 'C:\work\project-a','D:\work\project-b'
```

脚本会显示本地 URL 和一个六位配对码。配对码有效期为十分钟，且只能使用一次。默认
情况下，运行日志和 PID 文件会写入仓库外部的
`%LOCALAPPDATA%\PiDeckMobileGateway`。

## 使用 Tailscale 私密发布

在 PC 上登录 Tailscale 后运行：

```powershell
.\scripts\pideck-mobile\configure-tailscale.ps1
.\scripts\pideck-mobile\health-check.ps1
```

在手机上打开 `tailscale serve status` 显示的 HTTPS `*.ts.net` 地址。Tailscale Serve
仅对同一 tailnet 开放。不要为本网关使用 Tailscale Funnel。

首次访问时，输入配对码和设备名称。在 Android Chrome 中，选择 **安装应用** 或
**添加到主屏幕**。网关正常重启不需要重新配对。清除站点数据、更换浏览器、撤销设备
授权或删除网关设备存储后，需要使用新的配对码。

## 运行与诊断

检查本地服务和 Serve 映射：

```powershell
.\scripts\pideck-mobile\health-check.ps1
```

如有需要，可在检查中包含 tailnet 地址：

```powershell
.\scripts\pideck-mobile\health-check.ps1 `
  -TailnetUrl 'https://your-device.your-tailnet.ts.net/api/health'
```

仅停止本次部署记录的网关进程：

```powershell
.\scripts\pideck-mobile\stop-gateway.ps1
```

停止网关不会移除持久保存的 Serve 配置。如需明确移除该配置：

```powershell
tailscale serve reset
```

常见故障：

- `502`：Serve 已配置，但本地网关未运行。
- `Cross-site request rejected`：直接打开 Tailscale HTTPS 地址，不要将其嵌入其他站点；
  必要时移除之前安装的旧 PWA。
- 配对码被拒绝：重启网关以生成新的配对码。
- 更新后仍显示旧界面：关闭所有标签页和已安装的 PWA，再重新打开，让 Service Worker
  完成更新。

## 开发

```powershell
npm ci --ignore-scripts
npm run check
npm run build:offline
Set-Location packages\server
node ..\..\node_modules\vitest\dist\cli.js --run test\deck.test.ts
```

`npm run build` 会从 `models.dev` 刷新供应商模型数据，因此需要外部网络连接。构建本
网关不需要运行此命令。

除非 Pi 会话的所有者明确授权，否则不得使用真实提示词测试本网关。

## 许可证

MIT。请参阅 [LICENSE](LICENSE) 和 [UPSTREAM.md](UPSTREAM.md)。
