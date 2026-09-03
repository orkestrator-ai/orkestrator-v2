import type { BrowserWindow as BrowserWindowType, BrowserWindowConstructorOptions } from "electron";
import path from "node:path";
import { PRODUCT_NAME } from "./app-constants.js";
import type { ToolchainProgress } from "./toolchain-manager.js";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";

type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindowType;

// Both pages below centre their content with `margin: auto` on a flex child.
// The fixed size these windows ask for is only a request: a tiling compositor
// (Hyprland, sway) ignores it and hands the window the whole tile, which left a
// narrow column of content stranded at the top of an otherwise empty screen and
// the button far from where anyone would look for it. Auto margins centre in
// whatever surface actually arrives, and — unlike `place-items: center` —
// degrade to top-aligned instead of clipping the top out of reach when the
// surface is shorter than the content.

export const BOOTSTRAP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME}</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; padding: 28px; color: #f4f4f5; background: #111113; }
    main { width: min(430px, 100%); margin: auto; }
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

export const PLATFORM_SELECTION_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME} — Choose agent platforms</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; padding: 44px 28px; color: #f4f4f5; background: #101012; }
    main { width: min(570px, 100%); margin: auto; }
    .eyebrow { margin: 0 0 10px; color: #67e8f9; font: 650 11px ui-monospace, SFMono-Regular, monospace; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 27px; font-weight: 680; letter-spacing: -.03em; }
    .intro { margin: 10px 0 24px; color: #a1a1aa; font-size: 14px; line-height: 1.55; }
    fieldset { display: grid; gap: 8px; margin: 0; padding: 0; border: 0; }
    label { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 11px; min-height: 52px; padding: 0 15px; border: 1px solid #2b2b31; border-radius: 10px; background: #18181b; cursor: pointer; }
    label:hover { border-color: #3f3f46; }
    input { width: 17px; height: 17px; accent-color: #22d3ee; }
    .name { font-size: 14px; font-weight: 600; }
    .protocol { color: #71717a; font: 11px ui-monospace, SFMono-Regular, monospace; }
    footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 22px; }
    #error { min-height: 18px; margin: 0; color: #fca5a5; font-size: 12px; }
    button { min-width: 156px; height: 40px; border: 0; border-radius: 9px; color: #062127; background: #67e8f9; font-size: 13px; font-weight: 700; cursor: pointer; }
    button:hover { background: #a5f3fc; }
    button:focus-visible, input:focus-visible { outline: 2px solid #67e8f9; outline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">First-run setup</p>
    <h1>Choose your agent systems</h1>
    <p class="intro">Orkestrator will prepare each selected system and download a verified CLI where one is required. You can change this later under Settings → Platforms.</p>
    <fieldset aria-label="Agent platforms">
      <label><input type="checkbox" value="claude" checked><span class="name">Claude Code</span><span class="protocol">Native + CLI</span></label>
      <label><input type="checkbox" value="codex" checked><span class="name">Codex</span><span class="protocol">Native + CLI</span></label>
      <label><input type="checkbox" value="cursor" checked><span class="name">Cursor Agent</span><span class="protocol">Native SDK</span></label>
      <label><input type="checkbox" value="grok" checked><span class="name">Grok Build</span><span class="protocol">ACP + CLI</span></label>
      <label><input type="checkbox" value="opencode" checked><span class="name">OpenCode</span><span class="protocol">Native + CLI</span></label>
      <label><input type="checkbox" value="pi" checked><span class="name">Pi</span><span class="protocol">Native + CLI</span></label>
    </fieldset>
    <footer><p id="error" role="alert"></p><button id="continue" type="button">Download selected</button></footer>
  </main>
</body>
</html>`;

export async function chooseAgentPlatforms(options: {
  BrowserWindowCtor: BrowserWindowConstructor;
  dirname: string;
}): Promise<AgentPlatform[]> {
  const window = new options.BrowserWindowCtor({
    title: `${PRODUCT_NAME} — Choose agent platforms`,
    width: 650,
    height: 600,
    minWidth: 650,
    minHeight: 600,
    maxWidth: 650,
    maxHeight: 600,
    resizable: false,
    fullscreenable: false,
    backgroundColor: "#101012",
    webPreferences: {
      preload: path.join(options.dirname, "toolchain-bootstrap-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const choice = new Promise<AgentPlatform[]>((resolve, reject) => {
    let settled = false;
    window.webContents.on("ipc-message", (_event, channel, values: unknown) => {
      if (channel !== "orkestrator:agent-platform-selection" || settled) return;
      const selected = Array.isArray(values)
        ? AGENT_PLATFORMS.filter((platform) => values.includes(platform))
        : [];
      if (selected.length === 0) return;
      settled = true;
      resolve(selected);
      if (!window.isDestroyed()) window.close();
    });
    window.once("closed", () => {
      if (!settled) reject(new Error("Agent platform selection was cancelled"));
    });
  });
  // A load/preload failure closes the window before this promise is awaited.
  // Attach a handler now so that close does not become an unhandled rejection.
  void choice.catch(() => undefined);
  const preloadReady = new Promise<void>((_resolve, reject) => {
    window.webContents.once("preload-error", (_event, preloadPath, error) => {
      reject(
        new Error(`Agent platform selection preload failed (${preloadPath}): ${error.message}`),
      );
    });
  });
  try {
    await Promise.race([
      window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PLATFORM_SELECTION_HTML)}`),
      preloadReady,
    ]);
  } catch (error) {
    if (!window.isDestroyed()) window.close();
    throw error;
  }
  return await choice;
}

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
  const preloadReady = new Promise<void>((_resolve, reject) => {
    window.webContents.once("preload-error", (_event, preloadPath, error) => {
      reject(new Error(`Toolchain bootstrap preload failed (${preloadPath}): ${error.message}`));
    });
  });
  try {
    await Promise.race([
      window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOTSTRAP_HTML)}`),
      preloadReady,
    ]);
  } catch (error) {
    if (!window.isDestroyed()) window.close();
    throw error;
  }
  return window;
}

export function reportToolchainProgress(
  window: BrowserWindowType,
  progress: ToolchainProgress,
): void {
  if (window.isDestroyed()) return;
  window.webContents.send("orkestrator:toolchain-progress", progress);
}
