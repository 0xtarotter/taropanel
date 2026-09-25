# TaroPanel

面向 systemd Linux 主机的轻量 Web 管理面板。支持中文界面、深浅色主题和移动端。

- 系统服务和 Docker 容器发现、状态、启停、日志。
- 创建独立容器；在 Docker 二级菜单管理 Compose 项目，创建、校验、备份、保存和部署。
- 防火墙默认放行状态说明，TCP/UDP 与 Docker 映射端口扫描、关联服务备注、筛选和批量放行。
- 网卡、容器和系统服务流量记录；总览展示最近 24 小时接收、发送和合计。
- Web SSH 交互式终端，支持窗口缩放、移动端快捷键、二次密码验证、会话退出和空闲断开。
- 安装时询问网页端口（默认 **80**），检查占用；升级备份，运行数据与程序分离。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/0xtarotter/taropanel/main/install.sh -o /tmp/taropanel-install.sh
sudo bash /tmp/taropanel-install.sh
```

安装程序会安装系统依赖、Node.js 和缺失的 Docker/Compose，询问网页端口及至少 12 位的面板密码，配置开机启动。已有面板密码和运行数据会保留。新安装的系统 SSH 不会因安装包自动对外开启；Web SSH 使用单独的本机监听实例。

也可以下载 Release 安装包，解压后运行 `sudo bash install.sh`。不想安装 Docker 时加 `--no-docker`；不启用 Web SSH 时加 `--no-ssh`。

```bash
sudo bash install.sh --port=8080 --ssh-user=root --ssh-port=22222
```

SSH 默认使用调用 sudo 的现有用户，直接以 root 安装时使用 root。`--ssh-user` 必须是已存在的可登录 Linux 账户。不会创建默认密码、开放 root 密码登录或改写 `/etc/ssh/sshd_config`。网页仍需使用面板密码登录；Web SSH 连接时再次输入面板密码。

已有自定义 Node.js 时可用 `PANEL_NODE=/绝对路径/node` 指定（同目录需有 npm）；也可用 `PANEL_HOST=127.0.0.1` 仅监听本机。

自动化首次安装可用 `--yes --password-stdin` 从标准输入读取密码；不要把密码写在命令行参数或提交到仓库。安装脚本默认从本仓库 `main` 获取代码，可用 `TAROPANEL_REF=v1.0.0` 固定版本。

## 系统和架构

| 环境 | 支持方式 |
| --- | --- |
| Linux x86_64 / amd64 | 原生 Node.js 或官方 Node.js 24 LTS 二进制；不依赖 Node 原生扩展 |
| Linux aarch64 / arm64 | 同上；提供 ARM64 CI |
| ARMv7、RISC-V、ppc64le、s390x 等 | 需要系统仓库提供 Node.js ≥22、npm、OpenSSH；Docker/Compose 是否可用取决于上游发行包 |
| Debian / Ubuntu | apt 自动安装依赖 |
| Fedora / Rocky / AlmaLinux | dnf；Docker 需发行版提供兼容包，或先自行安装 Docker 后运行 |
| Arch Linux | pacman；安装遵循完整系统升级策略 |

需要 **systemd**、Node.js ≥22、npm、`ss` 和 OpenSSH。容器及 Compose 功能需要 Docker/Compose v2；防火墙需要 nftables，缺少时可在页面安装。不支持 Windows、macOS、OpenWrt、Alpine/OpenRC，或没有 systemd 的普通容器。跨架构不代表所有发行版/内核均已实机验证，CI 状态与实际测试记录应分别看待。

## SSH 和访问安全

面板具有主机管理权限，以 root 服务运行，只适合可信管理员。公网使用前请配置 HTTPS 和访问控制。默认 HTTP 80 为安装兼容选项，不会自动签发证书。反向代理必须传递原始 `Host` 并支持 WebSocket Upgrade，示例在 [deploy/nginx.conf.example](deploy/nginx.conf.example)。使用 HTTPS 时可在 `/etc/taropanel.env` 加入 `PANEL_SECURE_COOKIE=1` 后重启。

Web SSH 使用独立的 `taropanel-sshd.service`，仅监听 `127.0.0.1:22222`，使用专用密钥和固定主机公钥校验。禁止密码认证、端口转发和代理转发。浏览器不接收私钥，连接凭证一次性且 30 秒过期；每个登录最多 2 个终端、全局最多 8 个，15 分钟无输入或 2 小时后断开。导航离开 SSH 页会关闭会话。需要持久任务请使用 tmux/screen。

登录与 SSH 验证带尝试次数限制。代理后的限速按面板看到的来源地址计算，默认不信任客户端伪造的转发头。单管理员面板没有多用户权限隔离。

## 运维

```bash
sudo systemctl status taropanel taropanel-sshd
sudo journalctl -u taropanel -n 100 --no-pager
sudo systemctl restart taropanel
```

| 内容 | 路径 |
| --- | --- |
| 程序 | `/opt/taropanel` |
| 配置、会话、专用 SSH 密钥、流量、Compose 文件与备份 | `/var/lib/taropanel`（仅 root 可读） |
| 网页端口等运行参数 | `/etc/taropanel.env` |
| 升级前备份 | `/var/backups/taropanel/<时间>` |

修改网页端口：编辑 `/etc/taropanel.env` 中 `PANEL_PORT` 后重启。面板会保护当前网页端口和 SSH 管理端口不被自身屏蔽。

重置密码（隐藏输入）：

```bash
read -rs -p '新密码: ' PANEL_NEW_PASSWORD; echo
printf '%s\n' "$PANEL_NEW_PASSWORD" | sudo env PANEL_STATE_DIR=/var/lib/taropanel /opt/taropanel-runtime/bin/node /opt/taropanel/scripts/setup-password.cjs
unset PANEL_NEW_PASSWORD
sudo systemctl restart taropanel
```

如果安装使用系统 Node.js，把示例中的 `/opt/taropanel-runtime/bin/node` 换为系统 `node` 的绝对路径。重置会撤销旧登录，重启后生效。

更新：重新运行同一安装命令。安装失败会尝试恢复旧程序、配置及服务；已安装的系统软件不会卸载回滚。卸载：`sudo bash /opt/taropanel/scripts/uninstall.sh`，默认保留数据和备份。

## 数据口径与限制

- 防火墙只管理自己的 nftables 表，不代表云安全组或其他防火墙的最终结果。默认放行是“本面板未拦截”；扫描监听端口不是外部连通性测试。批量放行仅解除选中端口的屏蔽，其他范围保持不变。
- 流量从启用采集开始，每 60 秒采样；主机、容器、服务之间可能重复，不能相加。host 网络容器没有独立计数；systemd IPAccounting 受内核及既有连接影响。
- 系统服务默认发现 `/etc/systemd/system` 下普通 `.service` 文件，不包含系统全部单元。隐藏列表和自定义访问端口可配置 `hiddenUnits`、`hiddenContainers`、`access`。
- Compose 文件按原工作目录解析。项目需要的 `.env`、证书等外部文件应先准备；新建项目支持一个 YAML 文件，已有多文件项目逐个编辑并整体校验。
- 后台部署任务状态在内存中，重启面板会丢失任务记录；升级时应等部署/安装任务完成。

## 开发与打包

```bash
npm ci --omit=optional --ignore-scripts
npm run build
npm test
npx playwright install --with-deps chromium
npm run test:browser
npm run package
```

测试包括 Compose、防火墙范围拆分、真实 SSH/WebSocket 交互和鉴权，以及 8 个页面 × 8 种宽度。CI 同时覆盖 x64/ARM64 和 Node.js 22/24；另有 Ubuntu 安装烟雾测试。源码包不含依赖和任何运行数据，安装时按锁文件下载依赖。

前端终端来自 [xterm.js](https://xtermjs.org/)，SSH 客户端来自 [ssh2](https://github.com/mscdex/ssh2)，WebSocket 来自 [ws](https://github.com/websockets/ws)。代码采用 MIT；字体使用随附 OFL 许可，第三方组件保留其许可证。
