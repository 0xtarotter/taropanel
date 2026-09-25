# 平台兼容性与验证范围

TaroPanel 管理的是主机的 systemd、Docker 和 nftables，因此“浏览器能打开”不等于“主机平台受支持”。本项目面向 **systemd Linux**。

## CPU 架构

| 架构 | 安装方式 | 验证状态 |
| --- | --- | --- |
| x86_64 / amd64 | 系统 Node.js ≥22，或下载官方 Node.js 24 LTS 二进制 | Debian x64 实机安装、真实 Web SSH；Ubuntu x64 CI |
| aarch64 / arm64 | 同上，按 ARM64 下载 | Ubuntu ARM64 原生 CI：Node.js 22/24、SSH 集成及浏览器测试 |
| armv7l / ARMv7 | 使用系统提供的 Node.js ≥22 和 npm | 有架构识别及 Compose 映射，尚无完整实机验证 |
| riscv64 | 同上 | 条件支持，未实机验证 |
| ppc64le / s390x | 同上 | 条件支持，未实机验证 |
| 其他 Linux 架构 | 系统必须提供完整依赖；Docker/Compose 可能需手动安装 | 不作已验证承诺 |

Web SSH 使用 JavaScript SSH/WebSocket 实现，安装时跳过可选的 CPU 原生扩展。源码包不按架构区分；Node.js、Docker、OpenSSH 等系统组件仍需与架构匹配。

## Linux 发行版

| 平台 | 包管理器 | 状态及限制 |
| --- | --- | --- |
| Debian 13 x64 | apt | 已实机验证安装、迁移、服务管理和本机 SSH |
| Ubuntu（GitHub 托管 runner） | apt | 自动安装烟雾测试已通过 |
| 其他 Debian / Ubuntu 版本 | apt | 已做安装适配，需满足内核和依赖要求 |
| Fedora | dnf | 已适配，未进行完整实机验证；Docker 依赖仓库可用性 |
| Rocky / AlmaLinux | dnf | 基础依赖适配；建议先安装 Docker，或用 `--no-docker` |
| Arch Linux | pacman | 已适配，安装会遵循完整系统升级策略；未实机验证 |
| Alpine、OpenWrt、OpenRC 系统 | — | 不支持自动部署 |
| Windows、macOS | — | 不支持作为管理主机；可以作为浏览器客户端 |
| 无 systemd 的普通容器 | — | 不支持直接安装 |

启用 SELinux、定制 PAM、禁用 BPF、只读根文件系统等环境可能需要额外适配。不要为安装面板直接关闭系统安全机制；应先查看对应日志和策略。

## 功能依赖

| 功能 | 必要条件 |
| --- | --- |
| 页面、认证 | Node.js ≥22、npm、可写状态目录 |
| 系统服务 | systemd、systemctl、journalctl |
| 容器 | Docker daemon 与 CLI；Podman 不作为等价替代承诺 |
| Compose | `docker compose` v2 插件；不以旧版 `docker-compose` v1 为目标 |
| 端口扫描 | `ss`；Docker 映射识别需要 Docker；进程归属读取需要权限 |
| 防火墙 | nftables 和相应内核支持；只管理本面板的规则表 |
| 服务流量 | systemd IPAccounting 与内核支持，既有连接计量可能不完整 |
| Web SSH | OpenSSH、可登录本机账户、专用回环监听和密钥 |

## 浏览器

自动化测试使用 Chromium，覆盖 320、390、490、768、800、1024、1280、1920 像素宽度，包含 Web SSH 页面。界面使用现代浏览器 API；建议使用当前维护的 Chrome、Edge、Firefox 或 Safari。Firefox/Safari 尚未纳入自动化矩阵，旧版浏览器和内嵌 WebView 不保证兼容。

## 如何核实最新状态

以 [GitHub Actions](https://github.com/0xtarotter/taropanel/actions) 的实际任务结果为准。首次公开版的 [测试运行](https://github.com/0xtarotter/taropanel/actions/runs/36118281051) 已通过 x64/ARM64 × Node.js 22/24 以及 Ubuntu 安装测试。

CI 的 ARM64 测试验证程序、SSH 协议和浏览器流程；不能据此声称所有 ARM 开发板、发行版、防火墙内核或 Docker 网络均已实机验证。
