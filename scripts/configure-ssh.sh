#!/usr/bin/env bash
set -euo pipefail
# Invoked by install.sh after installing OpenSSH. No changes to the system sshd_config.
state_dir=${PANEL_STATE_DIR:-/var/lib/taropanel}
ssh_user=${PANEL_SSH_USER:-root}
ssh_port=${PANEL_SSH_PORT:-22222}
node_bin=${PANEL_NODE:-node}
[[ $EUID -eq 0 ]] || { echo 'SSH 配置需要 root'; exit 1; }
[[ "$ssh_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || { echo 'SSH 用户名无效'; exit 1; }
[[ "$ssh_port" =~ ^[0-9]+$ ]] && ((ssh_port>=1 && ssh_port<=65535)) || { echo 'SSH 端口无效'; exit 1; }
id "$ssh_user" >/dev/null
sshd_bin=$(command -v sshd)
install -d -m 700 "$state_dir/ssh" "$state_dir/ssh/authorized_keys"
install -d -m 755 /run/sshd
if [[ ! -f "$state_dir/ssh/client_key" ]]; then ssh-keygen -q -t ed25519 -N '' -C 'taropanel-local-client' -f "$state_dir/ssh/client_key"; fi
if [[ ! -f "$state_dir/ssh/host_key" ]]; then ssh-keygen -q -t ed25519 -N '' -C 'taropanel-local-host' -f "$state_dir/ssh/host_key"; fi
printf 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding %s\n' "$(cat "$state_dir/ssh/client_key.pub")" > "$state_dir/ssh/authorized_keys/$ssh_user"
chmod 600 "$state_dir/ssh/client_key" "$state_dir/ssh/host_key" "$state_dir/ssh/authorized_keys/$ssh_user"
cat > "$state_dir/ssh/sshd_config" <<EOF
Port $ssh_port
ListenAddress 127.0.0.1
HostKey $state_dir/ssh/host_key
PidFile /run/taropanel-sshd.pid
AuthorizedKeysFile none
AuthorizedKeysCommand /usr/bin/cat $state_dir/ssh/authorized_keys/%u
AuthorizedKeysCommandUser root
StrictModes yes
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin prohibit-password
AuthenticationMethods publickey
AllowUsers $ssh_user
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
UsePAM yes
PrintMotd no
LogLevel ERROR
EOF
"$sshd_bin" -t -f "$state_dir/ssh/sshd_config"
cat > /etc/systemd/system/taropanel-sshd.service <<EOF
[Unit]
Description=TaroPanel loopback-only SSH
After=network.target
[Service]
Type=simple
ExecStart=$sshd_bin -D -e -f $state_dir/ssh/sshd_config
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
PANEL_STATE_DIR="$state_dir" PANEL_SSH_USER="$ssh_user" PANEL_SSH_PORT="$ssh_port" "$node_bin" - <<'JS'
const fs=require('fs'),path=require('path');const root=process.env.PANEL_STATE_DIR,file=path.join(root,'config.json');let c=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};c.ssh={enabled:true,username:process.env.PANEL_SSH_USER,port:Number(process.env.PANEL_SSH_PORT),privateKey:path.join(root,'ssh/client_key'),hostPublicKey:path.join(root,'ssh/host_key.pub')};fs.writeFileSync(file,JSON.stringify(c,null,2)+'\n',{mode:0o600});fs.chmodSync(file,0o600);
JS
systemctl daemon-reload
systemctl enable taropanel-sshd >/dev/null
systemctl restart taropanel-sshd
systemctl is-active --quiet taropanel-sshd
