export type PtyExitEvent = {
  exitCode: number;
  signal?: number;
};

export type PtyDisposable = {
  dispose: () => void;
};

export type PtyProcess = {
  readonly pid: number;
  onData: (callback: (data: string) => void) => PtyDisposable;
  onExit: (callback: (event: PtyExitEvent) => void) => PtyDisposable;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

export type SpawnPtyOptions = {
  cwd?: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
  /** Coalescing window in milliseconds. 0 disables coalescing (tests). */
  coalesceMs?: number;
};

/**
 * Chunks produced within this window after a delivery are concatenated into a
 * single listener call.
 *
 * The kernel hands Bun one read per PTY wake-up, so a fast producer (a build
 * log, `yes`, a large `cat`) fires the data callback hundreds of times a
 * second. Every one of those used to become its own backend event, SSE frame,
 * Electron IPC dispatch and structured clone. One frame per screen refresh is
 * indistinguishable to the user and roughly two orders of magnitude cheaper.
 */
const PTY_COALESCE_WINDOW_MS = 16;

/**
 * Hard ceiling on buffered-but-undelivered characters.
 *
 * Coalescing must not become an unbounded queue: a producer faster than the
 * flush window would otherwise grow the pending buffer without limit. Reaching
 * the cap flushes immediately rather than waiting out the window.
 */
const PTY_MAX_PENDING_CHARS = 256 * 1024;

export function isPtyPlatformSupported(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/**
 * Spawn an interactive process with Bun's runtime-owned PTY.
 *
 * node-pty's native addon can create a process under Bun on macOS, but the
 * master descriptor it exposes is not valid for later ioctl calls. The first
 * resize then fails with EBADF. Keeping PTY ownership inside Bun avoids that
 * cross-runtime descriptor boundary and also makes the standalone backend
 * behave the same way when supervised by Electron or launched on its own.
 */
export function spawnPty(command: string, args: string[], options: SpawnPtyOptions): PtyProcess {
  if (!isPtyPlatformSupported(process.platform)) {
    throw new Error("Orkestrator's Bun PTY does not support Windows. Use macOS or Linux.");
  }
  if (typeof Bun.Terminal !== "function") {
    throw new Error("This Bun version does not support native terminal sessions. Upgrade Bun before starting Orkestrator.");
  }

  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  const pendingData: string[] = [];
  const decoder = new TextDecoder();
  let exitEvent: PtyExitEvent | null = null;

  const coalesceMs = options.coalesceMs ?? PTY_COALESCE_WINDOW_MS;
  /** Chunks accepted during the current coalescing window, in arrival order. */
  const coalescing: string[] = [];
  let coalescingChars = 0;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  const deliver = (data: string) => {
    if (dataListeners.size === 0) {
      // Held, not dropped: this covers the gap between spawning and the caller
      // subscribing, and any tail the kernel hands over after exit. It is
      // deliberately uncapped, unlike the coalescing buffer above — the caller
      // subscribes synchronously and keeps its listener for the life of the
      // session (session retention is bounded there instead), so nothing
      // accumulates here, and trimming it would silently truncate the opening
      // of a terminal the user has not read yet.
      pendingData.push(data);
      return;
    }
    for (const listener of dataListeners) listener(data);
  };

  const flushCoalesced = () => {
    if (coalescing.length === 0) return;
    const data = coalescing.length === 1 ? coalescing[0]! : coalescing.join("");
    coalescing.length = 0;
    coalescingChars = 0;
    deliver(data);
  };

  const stopCoalesceWindow = () => {
    if (!coalesceTimer) return;
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  };

  const openCoalesceWindow = () => {
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      flushCoalesced();
    }, coalesceMs);
    coalesceTimer.unref?.();
  };

  const spawned = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      data(_terminal, bytes) {
        const data = decoder.decode(bytes, { stream: true });
        if (!data) return;
        if (coalesceMs <= 0) {
          deliver(data);
          return;
        }
        // Leading edge: the first chunk after an idle gap ships immediately so
        // interactive echo keeps its latency, and only the burst that follows
        // it is batched.
        if (!coalesceTimer) {
          deliver(data);
          openCoalesceWindow();
          return;
        }
        coalescing.push(data);
        coalescingChars += data.length;
        if (coalescingChars >= PTY_MAX_PENDING_CHARS) {
          stopCoalesceWindow();
          flushCoalesced();
          openCoalesceWindow();
        }
      },
    },
  });

  const terminal = spawned.terminal;
  if (!terminal) {
    spawned.kill();
    throw new Error("Bun did not attach a terminal to the spawned process");
  }

  const notifyExit = (event: PtyExitEvent) => {
    if (exitEvent) return;
    exitEvent = event;
    // Trailing output must reach listeners before the exit callbacks, and the
    // coalescing window must never outlive the process: whatever is still
    // pending is the tail of the session's output and has no later flush.
    stopCoalesceWindow();
    const trailingData = decoder.decode();
    if (trailingData) {
      coalescing.push(trailingData);
      coalescingChars += trailingData.length;
    }
    flushCoalesced();
    for (const listener of exitListeners) listener(event);
    if (!terminal.closed) terminal.close();
  };

  void spawned.exited.then(
    (exitCode) => notifyExit({ exitCode }),
    () => notifyExit({ exitCode: 1 }),
  );

  return {
    pid: spawned.pid,
    onData(callback) {
      dataListeners.add(callback);
      for (const data of pendingData.splice(0)) callback(data);
      return { dispose: () => dataListeners.delete(callback) };
    },
    onExit(callback) {
      exitListeners.add(callback);
      if (exitEvent) queueMicrotask(() => callback(exitEvent!));
      return { dispose: () => exitListeners.delete(callback) };
    },
    write(data) {
      terminal.write(data);
    },
    resize(cols, rows) {
      terminal.resize(cols, rows);
    },
    kill() {
      if (exitEvent) return;
      spawned.kill();
    },
  };
}
