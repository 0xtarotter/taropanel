#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [[ -n ${PANEL_NODE:-} ]]; then
 [[ $PANEL_NODE == /* && -x $PANEL_NODE ]] || { echo 'PANEL_NODE 必须是有效的 Node 可执行文件绝对路径'; exit 1; }
 export PATH="$(dirname "$PANEL_NODE"):$PATH"
fi
host=${PANEL_HOST:-$(sed -n 's/^PANEL_HOST=//p' /etc/taropanel.env 2>/dev/null || true)}
host=${host:-0.0.0.0}
[[ $host == 0.0.0.0 || $host == 127.0.0.1 || $host == :: || $host == ::1 ]] || { echo 'PANEL_HOST 请使用 0.0.0.0、127.0.0.1、:: 或 ::1'; exit 1; }
secure_cookie=${PANEL_SECURE_COOKIE:-$(sed -n 's/^PANEL_SECURE_COOKIE=//p' /etc/taropanel.env 2>/dev/null || true)}
secure_cookie=${secure_cookie:-0}
[[ $secure_cookie == 0 || $secure_cookie == 1 ]] || exit 1
repo=${TAROPANEL_REPOSITORY:-0xtarotter/taropanel}
ref=${TAROPANEL_REF:-main}
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
port=${PANEL_PORT:-}
ssh_user=${PANEL_SSH_USER:-${SUDO_USER:-root}}
ssh_port=${PANEL_SSH_PORT:-22222}
ssh_enabled=1
docker_enabled=1
noninteractive=0
password_stdin=0
for arg in "$@"; do
 case "$arg" in
  --port=*) port=${arg#*=};;
  --ssh-user=*) ssh_user=${arg#*=};;
  --ssh-port=*) ssh_port=${arg#*=};;
  --yes) noninteractive=1;;
  --password-stdin) password_stdin=1;;
  --no-ssh) ssh_enabled=0;;
  --no-docker) docker_enabled=0;;
  --help) echo '安装：sudo bash install.sh [--port=80] [--ssh-user=root] [--ssh-port=22222] [--no-ssh] [--no-docker] [--yes --password-stdin]'; exit 0;;
  *) echo "未知参数：$arg"; exit 1;;
 esac
done
[[ $EUID -eq 0 ]] || { echo '请使用 sudo bash install.sh'; exit 1; }
[[ -d /run/systemd/system ]] || { echo '需要使用 systemd 的 Linux 主机；不支持普通 Docker 容器内安装。'; exit 1; }
if [[ -z $port ]]; then
 if ((noninteractive)); then port=80; else read -r -p '网页监听端口 [80]: ' port </dev/tty; port=${port:-80}; fi
fi
[[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port>=1 && 10#$port<=65535)) || { echo '网页端口必须在 1–65535 之间'; exit 1; }
port=$((10#$port))
[[ $ssh_port =~ ^[0-9]{1,5}$ ]] && ((10#$ssh_port>=1 && 10#$ssh_port<=65535)) || { echo 'SSH 端口必须在 1–65535 之间'; exit 1; }
ssh_port=$((10#$ssh_port))
[[ $ssh_user =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || { echo 'SSH 用户名无效'; exit 1; }
id "$ssh_user" >/dev/null
if ((ssh_enabled)) && [[ $port == "$ssh_port" ]]; then echo '网页端口不能与本机 SSH 端口相同'; exit 1; fi
install_dir=/opt/taropanel
state_dir=/var/lib/taropanel
work=$(mktemp -d)
chmod 755 "$work"
masked_units=()
cleanup(){ for unit in "${masked_units[@]}"; do systemctl unmask --runtime "$unit" >/dev/null 2>&1 || true; done; rm -rf -- "$work"; }
trap cleanup EXIT
# A fresh OpenSSH package must not automatically expose a system SSH listener.
fresh_openssh=0
if ! command -v sshd >/dev/null; then
 fresh_openssh=1
 for unit in ssh.service ssh.socket sshd.service sshd.socket; do
  if [[ ! -e /run/systemd/system/$unit && ! -L /run/systemd/system/$unit ]]; then systemctl mask --runtime "$unit" >/dev/null; masked_units+=("$unit"); fi
 done
fi
if command -v apt-get >/dev/null; then
 export DEBIAN_FRONTEND=noninteractive
 apt-get update
 apt-get install -y ca-certificates curl tar xz-utils iproute2 openssh-server openssh-client
 pm=apt
elif command -v dnf >/dev/null; then
 dnf install -y ca-certificates curl tar xz iproute openssh-server openssh-clients
 pm=dnf
elif command -v pacman >/dev/null; then
 pacman -Syu --needed --noconfirm ca-certificates curl tar xz iproute2 openssh
 pm=pacman
else echo '支持 apt、dnf、pacman 系统；请参考 README 手动安装。'; exit 1; fi
if ((fresh_openssh)); then
 for unit in ssh.service ssh.socket sshd.service sshd.socket; do systemctl disable "$unit" >/dev/null 2>&1 || true; done
 for unit in "${masked_units[@]}"; do systemctl unmask --runtime "$unit" >/dev/null 2>&1 || true; done
 masked_units=()
fi
# A curl-downloaded installer fetches a fresh source archive, never local configuration.
if [[ ! -f "$source_dir/package.json" || ! -f "$source_dir/scripts/configure-ssh.sh" ]]; then
 [[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $ref =~ ^[A-Za-z0-9._-]+$ ]] || { echo '仓库或版本参数无效'; exit 1; }
 curl -fL --retry 3 "https://github.com/$repo/archive/$ref.tar.gz" -o "$work/source.tar.gz"
 mkdir "$work/source"
 tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1
 source_dir=$work/source
fi
# Prefer a native system Node.js >=22. Official LTS binaries cover x64/arm64;
# other architectures use their distro's native Node.js and npm packages.
node_ok(){ command -v node >/dev/null && command -v npm >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)'; }
if ! node_ok; then
 arch=$(uname -m)
 case "$arch" in x86_64) node_arch=x64;; aarch64|arm64) node_arch=arm64;; *) node_arch=;; esac
 if [[ -n $node_arch ]]; then
  base=https://nodejs.org/dist/latest-v24.x
  curl -fL --retry 3 "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  node_file=$(awk -v suffix="-linux-$node_arch.tar.xz" 'index($2,suffix) && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$work/SHASUMS256.txt")
  [[ $node_file =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo '无法确认 Node LTS 下载文件'; exit 1; }
  curl -fL --retry 3 "$base/$node_file" -o "$work/$node_file"
  (cd "$work"; awk -v file="$node_file" '$2==file' SHASUMS256.txt | sha256sum -c -)
  install -d -m 755 /opt/taropanel-runtime
  tar -xJf "$work/$node_file" -C /opt/taropanel-runtime --strip-components=1
  export PATH=/opt/taropanel-runtime/bin:$PATH
 else
  case $pm in apt) apt-get install -y nodejs npm;; dnf) dnf install -y nodejs npm;; pacman) pacman -S --needed --noconfirm nodejs npm;; esac
 fi
fi
node_ok || { echo '此架构需要系统提供 Node.js >=22 和 npm；安装后重新运行。'; exit 1; }
node_bin=$(command -v node)
if ((docker_enabled)) && ! command -v docker >/dev/null; then
 case $pm in apt) apt-get install -y docker.io;; dnf) dnf install -y moby-engine docker-cli;; pacman) pacman -S --needed --noconfirm docker;; esac
 systemctl enable --now docker
fi
if ((docker_enabled)) && ! docker compose version >/dev/null 2>&1; then
 case $(uname -m) in x86_64) compose_arch=x86_64;; aarch64|arm64) compose_arch=aarch64;; armv7l) compose_arch=armv7;; ppc64le|s390x|riscv64) compose_arch=$(uname -m);; *) echo '此架构请先手动安装 Docker Compose v2'; exit 1;; esac
 curl -fL --retry 3 https://api.github.com/repos/docker/compose/releases/latest -o "$work/compose-release.json"
 compose_tag=$("$node_bin" -e 'const r=require(process.argv[1]);if(!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(r.tag_name))process.exit(1);console.log(r.tag_name)' "$work/compose-release.json")
 compose_file=docker-compose-linux-$compose_arch
 compose_base=https://github.com/docker/compose/releases/download/$compose_tag
 curl -fL --retry 3 "$compose_base/$compose_file" -o "$work/$compose_file"
 curl -fL --retry 3 "$compose_base/checksums.txt" -o "$work/compose-checksums.txt"
 (cd "$work"; awk -v file="$compose_file" '$2==file || $2=="*"file' compose-checksums.txt | sha256sum -c -)
 install -d -m 755 /usr/local/lib/docker/cli-plugins
 install -m 755 "$work/$compose_file" /usr/local/lib/docker/cli-plugins/docker-compose
 docker compose version
fi
# Refuse to steal an unrelated web listener; an existing TaroPanel instance may keep its port.
if ss -H -ltn "sport = :$port" | read -r _; then
 existing_port=$(sed -n 's/^PANEL_PORT=//p' /etc/taropanel.env 2>/dev/null || true)
 [[ $existing_port == "$port" ]] && systemctl is-active --quiet taropanel || { echo "网页端口 $port 已占用，请用 --port 指定其他端口。"; exit 1; }
fi
if ((ssh_enabled)) && ss -H -ltn "sport = :$ssh_port" | read -r _; then
 systemctl is-active --quiet taropanel-sshd && grep -qx "Port $ssh_port" "$state_dir/ssh/sshd_config" || { echo "SSH 端口 $ssh_port 已占用，请用 --ssh-port 指定其他端口。"; exit 1; }
fi
install -d -m 700 "$state_dir"
# Build in staging so failed downloads never overwrite the running application.
mkdir "$work/app"
for file in server.js operations.js ssh.js security.js platform.js package.json package-lock.json; do cp "$source_dir/$file" "$work/app/"; done
cp -a "$source_dir/public" "$source_dir/scripts" "$work/app/"
(cd "$work/app"; npm ci --omit=dev --omit=optional --ignore-scripts; npm run build; node --check server.js; node --check ssh.js)
backup=/var/backups/taropanel/$(date +%Y%m%d-%H%M%S)
install -d -m 700 "$backup"
if [[ -d $install_dir ]]; then cp -a "$install_dir" "$backup/app"; fi
cp -a "$state_dir" "$backup/state"
for file in /etc/systemd/system/taropanel.service /etc/systemd/system/taropanel-sshd.service /etc/taropanel.env; do [[ ! -f $file ]] || cp -a "$file" "$backup/"; done
old_panel_active=0;old_ssh_active=0
systemctl is-active --quiet taropanel && old_panel_active=1
systemctl is-active --quiet taropanel-sshd && old_ssh_active=1
rollback(){
 trap - ERR
 echo "安装失败，正在恢复配置；备份目录：$backup" >&2
 systemctl stop taropanel 2>/dev/null || true
 if [[ -d "$backup/app" ]]; then rm -rf -- "$install_dir"; cp -a "$backup/app" "$install_dir"; fi
 cp -a "$backup/state/." "$state_dir/"
 for file in taropanel.service taropanel-sshd.service; do if [[ -f "$backup/$file" ]]; then cp -a "$backup/$file" /etc/systemd/system/; else rm -f "/etc/systemd/system/$file"; fi; done
 if [[ -f "$backup/taropanel.env" ]]; then cp -a "$backup/taropanel.env" /etc/taropanel.env; fi
 systemctl daemon-reload
 if ((old_panel_active)); then systemctl restart taropanel; fi
 if ((old_ssh_active)); then systemctl restart taropanel-sshd; else systemctl stop taropanel-sshd 2>/dev/null || true; fi
 exit 1
}
trap rollback ERR
if [[ ! -f "$state_dir/config.json" ]]; then
 if ((password_stdin)); then
  PANEL_STATE_DIR="$state_dir" "$node_bin" "$source_dir/scripts/setup-password.cjs"
 elif ((noninteractive)); then echo '首次非交互安装必须使用 --password-stdin'; false
 else
  read -r -s -p '设置面板密码（至少12位）: ' password </dev/tty; echo
  read -r -s -p '再次输入密码: ' repeat </dev/tty; echo
  [[ $password == "$repeat" ]] || { echo '两次密码不一致'; false; }
  printf '%s\n' "$password" | PANEL_STATE_DIR="$state_dir" "$node_bin" "$source_dir/scripts/setup-password.cjs"
  unset password repeat
 fi
fi
if ((ssh_enabled)); then
 PANEL_STATE_DIR="$state_dir" PANEL_SSH_USER="$ssh_user" PANEL_SSH_PORT="$ssh_port" PANEL_NODE="$node_bin" bash "$source_dir/scripts/configure-ssh.sh"
else
 PANEL_STATE_DIR="$state_dir" "$node_bin" -e 'const fs=require("fs"),p=process.env.PANEL_STATE_DIR+"/config.json",c=JSON.parse(fs.readFileSync(p));c.ssh={enabled:false};fs.writeFileSync(p,JSON.stringify(c),{mode:0o600})'
 systemctl disable --now taropanel-sshd 2>/dev/null || true
fi
install -d -m 755 "$install_dir"
cp -a "$work/app/." "$install_dir/"
# Runtime state is kept out of the application directory and release archive.
cat > /etc/taropanel.env <<EOF
PANEL_PORT=$port
PANEL_HOST=$host
PANEL_SECURE_COOKIE=$secure_cookie
PANEL_STATE_DIR=$state_dir
PANEL_SERVICE_UNIT=taropanel.service
EOF
chmod 600 /etc/taropanel.env
cat > /etc/systemd/system/taropanel.service <<EOF
[Unit]
Description=TaroPanel Linux management panel
After=network.target docker.service taropanel-sshd.service
[Service]
Type=simple
User=root
WorkingDirectory=$install_dir
Environment=PATH=$(dirname "$node_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/etc/taropanel.env
ExecStartPre=/bin/sh $install_dir/scripts/firewall-restore.sh
ExecStart=$node_bin $install_dir/server.js
Restart=on-failure
RestartSec=3
UMask=0077
IPAccounting=yes
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable taropanel >/dev/null
systemctl restart taropanel
check_host=127.0.0.1
[[ $host != :: && $host != ::1 ]] || check_host='[::1]'
for _ in {1..20}; do if curl -fsS "http://$check_host:$port/" -o /dev/null; then break; fi; sleep 1; done
systemctl is-active --quiet taropanel
curl -fsS "http://$check_host:$port/" -o /dev/null
trap - ERR
printf '\nTaroPanel 安装完成。网页端口：%s；请访问 http://主机地址:%s\n' "$port" "$port"
echo "升级备份：$backup"
echo '公网访问请配置 HTTPS 反向代理；安装不会自动向公网开放额外 SSH 端口。'
