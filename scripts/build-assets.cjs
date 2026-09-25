const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),out=path.join(root,'public/assets');
for(const [source,target]of [
 ['@xterm/xterm/lib/xterm.js','xterm.js'],['@xterm/xterm/css/xterm.css','xterm.css'],['@xterm/xterm/LICENSE','xterm-LICENSE.txt'],
 ['@xterm/addon-fit/lib/addon-fit.js','xterm-fit.js'],['@xterm/addon-fit/LICENSE','xterm-fit-LICENSE.txt']
])fs.copyFileSync(path.join(root,'node_modules',source),path.join(out,target));
console.log('Terminal assets built locally');
