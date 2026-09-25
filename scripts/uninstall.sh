#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo '请使用 sudo'; exit 1; }
read -r -p '卸载 TaroPanel 程序和专用 SSH 服务，保留数据、备份及现有防火墙规则？[y/N] ' answer </dev/tty
[[ $answer == y || $answer == Y ]] || exit 0
systemctl disable --now taropanel taropanel-sshd || true
rm -f /etc/systemd/system/taropanel.service /etc/systemd/system/taropanel-sshd.service
systemctl daemon-reload
rm -rf -- /opt/taropanel
printf '已卸载。保留 /var/lib/taropanel、/var/backups/taropanel、/etc/taropanel.env 和专用 Node 运行时。\n'
echo '现有面板 nftables 规则仍在内核中，重启后不再由面板恢复。系统 SSH 配置未修改。'
