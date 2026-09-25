#!/usr/bin/env node
/**
 * 服务管理面板 (Service Panel)
 * Node.js 实现。默认监听 80 端口，提供本机部署项目的状态查看与启停控制。
 *
 * 自动发现:
 *   - systemd 服务: /etc/systemd/system/*.service 下的常规文件(非软链接)
 *   - Docker 容器: docker ps -a
 *
 * 安全:
 *   - 登录鉴权 (scrypt 密码哈希 + 内存 session + HttpOnly/SameSite=Strict cookie)
 *   - 控制命令白名单 (仅允许操作已发现的服务/容器名，正则校验防注入)
 *   - 使用 execFile (数组参数) 而非 shell 拼接
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const {binary}=require('./platform');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATE_ROOT = path.resolve(process.env.PANEL_STATE_DIR || ROOT);
fs.mkdirSync(STATE_ROOT,{recursive:true,mode:0o700});
const CONFIG_PATH = path.join(STATE_ROOT, 'config.json');
const SESSIONS_PATH = path.join(STATE_ROOT, 'sessions.json');
const PORT = parseInt(process.env.PANEL_PORT || '80', 10);
const HOST = process.env.PANEL_HOST || '0.0.0.0';
const {limiter,sameOrigin}=require('./security');
const loginAttempts=limiter();
const SELF_UNIT=process.env.PANEL_SERVICE_UNIT||'taropanel.service';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

// ---------- 配置 ----------
let config = { passwordHash: null, salt: null, hiddenUnits: [], hiddenContainers: [] };
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) {
    console.error('[panel] config.json 解析失败:', e.message);
  }
}

// ---------- session 存储 ----------
const sessions = new Map(); // token -> expiresAt(ms)

// 从磁盘恢复 session（服务重启后保持登录）
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_PATH)) return;
    const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    const now = Date.now();
    for (const [token, exp] of Object.entries(data)) {
      if (typeof exp === 'number' && exp > now) sessions.set(token, exp);
    }
  } catch (e) {
    console.error('[panel] 加载 sessions 失败:', e.message);
  }
}

// 持久化 session 到磁盘
function saveSessions() {
  try {
    const obj = {};
    for (const [token, exp] of sessions) obj[token] = exp;
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(obj),{mode:0o600});
    fs.chmodSync(SESSIONS_PATH,0o600);
  } catch (e) {
    console.error('[panel] 保存 sessions 失败:', e.message);
  }
}

// ---------- 工具函数 ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password) {
  if (typeof password!=='string'||password.length>1024||!config.passwordHash || !config.salt) return false;
  try {
    const h = Buffer.from(hashPassword(password, config.salt), 'hex');
    const stored = Buffer.from(config.passwordHash, 'hex');
    return h.length === stored.length && crypto.timingSafeEqual(h, stored);
  } catch {
    return false;
  }
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  saveSessions();
  return token;
}

function sessionValid(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); saveSessions(); return false; }
  return true;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function exec(command, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(binary(command), args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// ---------- 服务发现 ----------
// systemd: 列出 /etc/systemd/system 下的常规 .service 文件(非软链接)
function discoverSystemdUnits() {
  const dir = '/etc/systemd/system';
  let units = [];
  try {
    const entries = fs.readdirSync(dir);
    units = entries.filter((f) => {
      if (!f.endsWith('.service')) return false;
      const full = path.join(dir, f);
      try {
        const st = fs.lstatSync(full);
        return st.isFile() && !st.isSymbolicLink(); // 排除软链接别名与目录
      } catch {
        return false;
      }
    });
  } catch (e) {
    console.error('[panel] 读取 systemd 目录失败:', e.message);
  }
  return units;
}

async function getSystemdStatus(unit) {
  const { err, stdout } = await exec('/usr/bin/systemctl', ['show', unit, '--no-pager',
    '--property=ActiveState,SubState,Description,UnitFileState,ExecMainPID,LoadState,ControlGroup']);
  const info = {};
  if (!err && stdout) {
    for (const line of stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) info[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return info;
}

async function discoverDocker() {
  const { err, stdout } = await exec('/usr/bin/docker', ['ps', '-a', '--no-trunc',
    '--format', '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}']);
  if (err) return [];
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [name, image, state, status] = line.split('\t');
    return { name, image, state, status };
  });
}

// ---------- 端口发现 ----------
// 运行一次 ss，返回 pid -> Set(port) 映射（所有 systemd 服务共用，避免重复 fork）
async function getListeningPorts() {
  const { err, stdout } = await exec('/usr/bin/ss', ['-tlnpH']);
  const map = {}; // pid -> Set(number)
  if (err) return map;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('LISTEN')) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[3] || ''; // 形如 0.0.0.0:8082 / *:7890 / [::]:8082
    const pm = local.match(/:(\d+)$/);
    if (!pm) continue;
    const port = parseInt(pm[1], 10);
    const pidRe = /pid=(\d+)/g;
    let m;
    while ((m = pidRe.exec(line))) {
      const pid = m[1];
      (map[pid] ||= new Set()).add(port);
    }
  }
  return map;
}

// 通过 systemd ControlGroup 读 cgroup.procs，得到 unit 的全部进程 PID
function getUnitPids(controlGroup) {
  const pids = [];
  if (!controlGroup) return pids;
  try {
    const cgPath = '/sys/fs/cgroup' + controlGroup + '/cgroup.procs';
    const data = fs.readFileSync(cgPath, 'utf8');
    for (const line of data.split('\n')) {
      const t = line.trim();
      if (t) pids.push(t);
    }
  } catch {
    /* cgroup 不可读（服务已停止等）时返回空 */
  }
  return pids;
}

function collectPorts(pids, portMap) {
  const set = new Set();
  for (const pid of pids) {
    const ports = portMap[pid];
    if (ports) for (const p of ports) set.add(p);
  }
  return [...set].sort((a, b) => a - b);
}

// Docker 容器端口映射：docker port <name>，取宿主端口并去重
async function getDockerPorts(name) {
  const { err, stdout } = await exec('/usr/bin/docker', ['port', name]);
  if (err || !stdout) return [];
  const ports = new Set();
  for (const line of stdout.split('\n')) {
    const m = line.match(/->\s*(\S+)$/); // 形如 8080/tcp -> 0.0.0.0:8081
    if (!m) continue;
    const pm = m[1].match(/:(\d+)$/);
    if (pm) ports.add(parseInt(pm[1], 10));
  }
  return [...ports].sort((a, b) => a - b);
}

// ---------- 控制操作 ----------
// 各项目的默认 web 首页访问地址（端口或 端口/路径）。可在 config.json 的 access 字段覆盖。
const DEFAULT_ACCESS = {[SELF_UNIT]:String(PORT)};

function buildAccessMap() {
  return { ...DEFAULT_ACCESS, ...(config.access || {}) };
}
const SYSTEMD_ACTIONS = new Set(['start', 'stop', 'restart']);
const DOCKER_ACTIONS = new Set(['start', 'stop', 'restart', 'pause', 'unpause']);
// systemd unit / docker 名称的合法字符集 (防命令注入)
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,127}$/;

async function controlSystemd(unit, action) {
  if (!SYSTEMD_ACTIONS.has(action)) return { ok: false, msg: '不支持的操作' };
  if (!NAME_RE.test(unit)) return { ok: false, msg: '非法服务名' };
  const { err, stderr } = await exec('/usr/bin/systemctl', [action, unit]);
  if (err) return { ok: false, msg: stderr || err.message };
  return { ok: true };
}

async function controlDocker(name, action) {
  if (!DOCKER_ACTIONS.has(action)) return { ok: false, msg: '不支持的操作' };
  if (!NAME_RE.test(name)) return { ok: false, msg: '非法容器名' };
  const { err, stderr } = await exec('/usr/bin/docker', [action, ...(action === 'stop' || action === 'restart' ? ['--timeout','10'] : []), name], 20000);
  if (err) return { ok: false, msg: stderr || err.message };
  return { ok: true };
}

// Batch collection and shared short-lived cache: one systemctl, one ss and one docker query.
let projectsCache = null;
let projectsFlight = null;
let cacheGeneration = 0;
const pendingActions = new Set();
function invalidateProjects() { projectsCache = null; projectsFlight = null; cacheGeneration++; }

async function collectProjects() {
  const units = discoverSystemdUnits().filter(u => !config.hiddenUnits.includes(u));
  const [systemResult, portMap, dockerResult] = await Promise.all([
    units.length ? exec('/usr/bin/systemctl', ['show', ...units, '--no-pager', '--property=Id,ActiveState,SubState,Description,UnitFileState,ExecMainPID,LoadState,ControlGroup']) : Promise.resolve({ stdout: '', err: null }),
    getListeningPorts(),
    exec('/usr/bin/docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'])
  ]);
  const warnings = [];
  if (systemResult.err) warnings.push('部分系统服务状态读取失败');
  if (dockerResult.err) warnings.push('Docker 暂不可用，请检查 Docker 服务');
  const infoMap = new Map();
  for (const block of systemResult.stdout.split(/\n\s*\n/)) {
    const info = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) info[line.slice(0,i)] = line.slice(i+1);
    }
    if (info.Id) infoMap.set(info.Id, info);
  }
  const access = buildAccessMap();
  const systemd = units.map(name => {
    const info = infoMap.get(name) || {};
    const pids = getUnitPids(info.ControlGroup || '');
    if (info.ExecMainPID && !pids.includes(info.ExecMainPID)) pids.push(info.ExecMainPID);
    const ports = collectPorts(pids, portMap);
    return { type: 'systemd', name, description: info.Description || '', active: info.ActiveState || 'unknown', sub: info.SubState || '', unitFileState: info.UnitFileState || '', pid: info.ExecMainPID || '', ports, mainAccess: access[name] || (ports.length ? String(ports[0]) : null), protected: name === SELF_UNIT };
  });
  const docker = [];
  if (!dockerResult.err) for (const line of dockerResult.stdout.split('\n').filter(Boolean)) {
    try {
      const c = JSON.parse(line);
      if (config.hiddenContainers.includes(c.Names)) continue;
      const ports = [...new Set([...String(c.Ports || '').matchAll(/:(\d+)(?:-(\d+))?->[^,]*\/tcp/g)].map(m => Number(m[1])))].sort((a,b) => a-b);
      docker.push({ type: 'docker', name: c.Names, image: c.Image, state: c.State, status: c.Status, ports, mainAccess: access[c.Names] || (ports.length ? String(ports[0]) : null) });
    } catch { warnings.push('一个容器的信息无法解析'); }
  }
  const mem = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  const available = mem ? Number(mem[1]) * 1024 : os.freemem();
  return { ok: true, systemd, docker, warnings, updatedAt: new Date().toISOString(), host: { name: os.hostname(), uptime: os.uptime(), cores: os.cpus().length, load: os.loadavg()[0], memoryTotal: os.totalmem(), memoryUsed: Math.max(0, os.totalmem() - available) } };
}
function getProjects() {
  if (projectsCache && Date.now() - projectsCache.time < 3000) return Promise.resolve(projectsCache.data);
  if (projectsFlight) return projectsFlight;
  const generation = cacheGeneration;
  const flight = collectProjects().then(data => {
    if (generation === cacheGeneration) projectsCache = { data, time: Date.now() };
    return data;
  }).finally(() => { if (projectsFlight === flight) projectsFlight = null; });
  projectsFlight = flight;
  return flight;
}


const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const RESTART = /^(no|always|unless-stopped|on-failure(?::[1-9][0-9]{0,3})?)$/;
async function dockerCommand(args) {
  const r = await exec('/usr/bin/docker', args, 20000);
  if (r.err) throw new Error(r.stderr || 'Docker 操作失败或超时，请刷新状态确认');
  return r.stdout;
}
async function inspectContainer(name) {
  if (!DOCKER_NAME.test(name || '')) throw new Error('容器名称无效');
  if (!(await getProjects()).docker.some(c => c.name === name)) throw new Error('容器不在允许列表');
  return JSON.parse(await dockerCommand(['inspect', '--type=container', name]))[0];
}
function createArgs(b) {
  if (!DOCKER_NAME.test(b.name || '') || config.hiddenContainers.includes(b.name)) throw new Error('容器名称无效或不可用');
  if (typeof b.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(b.image)) throw new Error('镜像名称无效');
  if (!RESTART.test(b.restart || '')) throw new Error('重启策略无效');
  const args = ['create', '--pull=never', '--name', b.name, '--restart', b.restart];
  for (const [field, flag] of [['ports','--publish'],['env','--env'],['volumes','--volume']]) {
    if (!Array.isArray(b[field]) || b[field].length > 100) throw new Error('配置列表无效');
    for (const value of b[field]) {
      if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('配置格式无效');
      if (field === 'ports') {
        const m = value.match(/^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/);
        if (!m || (m[1] && m[1].split('.').some(n => +n > 255)) || ![+m?.[2],+m?.[3]].every(n => n > 0 && n <= 65535)) throw new Error('端口格式应为 8080:80 或 127.0.0.1:8080:80/tcp');
      }
      if (field === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) throw new Error('环境变量应为 KEY=value');
      if (field === 'volumes' && !/^(?:\/[\w./-]+|[A-Za-z0-9][\w.-]*):\/[\w./-]+(?::(?:ro|rw))?$/.test(value)) throw new Error('挂载应为 /宿主路径:/容器路径 或 卷名:/容器路径，可加 :ro');
      args.push(flag, value);
    }
  }
  args.push(b.image);
  return args;
}

const operations = require('./operations')({root:STATE_ROOT,send,readBody,getProjects,invalidateProjects});

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  let url;try{url=new URL(req.url, 'http://localhost')}catch{return send(res,400,{ok:false,msg:'无效地址'})}
  const p = url.pathname;

  if (req.method === 'POST' && req.headers.origin && !sameOrigin(req)) return send(res,403,{ok:false,msg:'拒绝跨站操作'});
  if (req.method === 'GET' && /^\/assets\/[a-zA-Z0-9_.-]+$/.test(p)) {
    const file=path.join(PUBLIC_DIR,p.slice(1));
    try { const body=fs.readFileSync(file); const ext=path.extname(file); res.writeHead(200,{'Content-Type':({'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8'})[ext]||'application/octet-stream','Cache-Control':/\.(woff2|ttf)$/.test(file)?'public, max-age=31536000, immutable':'no-cache','X-Content-Type-Options':'nosniff'});res.end(body); }
    catch { send(res,404,{ok:false,msg:'资源不存在'}); } return;
  }
  // 静态资源
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('index.html 缺失');
    }
    return;
  }
  if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  // 登录
  if (req.method === 'POST' && p === '/api/login') {
    if(!loginAttempts.check(req.socket.remoteAddress||'local'))return send(res,429,{ok:false,msg:'尝试次数过多，请 15 分钟后重试'});
    let body;
    try { body = JSON.parse(await readBody(req)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body'); } catch { return send(res, 400, { ok: false, msg: '无效请求' }); }
    if (!verifyPassword(body.password || '')) {
      return send(res, 401, { ok: false, msg: '密码错误' });
    }
    loginAttempts.clear(req.socket.remoteAddress||'local');
    const token = createSession();
    const cookie = `panel_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}; Path=/${req.socket.encrypted||process.env.PANEL_SECURE_COOKIE==='1'?'; Secure':''}`;
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  // 登出
  if (req.method === 'POST' && p === '/api/logout') {
    const token = (req.headers.cookie || '').match(/panel_session=([^;]+)/)?.[1];
    if (token) { ssh.revoke(token);sessions.delete(token); saveSessions(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'panel_session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/' });
  }

  // 以下接口需鉴权
  const token = (req.headers.cookie || '').match(/panel_session=([^;]+)/)?.[1];
  if (!sessionValid(token)) return send(res, 401, { ok: false, msg: '未登录' });

  if (await ssh.route(req,res,url)) return;
  if (await operations.route(req,res,url)) return;

  // 项目列表 (自动发现 + 状态 + 端口)
  if (req.method === 'GET' && p === '/api/projects') {
    try { return send(res, 200, await getProjects()); }
    catch (e) { return send(res, 503, { ok: false, msg: e.message }); }
  }

  if (req.method === 'GET' && p === '/api/logs') {
    const type = url.searchParams.get('type');
    const name = url.searchParams.get('name');
    if (!NAME_RE.test(name || '') || !['systemd', 'docker'].includes(type)) return send(res, 400, { ok: false, msg: '无效的服务参数' });
    const projects = await getProjects().catch(() => null);
    if (!projects) return send(res, 503, { ok: false, msg: '服务列表暂不可用' });
    if (!projects[type].some(s => s.name === name)) return send(res, 403, { ok: false, msg: '服务不在允许列表' });
    const result = type === 'systemd'
      ? await exec('/usr/bin/journalctl', ['-u', name, '-n', '150', '--no-pager', '-o', 'short-iso'], 10000)
      : await exec('/usr/bin/docker', ['logs', '--tail', '150', '--timestamps', name], 10000);
    if (result.err) return send(res, 500, { ok: false, msg: '日志读取失败，请检查服务状态' });
    return send(res, 200, { ok: true, logs: (result.stdout + (result.stderr ? '\n' + result.stderr : '')).slice(-120000) });
  }


  if (req.method === 'GET' && p === '/api/docker/config') {
    try {
      const c = await inspectContainer(url.searchParams.get('name'));
      const policy = c.HostConfig.RestartPolicy;
      return send(res, 200, {ok:true, name:c.Name.slice(1), image:c.Config.Image,
        restart:policy.Name + (policy.Name === 'on-failure' && policy.MaximumRetryCount ? ':'+policy.MaximumRetryCount : ''),
        compose:!!c.Config.Labels?.['com.docker.compose.project']});
    } catch(e) { return send(res, 400, {ok:false,msg:e.message}); }
  }
  if (req.method === 'POST' && ['/api/docker/create','/api/docker/update'].includes(p)) {
    let b;
    try { b = JSON.parse(await readBody(req)); if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error(); }
    catch { return send(res,400,{ok:false,msg:'无效请求'}); }
    let args;
    try {
      if (p.endsWith('/create')) args = createArgs(b);
      else if (!DOCKER_NAME.test(b.name || '') || !DOCKER_NAME.test(b.originalName || '') || !RESTART.test(b.restart || '') || config.hiddenContainers.includes(b.name)) throw Error('容器名称或重启策略无效');
    } catch(e) { return send(res,400,{ok:false,msg:e.message}); }
    const keys = [...new Set([b.name,b.originalName].filter(Boolean).map(n=>'docker:'+n))];
    if (keys.some(k=>pendingActions.has(k))) return send(res,409,{ok:false,msg:'容器正在执行操作，请稍后'});
    keys.forEach(k=>pendingActions.add(k));
    try {
      if (args) {
        await dockerCommand(args);
        return send(res,200,{ok:true,msg:'容器已创建，可在卡片中点击启动'});
      }
      const c = await inspectContainer(b.originalName);
      if (c.Config.Labels?.['com.docker.compose.project'] && b.name !== b.originalName) return send(res,409,{ok:false,msg:'Compose 管理的容器请在 Compose 配置中修改名称'});
      const old = c.HostConfig.RestartPolicy;
      const oldPolicy = old.Name + (old.Name === 'on-failure' && old.MaximumRetryCount ? ':'+old.MaximumRetryCount : '');
      await dockerCommand(['update','--restart',b.restart,c.Id]);
      if (b.name !== b.originalName) {
        try { await dockerCommand(['rename',c.Id,b.name]); }
        catch(e) {
          try { await dockerCommand(['update','--restart',oldPolicy,c.Id]); }
          catch { throw Error('改名失败，重启策略回滚失败，请重新打开编辑确认当前配置'); }
          throw e;
        }
      }
      return send(res,200,{ok:true,msg:'容器配置已保存'});
    } catch(e) { return send(res,500,{ok:false,msg:e.message}); }
    finally { keys.forEach(k=>pendingActions.delete(k)); invalidateProjects(); }
  }

  // 控制
  if (req.method === 'POST' && p === '/api/action') {
    let body;
    try { body = JSON.parse(await readBody(req)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body'); } catch { return send(res, 400, { ok: false, msg: '无效请求' }); }
    const { type, name, action } = body;
    if (!type || !name || !action) return send(res, 400, { ok: false, msg: '缺少参数' });

    if (!NAME_RE.test(name) || !['systemd', 'docker'].includes(type)) return send(res, 400, { ok: false, msg: '无效的服务参数' });
    const allowed = type === 'systemd' ? SYSTEMD_ACTIONS : DOCKER_ACTIONS;
    if (!allowed.has(action)) return send(res, 400, { ok: false, msg: '不支持的操作' });
    if (type === 'systemd' && name === SELF_UNIT) return send(res, 409, { ok: false, msg: '面板自身受保护，请通过 SSH 管理' });
    const key = type + ':' + name;
    if (pendingActions.has(key)) return send(res, 409, { ok: false, msg: '该服务正在执行操作，请稍后' });
    pendingActions.add(key);
    try {
      const projects = await getProjects();
      if (!projects[type].some(s => s.name === name)) return send(res, 403, { ok: false, msg: '服务不在允许列表' });
      const result = await (type === 'systemd' ? controlSystemd(name, action) : controlDocker(name, action));
      return send(res, result.ok ? 200 : 500, result);
    } catch (e) { return send(res, 500, { ok: false, msg: e.message }); }
    finally { pendingActions.delete(key); invalidateProjects(); }
  }

  send(res, 404, { ok: false, msg: 'Not Found' });
});

const ssh=require('./ssh')({server,config,send,readBody,verifyPassword,sessionValid});
server.requestTimeout=30000;
server.headersTimeout=15000;
server.listen(PORT, HOST, () => {
  loadSessions();
  if (process.env.PANEL_DISABLE_MONITOR !== '1') operations.start();
  console.log(`[panel] 服务管理面板已启动: http://${HOST}:${PORT}`);
  if (!config.passwordHash || !config.salt) {
    console.log('[panel] 警告: 未配置密码! 请运行 node scripts/setup-password.cjs 设置登录密码。');
  }
});
