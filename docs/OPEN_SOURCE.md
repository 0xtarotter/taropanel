# 开源声明与第三方组件

## 项目许可证

TaroPanel 原创代码采用 [MIT License](../LICENSE)。使用、复制、修改及再分发时应保留许可证要求的版权和许可声明。软件按许可证原文以“按现状”方式提供，不附带许可证之外的保证。

本声明用于标明项目及依赖的许可证范围，具体权利和义务以相应许可证原文为准。第三方组件不因包含在本项目中而自动变更为本项目的许可证。

## 主要运行依赖

以下版本对应当前锁文件，更新后以 `package-lock.json` 和依赖包内许可证为准。

| 组件 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| `@xterm/xterm` | 6.0.0 | 浏览器终端 | MIT |
| `@xterm/addon-fit` | 0.11.0 | 终端尺寸适配 | MIT |
| `ssh2` | 1.17.0 | SSH 协议客户端 | MIT（包内 LICENSE） |
| `ws` | 8.21.3 | WebSocket 服务端 | MIT |
| `asn1` | 0.2.6 | SSH 依赖 | MIT |
| `bcrypt-pbkdf` | 1.0.2 | SSH 密钥解析依赖 | BSD-3-Clause，保留包内各部分声明 |
| `safer-buffer` | 2.1.2 | Buffer 兼容依赖 | MIT |
| `tweetnacl` | 0.14.5 | 加密依赖 | Unlicense |

浏览器终端资源在构建时从锁定依赖复制，相关许可证同时复制到静态资源目录。Node 依赖按 npm 包保留各自 LICENSE。源码发布包不包含 `node_modules`，安装时下载依赖。

## 字体与开发工具

- 仓库内字体：Noto Sans SC，附带 [SIL Open Font License 1.1](../public/assets/OFL.txt)。保留字体自带版权和 Reserved Font Name 声明；本项目 MIT 许可不替代字体许可。
- Playwright / Playwright Core 1.63.0：开发和浏览器测试依赖，Apache-2.0。生产安装使用 `--omit=dev`，不安装测试浏览器。
- SSH 可选 CPU 原生扩展：默认安装使用 `--omit=optional --ignore-scripts`，不启用这些可选构建。自行改变安装策略时，应一并检查新增组件的许可证与构建要求。
- Linux、Node.js、OpenSSH、Docker、Compose、nftables 等系统软件由安装器按需调用或下载，各自保留上游许可证，不作为 TaroPanel 原创代码再许可。

## 发布内容与隐私

公开仓库只包含通用程序、静态资源、测试、示例和文档。发布流程排除配置、会话、SSH 私钥、环境文件、流量历史、Compose 生产文件、备份、日志和生产截图。

源码安装包使用统一数字所有者和固定时间戳，避免泄露打包主机用户名、用户组或文件时间信息。脱敏检查脚本为 [scripts/audit-release.cjs](../scripts/audit-release.cjs)。自动检查不能取代人工审核，提交前仍应确认内容不含真实业务数据。

仓库提交使用项目贡献者署名，不包含开发机器的本地账户邮箱。上游许可证中的作者与版权声明必须保留，不能为了脱敏删除第三方的合法声明。

## 商标与项目关系

Docker、OpenSSH、Node.js 等名称用于说明兼容组件。本项目是独立项目，不表示得到这些上游组织的官方背书。

## 贡献

提交代码前请阅读 [贡献指南](../CONTRIBUTING.md)，确认有权提交，并保留必要的来源与许可证说明。不要提交从生产环境直接复制的配置、日志或截图。漏洞报告方式见 [SECURITY.md](../SECURITY.md)。
