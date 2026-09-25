#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
mkdir -p dist
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
mkdir "$stage/taropanel"
for file in server.js operations.js platform.js security.js ssh.js package.json package-lock.json install.sh README.md SECURITY.md LICENSE .gitignore; do cp "$file" "$stage/taropanel/"; done
cp -a scripts tests deploy .github "$stage/taropanel/"
mkdir -p "$stage/taropanel/public/assets"
cp public/index.html "$stage/taropanel/public/"
# Only static source assets; generated third-party bundles are rebuilt from package-lock.json.
for file in public/assets/*; do case "$(basename "$file")" in xterm.js|xterm.css|xterm-fit.js|xterm-LICENSE.txt|xterm-fit-LICENSE.txt) continue;; esac; cp "$file" "$stage/taropanel/public/assets/"; done
node scripts/audit-release.cjs "$stage/taropanel"
tar -czf "dist/taropanel-$version.tar.gz" -C "$stage" taropanel
(cd dist; sha256sum "taropanel-$version.tar.gz" > "taropanel-$version.tar.gz.sha256")
echo "Created dist/taropanel-$version.tar.gz"
