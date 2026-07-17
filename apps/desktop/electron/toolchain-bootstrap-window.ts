import type { BrowserWindow as BrowserWindowType, BrowserWindowConstructorOptions } from "electron";
import path from "node:path";
import { PRODUCT_NAME } from "./app-constants.js";
import type { ToolchainProgress } from "./toolchain-manager.js";

type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindowType;

const BOOTSTRAP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME}</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f4f4f5; background: #111113; }
    main { width: min(430px, calc(100vw - 56px)); }
    .eyebrow { margin: 0 0 12px; color: #a1a1aa; font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: -.025em; }
    #message { min-height: 22px; margin: 20px 0 10px; color: #d4d4d8; font-size: 14px; }
    .track { height: 6px; overflow: hidden; border-radius: 999px; background: #27272a; }
    #progress { width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7c3aed, #a78bfa); transition: width .2s ease; }
    #detail { margin: 9px 0 0; color: #71717a; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">First-run setup</p>
    <h1>Preparing pinned tools</h1>
    <p id="message">Checking the local toolchain cache…</p>
    <div class="track"><div id="progress"></div></div>
    <p id="detail">0 tools ready</p>
  </main>
</body>
</html>`;

export async function createToolchainBootstrapWindow(options: {
  BrowserWindowCtor: BrowserWindowConstructor;
  dirname: string;
}): Promise<BrowserWindowType> {
  const window = new options.BrowserWindowCtor({
    title: `${PRODUCT_NAME} — Preparing tools`,
    width: 520,
    height: 300,
    minWidth: 520,
    minHeight: 300,
    maxWidth: 520,
    maxHeight: 300,
    resizable: false,
    fullscreenable: false,
    backgroundColor: "#111113",
    webPreferences: {
      preload: path.join(options.dirname, "toolchain-bootstrap-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOTSTRAP_HTML)}`);
  return window;
}

export function reportToolchainProgress(window: BrowserWindowType, progress: ToolchainProgress): void {
  if (window.isDestroyed()) return;
  window.webContents.send("orkestrator:toolchain-progress", progress);
}
