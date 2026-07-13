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
};

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
        if (dataListeners.size === 0) {
          pendingData.push(data);
          return;
        }
        for (const listener of dataListeners) listener(data);
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
    const trailingData = decoder.decode();
    if (trailingData) {
      if (dataListeners.size === 0) pendingData.push(trailingData);
      else for (const listener of dataListeners) listener(trailingData);
    }
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
