#!/bin/sh
state_dir=${PANEL_STATE_DIR:-/var/lib/taropanel}
if [ -s "$state_dir/data/firewall.nft" ] && command -v nft >/dev/null 2>&1; then
  nft --file "$state_dir/data/firewall.nft" || echo '面板防火墙规则恢复失败，请检查防火墙页面。' >&2
fi
exit 0
