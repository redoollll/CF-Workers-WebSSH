import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const app = document.getElementById('app') as HTMLElement;
app.hidden = false;
app.replaceChildren();

app.className = 'local-terminal-app';
const themeStyle = document.createElement('style');
themeStyle.textContent = `
  html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body { background: #080c10; }
  * { box-sizing: border-box; }
  .local-terminal-app { display: grid; grid-template-rows: 44px minmax(0, 1fr); height: 100%; color: #d8e2ea; font-family: "Noto Sans CJK SC", sans-serif; }
  .local-terminal-header { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 16px; padding: 0 12px; border-bottom: 1px solid #26323b; background: #10161b; }
  .local-terminal-brand { font-weight: 700; }
  .local-terminal-brand span { color: #5bd5a5; font-family: monospace; }
  .local-terminal-status[data-state="connected"] { color: #5bd5a5; }
  .local-terminal-status[data-state="disconnected"] { color: #e89a9a; }
  .local-terminal-header button, .login-button { border: 1px solid #33414b; border-radius: 4px; padding: 7px 12px; color: inherit; background: transparent; cursor: pointer; }
  .local-terminal-main, .local-terminal { height: 100%; min-height: 0; }
  .local-terminal { padding: 8px; }
  .local-terminal-main:fullscreen { background: #080c10; }
  .login-view { grid-row: 1 / 3; display: grid; place-items: center; background: radial-gradient(circle at top, #17232b, #080c10 52%); }
  .login-panel { width: min(360px, calc(100vw - 32px)); padding: 28px; border: 1px solid #26323b; border-radius: 8px; background: #10161b; box-shadow: 0 24px 80px #0008; }
  .login-panel h1 { margin: 0 0 8px; font-size: 22px; }
  .login-panel p { margin: 0 0 22px; color: #91a1ad; }
  .login-panel label { display: block; margin-bottom: 8px; }
  .login-panel input { width: 100%; height: 42px; border: 1px solid #364650; border-radius: 4px; padding: 0 12px; color: #fff; background: #080c10; outline: none; }
  .login-panel input:focus { border-color: #5bd5a5; }
  .login-button { width: 100%; margin-top: 14px; border-color: #5bd5a5; color: #06130e; background: #5bd5a5; font-weight: 700; }
  .login-error { min-height: 20px; margin-top: 12px !important; color: #ff8d8d !important; }
`;
document.head.append(themeStyle);

async function authenticated(): Promise<boolean> {
  const response = await fetch('/api/auth', { credentials: 'same-origin' });
  return response.ok;
}

function showLogin() {
  app.className = 'login-view';
  app.innerHTML = `
    <form class="login-panel">
      <h1>&gt;_ 服务器终端</h1>
      <p>请输入后台密码</p>
      <label for="local-terminal-password">密码</label>
      <input id="local-terminal-password" name="password" type="password" autocomplete="current-password" required autofocus />
      <button class="login-button" type="submit">登录终端</button>
      <p id="login-error" class="login-error" role="alert"></p>
    </form>
  `;

  const form = app.querySelector('form') as HTMLFormElement;
  const passwordInput = document.getElementById('local-terminal-password') as HTMLInputElement;
  const errorElement = document.getElementById('login-error') as HTMLElement;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.textContent = '';
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    if (!response.ok) {
      errorElement.textContent = '密码错误，请重试';
      passwordInput.select();
      return;
    }
    startTerminal();
  });
}

function startTerminal() {
  app.className = 'local-terminal-app';
  app.innerHTML = `
    <header class="local-terminal-header">
      <div class="local-terminal-brand"><span>&gt;_</span> 本机终端</div>
      <div id="local-terminal-status" class="local-terminal-status">正在连接服务器...</div>
      <button id="local-terminal-fullscreen" type="button">全屏</button>
    </header>
    <main id="local-terminal-main" class="local-terminal-main">
      <div id="local-terminal" class="local-terminal" role="application" aria-label="服务器终端"></div>
    </main>
  `;

  const terminalElement = document.getElementById('local-terminal') as HTMLElement;
  const statusElement = document.getElementById('local-terminal-status') as HTMLElement;
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
    fontSize: 15,
    scrollback: 5000,
    theme: { background: '#080c10', foreground: '#d8e2ea', cursor: '#5bd5a5' },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(terminalElement);
  fitAddon.fit();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let shouldReconnect = true;

  function sendResize() {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }
  }

  function connect() {
    const activeSocket = new WebSocket(`${protocol}//${location.host}/api/local-terminal`);
    socket = activeSocket;
    activeSocket.onopen = () => {
      statusElement.textContent = '已连接到服务器';
      statusElement.dataset.state = 'connected';
      terminal.focus();
      sendResize();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
    activeSocket.onmessage = (event) => {
      if (typeof event.data === 'string') terminal.write(event.data);
      else void event.data.text().then((text: string) => terminal.write(text));
    };
    activeSocket.onclose = () => {
      statusElement.textContent = '连接已断开，正在重连...';
      statusElement.dataset.state = 'disconnected';
      if (shouldReconnect) reconnectTimer = window.setTimeout(connect, 1500);
    };
    activeSocket.onerror = () => activeSocket.close();
  }

  terminal.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
  });
  terminal.onResize(() => sendResize());
  const fit = () => { fitAddon.fit(); sendResize(); };
  const resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(terminalElement);
  window.addEventListener('resize', fit);

  document.getElementById('local-terminal-fullscreen')?.addEventListener('click', async () => {
    const main = document.getElementById('local-terminal-main') as HTMLElement;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await main.requestFullscreen();
  });
  document.addEventListener('fullscreenchange', fit);
  window.addEventListener('beforeunload', () => { shouldReconnect = false; socket?.close(); });
  connect();
}

void authenticated().then((isAuthenticated) => isAuthenticated ? startTerminal() : showLogin());
