/**
 * Runs a command while busy-loop processes compete with it for one CPU core.
 *
 *   bun scripts/test-under-contention.ts [--core N] [--burners K] [--duration S] -- <command...>
 *
 * A flake that only shows under aggregate load is reproduced by starving the
 * test of CPU, not by loading the whole host. On Linux with `taskset`, the
 * burners and the command are pinned to the same core (the last one by
 * default), so the command gets roughly 1/(K+1) of one core and the rest of the
 * host is left alone. Elsewhere the burners run unpinned and compete for the
 * whole machine, which is a weaker condition; the runner says so.
 *
 * The runner stops only the burners it spawned, through the handles it holds,
 * whether the command passes, fails, is interrupted or the runner throws. Each
 * burner also exits on its own when its parent changes (the runner was killed)
 * or its deadline passes, so even a SIGKILLed runner leaves nothing spinning.
 *
 * Combine it with the logged runner:
 *
 *   mise run test:logged -- --name repro -- \
 *     bun scripts/test-under-contention.ts -- bun test path/to/x.test.ts --rerun-each=5
 */
import os from "node:os";
import process from "node:process";

export const DEFAULT_BURNERS = 6;
/** Burners outlive no runner by more than this, even without `--duration`. */
export const BURNER_SAFETY_DEADLINE_SECONDS = 6 * 60 * 60;
/** Test hook: when set, the runner prints its burner PIDs to stderr once they start. */
export const ANNOUNCE_ENV = "ORKESTRATOR_CONTENTION_ANNOUNCE";
const COMMAND_STOP_GRACE_MS = 5_000;

export class UsageError extends Error {}

export interface ContentionOptions {
  /** Core to pin to; `undefined` means the last core. */
  core?: number;
  burners: number;
  /** Seconds the burners run; `undefined` means until the command exits. */
  durationSeconds?: number;
  command: string[];
}

export const USAGE =
  "Usage: bun scripts/test-under-contention.ts [--core N] [--burners K] [--duration S] -- <command...>";

function integerOption(name: string, value: string | undefined, minimum: number): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new UsageError(`${name} needs a whole number, got ${value ?? "nothing"}`);
  }
  const parsed = Number(value);
  if (parsed < minimum) throw new UsageError(`${name} must be at least ${minimum}, got ${parsed}`);
  return parsed;
}

/**
 * Options come first; the command starts after `--` or at the first token that
 * is not an option. Bun drops a `--` that directly follows the script path, so
 * `-- bun test x` and `bun test x` both arrive here as a bare command.
 */
export function parseArguments(argv: readonly string[]): ContentionOptions {
  const options: ContentionOptions = { burners: DEFAULT_BURNERS, command: [] };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    const [flag, inline] = token.includes("=") ? token.split(/=(.*)/s, 2) : [token, undefined];
    const takeValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      return argv[index];
    };
    switch (flag) {
      case "--core":
        options.core = integerOption("--core", takeValue(), 0);
        break;
      case "--burners":
        options.burners = integerOption("--burners", takeValue(), 0);
        break;
      case "--duration":
        options.durationSeconds = integerOption("--duration", takeValue(), 1);
        break;
      case "-h":
      case "--help":
        throw new UsageError(USAGE);
      default:
        throw new UsageError(`Unknown option ${token}\n${USAGE}`);
    }
    index += 1;
  }
  options.command = argv.slice(index);
  if (options.command.length === 0) throw new UsageError(`No command given\n${USAGE}`);
  return options;
}

export interface Platform {
  /** Path to `taskset`, or `undefined` when pinning is unavailable. */
  taskset: string | undefined;
  cores: number;
}

export function detectPlatform(): Platform {
  const taskset = process.platform === "linux" ? (Bun.which("taskset") ?? undefined) : undefined;
  return { taskset, cores: os.cpus().length || os.availableParallelism() };
}

/**
 * The busy loop each burner runs. It checks the clock and its parent between
 * short spins, so it exits on its own once the deadline passes or the runner
 * that spawned it is gone (it has been reparented).
 */
export function burnerSource(deadlineSeconds: number): string {
  return [
    `const end = Date.now() + ${deadlineSeconds * 1000};`,
    "const parent = process.ppid;",
    "for (;;) {",
    "  for (let i = 0; i < 2e6; i += 1);",
    "  if (Date.now() >= end || process.ppid !== parent) process.exit(0);",
    "}",
  ].join("\n");
}

export interface ContentionResult {
  exitCode: number;
  pinned: boolean;
  core: number | undefined;
  burnerPids: number[];
  elapsedMs: number;
}

export interface RunHooks {
  platform?: Platform;
  /** Spawns the command; injected by tests to fail after the burners start. */
  spawnCommand?: (cmd: string[]) => Bun.Subprocess;
  /** Called once the burners are running. */
  onBurnersStarted?: (pids: number[]) => void;
  /** Receives warnings and the summary line; defaults to stderr. */
  log?: (line: string) => void;
  /** Signals that interrupt the run; defaults to SIGINT and SIGTERM. */
  signals?: NodeJS.Signals[];
}

function signalExitCode(signal: string | number | null | undefined): number {
  const number =
    typeof signal === "number"
      ? signal
      : signal
        ? os.constants.signals[signal as NodeJS.Signals]
        : undefined;
  return number === undefined ? 1 : 128 + number;
}

async function stopBurners(burners: Bun.Subprocess[]): Promise<void> {
  for (const burner of burners) {
    if (burner.exitCode === null && burner.signalCode === null) burner.kill("SIGKILL");
  }
  await Promise.all(burners.map((burner) => burner.exited.catch(() => undefined)));
}

/** Runs the command under contention and returns its exit status. Never leaves a burner running. */
export async function runUnderContention(
  options: ContentionOptions,
  hooks: RunHooks = {},
): Promise<ContentionResult> {
  const platform = hooks.platform ?? detectPlatform();
  const log = hooks.log ?? ((line: string) => console.error(line));
  const pinned = platform.taskset !== undefined;
  let core: number | undefined;
  if (pinned) {
    core = options.core ?? platform.cores - 1;
    if (core >= platform.cores) {
      throw new UsageError(`--core ${core} does not exist; this host has ${platform.cores} cores`);
    }
  } else {
    log(
      `contention: taskset is unavailable on ${process.platform}; ${options.burners} burners run ` +
        "unpinned and compete with the whole host, which is a weaker condition than one shared core",
    );
  }
  const pin = (cmd: string[]) => (pinned ? [platform.taskset!, "-c", String(core), ...cmd] : cmd);

  const burners: Bun.Subprocess[] = [];
  const startedAt = Date.now();
  let command: Bun.Subprocess | undefined;
  let interrupted: NodeJS.Signals | undefined;
  let wake: () => void = () => undefined;
  const interruption = new Promise<void>((resolve) => (wake = resolve));
  const running = (child: Bun.Subprocess) => child.exitCode === null && child.signalCode === null;
  const signals = hooks.signals ?? ["SIGINT", "SIGTERM"];
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    // The command gets the signal it would have had without this runner; the
    // burners are stopped in `finally`.
    if (command && running(command)) command.kill(signal);
    wake();
  };
  for (const signal of signals) process.on(signal, onSignal);

  let exitCode = 1;
  const finish = (code: number): ContentionResult => {
    exitCode = code;
    return {
      exitCode: code,
      pinned,
      core,
      burnerPids: burners.map((burner) => burner.pid),
      elapsedMs: Date.now() - startedAt,
    };
  };
  try {
    const deadline = options.durationSeconds ?? BURNER_SAFETY_DEADLINE_SECONDS;
    for (let count = 0; count < options.burners; count += 1) {
      burners.push(
        Bun.spawn({
          cmd: pin([process.execPath, "-e", burnerSource(deadline)]),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
    }
    hooks.onBurnersStarted?.(burners.map((burner) => burner.pid));
    if (interrupted) return finish(signalExitCode(interrupted));

    const spawnCommand =
      hooks.spawnCommand ??
      ((cmd: string[]) =>
        Bun.spawn({ cmd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }));
    try {
      command = spawnCommand(pin(options.command));
    } catch (error) {
      log(`contention: could not start ${options.command[0]}: ${(error as Error).message}`);
      return finish(127);
    }
    // A signal that landed while the command was being spawned had no child to reach.
    if (interrupted !== undefined) command.kill(interrupted);

    await Promise.race([command.exited, interruption]);
    if (interrupted !== undefined && running(command)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        command.exited,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, COMMAND_STOP_GRACE_MS))),
      ]);
      clearTimeout(timer);
      // It ignored the forwarded signal; it is our own child, so end it.
      if (running(command)) command.kill("SIGKILL");
      await command.exited;
    }
    if (interrupted !== undefined) return finish(signalExitCode(interrupted));
    return finish(command.exitCode ?? signalExitCode(command.signalCode));
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    await stopBurners(burners);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(
      `contention: core=${pinned ? core : "unpinned"} burners=${options.burners} ` +
        `elapsed=${elapsed}s exit=${exitCode}`,
    );
  }
}

if (import.meta.main) {
  let options: ContentionOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
  try {
    const outcome = await runUnderContention(options, {
      onBurnersStarted: process.env[ANNOUNCE_ENV]
        ? (pids) => console.error(`contention-burners ${pids.join(",")}`)
        : undefined,
    });
    process.exitCode = outcome.exitCode;
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : error);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
