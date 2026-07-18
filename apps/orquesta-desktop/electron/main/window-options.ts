import type { BrowserWindowConstructorOptions } from 'electron';

export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#efede8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}

export function createSplashWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 320,
    height: 220,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}

export function splashDocument(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden;font-family:Segoe UI,Arial,sans-serif;color:#171715}
body{display:grid;place-items:center}.mark{display:grid;place-items:center;gap:14px;filter:drop-shadow(0 12px 24px rgba(31,27,20,.12))}
.nodes{position:relative;width:118px;height:104px}.node{position:absolute;width:25px;height:25px;border:1.5px solid #171715;border-radius:50%;background:#f4f1ea}
.node:nth-child(1){left:46px;top:0}.node:nth-child(2){left:46px;top:39px}.node:nth-child(3){left:10px;top:78px}.node:nth-child(4){left:82px;top:78px}
.edge{position:absolute;width:1.5px;background:#171715;transform-origin:top}.edge.a{left:59px;top:26px;height:14px}.edge.b{left:58px;top:64px;height:39px;transform:rotate(43deg)}.edge.c{left:60px;top:64px;height:39px;transform:rotate(-43deg)}
strong{font-size:13px;letter-spacing:.34em;font-weight:650}.line{width:156px;border-top:1px dotted rgba(23,23,21,.42)}
@media(prefers-reduced-motion:no-preference){.mark{animation:enter .28s ease-out both}@keyframes enter{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}}
</style></head><body><main class="mark" aria-label="Orquesta"><div class="nodes"><i class="edge a"></i><i class="edge b"></i><i class="edge c"></i><i class="node"></i><i class="node"></i><i class="node"></i><i class="node"></i></div><div class="line"></div><strong>ORQUESTA</strong></main></body></html>`;
}
