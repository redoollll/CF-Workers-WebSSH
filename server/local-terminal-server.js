import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const root = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const loginPassword = '123123123';
const sessions = new Set();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sessionFromRequest(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('local_terminal_session='));
  return match ? match.slice('local_terminal_session='.length) : '';
}

function authorized(request) {
  return sessions.has(sessionFromRequest(request));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok', runtime: 'local-server', localTerminal: true });
    return;
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let password = '';
      try { password = JSON.parse(body).password; } catch { /* handled below */ }
      password = String(password ?? '').trim();
      if (password !== loginPassword) {
        sendJson(response, 401, { error: '密码错误' });
        return;
      }
      const session = randomBytes(32).toString('hex');
      sessions.add(session);
      response.setHeader('Set-Cookie', `local_terminal_session=${session}; Path=/; HttpOnly; SameSite=Strict`);
      sendJson(response, 200, { ok: true });
    });
    return;
  }

  if (url.pathname === '/api/auth' && request.method === 'GET') {
    sendJson(response, authorized(request) ? 200 : 401, { authenticated: authorized(request) });
    return;
  }

  if (url.pathname.startsWith('/api/') && !authorized(request)) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  pathname = normalize(pathname).replace(/^([/\\])+/, '');
  let filePath = join(root, pathname);

  try {
    if (!(await stat(filePath)).isFile()) throw new Error('Not a file');
  } catch {
    filePath = join(root, 'index.html');
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:",
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
});

const sockets = new WebSocketServer({ server, path: '/api/local-terminal' });

sockets.on('connection', (socket, request) => {
  if (!authorized(request)) {
    socket.close(1008, 'Unauthorized');
    return;
  }

  let shell = process.env.SHELL || '/bin/bash';
  if (process.platform === 'win32') shell = process.env.COMSPEC || 'powershell.exe';

  const shellProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.LOCAL_TERMINAL_CWD || process.cwd(),
    env: process.env,
  });

  shellProcess.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  });

  shellProcess.onExit(() => socket.close(1000, 'Shell exited'));

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'input') shellProcess.write(String(message.data ?? ''));
    if (message.type === 'resize') {
      const cols = Number(message.cols);
      const rows = Number(message.rows);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        shellProcess.resize(Math.min(cols, 500), Math.min(rows, 200));
      }
    }
  });

  socket.on('close', () => shellProcess.kill());
  socket.on('error', () => shellProcess.kill());
});

server.listen(port, host, () => {
  console.log(`Local terminal listening on http://${host}:${port}`);
  console.warn('This terminal executes commands with the permissions of the server process. Restrict network access.');
});
