# 部署指南

本指南面向第一次安装的管理员。兼容性与验证范围见 [平台兼容表](COMPATIBILITY.md)，日常操作见 [使用教程](USER_GUIDE.md)。

## 1. 准备主机

需要使用 systemd 的 Linux 主机，并具有 root 或 sudo 权限。准备一个未占用的网页端口，以及现有 Linux 登录账户。安装过程中会联网访问系统软件仓库、Node.js、npm 和 GitHub。

```bash
uname -m
cat /etc/os-release
systemctl --version
sudo ss -ltnp
```

默认网页端口是 **80**；如果已有 Nginx、Apache 或其他程序占用，请选择如 **8080** 的空闲端口。不要停止不相关服务来腾出端口。

## 2. 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/0xtarotter/taropanel/main/install.sh -o /tmp/taropanel-install.sh
sudo bash /tmp/taropanel-install.sh
```

安装程序按顺序：

1. 询问网页端口，直接回车使用 80。
2. 检查系统，安装必要依赖并选择适合架构的 Node.js。
3. 按需安装 Docker/Compose；已有安装不会被替换。
4. 首次安装时要求设置并确认至少 12 位的面板密码，输入不会回显。
5. 为 Web SSH 配置独立的本机 SSH 实例、专用密钥和 systemd 服务。
6. 启动面板，检查网页响应并显示访问方式。

访问 `http://服务器地址:所选端口`，使用刚设置的面板密码登录。安装不会自动修改云安全组；如需远程访问，应按实际网络配置放行网页端口。

## 3. 安装选项

| 选项 / 环境变量 | 用途 |
| --- | --- |
| `--port=8080` | 直接指定网页端口，跳过端口提问 |
| `--ssh-user=admin` | 指定已有 Linux 账户，必须可登录 |
| `--ssh-port=22222` | 指定专用 SSH 的本机端口；仍只绑定 127.0.0.1 |
| `--no-ssh` | 禁用 Web SSH，不创建专用 SSH 服务 |
| `--no-docker` | 跳过 Docker/Compose 自动安装，其他功能仍可使用 |
| `--yes --password-stdin` | 首次非交互安装，从标准输入读取密码 |
| `PANEL_HOST=127.0.0.1` | 仅允许本机或反向代理访问网页 |
| `PANEL_NODE=/path/to/node` | 使用已有 Node.js ≥22，同目录须有 npm |
| `TAROPANEL_REF=v1.0.1` | 下载指定版本，便于固定部署 |
| `PANEL_SECURE_COOKIE=1` | 为登录 cookie 设置 Secure；仅适用于 HTTPS 访问 |

直接以 root 安装时 SSH 用户默认为 root；通过 sudo 安装时默认为调用 sudo 的现有用户。Web SSH 不改变该用户的 sudo 权限。

示例：

```bash
sudo bash /tmp/taropanel-install.sh --port=8080 --ssh-user=admin
sudo bash /tmp/taropanel-install.sh --port=8080 --no-docker --no-ssh
sudo env TAROPANEL_REF=v1.0.1 bash /tmp/taropanel-install.sh --port=8080
```

首次自动化安装时应由密钥管理工具向标准输入提供密码。不要使用命令行参数传密码，不要把真实密码写入脚本或 CI 日志。`--yes` 不会替你生成默认密码。

## 4. 使用 Release 安装包

从 [Releases](https://github.com/0xtarotter/taropanel/releases) 下载同一版本的 `.tar.gz` 和 `.tar.gz.sha256`，放在同一目录：

```bash
sha256sum -c taropanel-1.0.1.tar.gz.sha256
tar -xzf taropanel-1.0.1.tar.gz
cd taropanel
sudo bash install.sh
```

安装包是跨架构源码包，不包含运行数据和 `node_modules`。即使源码包已下载，安装依赖仍需要网络；目前没有提供完全离线安装包。官方 Node.js 和 Compose 二进制在安装时按架构选择，并校验下载文件的 SHA-256。

## 5. HTTPS 反向代理

公网使用建议由已有 Nginx/Caddy 等代理终止 HTTPS。以下以已有证书的 Nginx 为例；证书申请和 DNS 配置由你的环境决定。

先把面板绑定本机，例如编辑 `/etc/taropanel.env`：

```ini
PANEL_PORT=8080
PANEL_HOST=127.0.0.1
PANEL_SECURE_COOKIE=1
```

保留该文件中的 `PANEL_STATE_DIR`、`PANEL_SERVICE_UNIT` 等其他字段。重启面板：

```bash
sudo systemctl restart taropanel
```

把 [Nginx 示例](../deploy/nginx.conf.example) 中的 `location` 放进你现有的 HTTPS `server` 块。代理必须保留 `Host` 并传递 WebSocket Upgrade。检查配置后再重载 Nginx：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

通过 HTTPS 地址重新登录。配置 `Secure` cookie 后，直接用 HTTP 访问将无法正常维持登录，这是预期行为。

## 6. 安装验收

```bash
sudo systemctl is-active taropanel taropanel-sshd
sudo ss -ltnp
```

网页健康检查请使用实际端口的 GET：

```bash
curl -fsS http://127.0.0.1:80/ >/dev/null
```

如果选择了 `--no-ssh`，不要求 `taropanel-sshd` 处于 active。进入页面后检查总览、Docker 页面和 Web SSH。专用 SSH 应只显示在 `127.0.0.1:22222` 或你指定的本机端口。

出现问题时先查看 [运维与故障排查](OPERATIONS.md)，不要公开上传配置、密钥或完整生产日志。
