# 运维、升级和故障排查

## 文件与服务

| 项目 | 默认位置 |
| --- | --- |
| 程序 | `/opt/taropanel` |
| 状态目录 | `/var/lib/taropanel` |
| 环境参数 | `/etc/taropanel.env` |
| 主服务 | `taropanel.service` |
| 本机专用 SSH | `taropanel-sshd.service` |
| 安装备份 | `/var/backups/taropanel/<时间>` |
| 自动下载的 Node.js | `/opt/taropanel-runtime` |

状态目录包含密码哈希、会话、SSH 私钥、流量历史、Compose 配置和备份。即使只是备份文件，也应按敏感数据保管。不要把它加入 Git、公开网盘或 Issue。

```bash
sudo systemctl status taropanel taropanel-sshd
sudo journalctl -u taropanel -n 100 --no-pager
sudo journalctl -u taropanel-sshd -n 100 --no-pager
```

## 修改网页端口

先确认新端口未被其他服务使用，再用 `sudoedit /etc/taropanel.env` 修改 `PANEL_PORT`，保留其他字段，最后重启：

```bash
sudo ss -ltnp
sudoedit /etc/taropanel.env
sudo systemctl restart taropanel
```

反向代理和云安全组要同步调整。Web SSH 的回环端口不需要向公网开放。

## 重置面板密码

若使用安装器自动下载的 Node.js，可在管理员终端执行：

```bash
read -rs -p '新密码（至少12位）: ' PANEL_NEW_PASSWORD; echo
printf '%s\n' "$PANEL_NEW_PASSWORD" | sudo env PANEL_STATE_DIR=/var/lib/taropanel /opt/taropanel-runtime/bin/node /opt/taropanel/scripts/setup-password.cjs
unset PANEL_NEW_PASSWORD
sudo systemctl restart taropanel
```

若安装时使用系统或自定义 Node.js，请换成对应的 Node 可执行文件绝对路径。不要把新密码作为命令行参数。重置会清空保存的会话；运行中的进程需要重启才能使用新配置并撤销原登录。

## 备份和升级

升级前完成或停止正在进行的 Compose 部署、软件安装以及重要 SSH 前台任务。面板重启会丢失内存中的后台任务记录并断开 Web SSH。

重新运行安装程序即可更新。使用非默认网页端口、SSH 用户或禁用功能时，升级也应传入对应选项，避免回到默认值，例如：

```bash
sudo bash /tmp/taropanel-install.sh --port=8080 --ssh-user=admin --no-docker
```

安装程序会先准备依赖和新程序，再备份旧程序、状态目录及服务配置。失败时尝试回滚程序和服务；系统包管理器已经安装的软件不会卸载回滚。保留旧备份直到新版本验收完成。

自行离线备份时，至少包含 `/var/lib/taropanel`、`/etc/taropanel.env` 和相关 systemd 单元；备份文件应仅允许 root 读取。活跃采样或配置修改期间的直接复制不一定是同一时间点的一致快照，重要备份应在维护窗口暂停面板后完成。

## 手动恢复

先确定备份中的 `app/`、`state/`、服务单元和环境文件完整，不要将多个时间点的内容混用。维护窗口中停止面板，保存当前失败版本，再恢复对应程序、状态、环境文件和 systemd 单元，运行 `systemctl daemon-reload` 后启动服务。

恢复 SSH 私钥和主机公钥时应与对应 SSH 服务配置一起恢复。不要仅从一个新版本覆盖私钥文件而保留旧公钥配置。

## 配置隐藏项和访问端口

通过 `sudoedit /var/lib/taropanel/config.json` 修改配置。下面只是可以合并的字段示例，不是可直接覆盖原文件的完整配置：

```json
{
  "hiddenUnits": ["example.service"],
  "hiddenContainers": ["example-container"],
  "access": {
    "demo.service": "8080",
    "demo-container": "8081/ui"
  }
}
```

必须保留原有 `passwordHash`、`salt`、`ssh` 等字段；配置修改后重启面板。隐藏列表是界面和操作范围配置，不是多用户权限隔离功能。

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 安装提示端口已占用 | 用 `ss -ltnp` 确认归属，改用 `--port`；不要误停业务服务 |
| 面板能登录，Web SSH 未配置 | 检查是否使用了 `--no-ssh`，以及专用 SSH 配置是否存在 |
| Web SSH 连接失败 | 查看 `taropanel-sshd` 日志，确认账户可登录、回环端口可用及专用密钥可读 |
| 代理后 SSH 无法连接 | 检查 WebSocket Upgrade、原始 Host 和代理超时；使用 HTTPS 对应 wss |
| 输入密码后仍回到登录 | 检查 `PANEL_SECURE_COOKIE=1` 是否配合 HTTPS，以及浏览器 cookie 设置 |
| 验证次数过多 | 登录按来源地址限速；等待 15 分钟后重试，代理下多人可能共享来源 |
| Docker 页面报不可用 | 确认 daemon 与 CLI；使用 `--no-docker` 安装时需自行准备 Docker |
| Compose 校验失败 | 检查 YAML、变量、`.env`、相对路径和多文件组合；查看任务输出 |
| 扫描有端口但外网连不上 | 检查监听地址、应用健康、宿主机其他规则、路由器和云安全组 |
| 流量显示“—”或历史不足 | 等待采样；检查网络模式和 IPAccounting 支持，不要把未知值理解为 0 |
| 软件安装下载失败 | 检查 DNS、系统源和 GitHub/npm/Node.js 网络访问；不要删除原数据后盲目重装 |

## 卸载

```bash
sudo bash /opt/taropanel/scripts/uninstall.sh
```

卸载脚本会询问确认，移除面板程序和专用 SSH 服务；默认保留状态、备份、环境文件和专用 Node 运行时。它不会卸载 Docker、删除业务容器或修改系统 SSH 配置。

当前内核中的面板 nftables 规则仍保留，重启后不再由面板恢复。卸载前应先确认保留这些规则是否符合预期。数据清理属于另外的管理操作，不会由脚本默认执行。
