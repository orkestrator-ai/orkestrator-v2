import { desktopStartupMessage } from "@orkestrator/protocol/debug-logging";

type DesktopApi = Pick<NonNullable<Window["orkestrator"]>, "invoke" | "connections">;
type ConnectionResult = "ready" | "bridge-unavailable" | "backend-unavailable";
interface StartupTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
const browserTimer: StartupTimer = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One bounded startup attempt; never overlap or retry a hung IPC request. */
export function waitForDesktopConnection({
  getApi = () => window.orkestrator,
  timeoutMs = 10_000,
  retryDelayMs = 250,
  timer = browserTimer,
}: {
  getApi?: () => DesktopApi | undefined;
  timeoutMs?: number;
  retryDelayMs?: number;
  timer?: StartupTimer;
} = {}): Promise<ConnectionResult> {
  return new Promise((resolve) => {
    let finished = false;
    let retry: unknown;
    let failure: ConnectionResult = "bridge-unavailable";
    const finish = (result: ConnectionResult) => {
      if (finished) return;
      finished = true;
      timer.clear(deadline);
      if (retry !== undefined) timer.clear(retry);
      resolve(result);
    };
    const deadline = timer.set(() => finish(failure), timeoutMs);
    const attempt = async () => {
      try {
        const api = getApi();
        failure = "bridge-unavailable";
        if (typeof api?.invoke === "function" && typeof api.connections?.list === "function") {
          // This round trip proves the preload and trusted IPC route both work.
          const connections = await api.connections.list();
          if (finished) return;
          failure = "backend-unavailable";
          // Remote connection recovery/settings remain accessible when a remote
          // host is offline. Local must answer before its workspace is mounted.
          if (connections.activeConnectionId === "local") {
            if (!connections.localAvailable) throw new Error("Local backend unavailable");
            await api.invoke("get_config");
          }
          finish("ready");
          return;
        }
      } catch {
        // Requests and their responses can contain private data. Only the
        // phase is reported, once the bounded recovery attempt has expired.
      }
      if (!finished) retry = timer.set(() => void attempt(), retryDelayMs);
    };
    void attempt();
  });
}

export function isDesktopRenderer(target: Pick<Window, "location" | "navigator">): boolean {
  // A missing preload cannot identify itself. Packaged windows use file:;
  // development Electron windows use HTTP and carry Electron's user agent.
  return target.location.protocol === "file:" || /\bElectron\//.test(target.navigator.userAgent);
}

function showStartupScreen(document: Document, failed: boolean, reload: () => void): void {
  const root = document.getElementById("root");
  if (!root) return;
  const panel = document.createElement("main");
  panel.className =
    "flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-8 text-center text-foreground";
  panel.setAttribute("role", failed ? "alert" : "status");
  const heading = document.createElement("h1");
  heading.className = "text-xl font-semibold";
  heading.textContent = failed ? "Orkestrator couldn’t connect" : "Starting Orkestrator…";
  const description = document.createElement("p");
  description.className = "max-w-md text-sm text-muted-foreground";
  description.textContent = failed
    ? "The app couldn’t finish starting. Reload the window to try again. If this continues, quit and reopen Orkestrator."
    : "Connecting to your workspace…";
  panel.append(heading, description);
  if (failed) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2";
    button.textContent = "Reload window";
    button.addEventListener("click", reload);
    panel.append(button);
  }
  root.replaceChildren(panel);
}

export async function startDesktopRenderer({
  start,
  target = window,
  connect = waitForDesktopConnection,
}: {
  start(): Promise<void>;
  target?: Pick<Window, "location" | "navigator" | "document">;
  connect?: () => Promise<ConnectionResult>;
}): Promise<void> {
  const desktop = isDesktopRenderer(target);
  try {
    if (desktop) {
      showStartupScreen(target.document, false, () => target.location.reload());
      console.info(desktopStartupMessage("checking"));
      const result = await connect();
      if (result !== "ready") {
        console.error(desktopStartupMessage(result));
        showStartupScreen(target.document, true, () => target.location.reload());
        return;
      }
      console.info(desktopStartupMessage("ready"));
    }
    await start();
  } catch {
    console.error(desktopStartupMessage("renderer-load-failed"));
    showStartupScreen(target.document, true, () => target.location.reload());
  }
}
