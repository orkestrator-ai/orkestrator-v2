import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { FORBIDDEN_PORTS, SetupError } from "./harness.ts";
import { watchChild } from "./owned-process.ts";

const SSH = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ControlPath=none",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPersist=no",
  "-o",
  "ForkAfterAuthentication=no",
];

const REMOTE_ROOT = /^\/tmp\/ork-capabilities-2m-[0-9a-f]{32}$/u;
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function runOwned(
  executable: string,
  args: string[],
  options: {
    input?: Buffer | string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Buffer> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 120_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const owned = watchChild(child);
  const stdout: Buffer[] = [];
  let bytes = 0;
  let stderr = "";
  let overflow = false;
  const stopFailure = Promise.withResolvers<never>();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= owned.stop();
    void stopping.catch(stopFailure.reject);
  };
  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxBytes ?? 16 << 20)) {
      overflow = true;
      stop();
    } else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 800) stderr += chunk.toString().slice(0, 800 - stderr.length);
  });
  // A failed/rejected child can close stdin before receiving all of the archive.
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input);
  try {
    if (signal.aborted) stop();
    const result = await Promise.race([owned.done, stopFailure.promise]);
    options.signal?.throwIfAborted();
    if (result.code !== 0 || overflow || signal.aborted) {
      throw new SetupError(
        `${executable} failed (${result.error?.message ?? result.code ?? result.signal}): ${overflow ? "output exceeded its limit" : stderr.trim()}`,
      );
    }
    return Buffer.concat(stdout, bytes);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export function openTunnel(
  localPort: number,
  remotePort: number,
  host: string,
  start: (args: string[]) => ChildProcess = (args) => spawn("ssh", args, { stdio: "ignore" }),
) {
  return watchChild(
    start([
      ...SSH,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "PermitLocalCommand=no",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      "--",
      host,
    ]),
  );
}

export function forwardRefusesConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 2_000 });
    const finish = (closed: boolean) => {
      socket.destroy();
      resolve(closed);
    };
    socket.once("connect", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"));
  });
}

export function ssh(
  host: string,
  command: string,
  input: Buffer | string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  return runOwned("ssh", [...SSH, "-o", "ClearAllForwardings=yes", "--", host, command], {
    input,
    timeoutMs,
    signal,
  }).then((output) => output.toString());
}

type RemoteCommand = typeof ssh;
type Worker = "install" | "backend";

/** A known, exclusive directory even when the SSH allocation reply is lost. */
export class RemoteCapabilityRun {
  readonly root: string;
  private readonly owner = randomBytes(24).toString("hex");
  private readonly prelude: string;

  constructor(
    private readonly host: string,
    id = randomBytes(16).toString("hex"),
    private readonly runCommand: RemoteCommand = ssh,
  ) {
    this.root = `/tmp/ork-capabilities-2m-${id}`;
    if (!REMOTE_ROOT.test(this.root)) throw new SetupError("Invalid remote run identifier.");
    this.prelude = `R=${shellQuote(this.root)}
OWNER=${shellQuote(this.owner)}
owned() {
  [[ -d "$R" && ! -L "$R" && -f "$R/.owner" && ! -L "$R/.owner" ]] &&
    [[ "$(cat "$R/.owner")" == "$OWNER" ]]
}
lock_run() {
  owned || { echo "remote run ownership could not be verified" >&2; exit 1; }
  exec 9<"$R"
  flock -w 8 9
  owned || { echo "remote run disappeared or changed" >&2; exit 1; }
}
# /proc stat after the final ') ' starts at field 3; field 22 is index 19.
birth() {
  local stat
  local -a fields
  IFS= read -r stat <"/proc/$1/stat" || return 1
  read -r -a fields <<<"\${stat##*) }"
  [[ "\${fields[2]}" == "$1" && "\${fields[3]}" == "$1" ]] || return 1
  printf '%s\\n' "\${fields[19]}"
}
worker_is_ours() {
  [[ "$(birth "$1" 2>/dev/null)" == "$2" ]] &&
    grep -zFxq -- "$R/$3.sh" "/proc/$1/cmdline" 2>/dev/null
}`;
  }

  private async script(body: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return this.runCommand(
      this.host,
      "bash -s",
      `set -euo pipefail
umask 077
${this.prelude}
${body}
`,
      timeoutMs,
      signal,
    );
  }

  async allocate(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // Let this short ownership transaction settle on interrupt. HUP can arrive
    // as soon as the transport loses the response.
    const reply = await this.script(
      `trap '' HUP
mkdir -m 700 -- "$R"
printf '%s\\n' "$OWNER" >"$R/.owner"
printf '%s\\n' "$R"`,
      20_000,
    );
    signal?.throwIfAborted();
    if (reply.trim() !== this.root) throw new SetupError("Unexpected remote allocation response.");
  }

  run(body: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<string> {
    return this.script(
      `owned || exit 1
${body}`,
      timeoutMs,
      signal,
    );
  }

  upload(body: string, input: Buffer | string, signal?: AbortSignal): Promise<string> {
    const script = `set -euo pipefail
umask 077
${this.prelude}
lock_run
${body}`;
    return this.runCommand(this.host, `bash -c ${shellQuote(script)}`, input, 300_000, signal);
  }

  async launch(kind: Worker, body: string, duration: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // Hold the directory lock through PID publication so cleanup cannot race a
    // half-launched worker or a lost start response. The worker does not inherit it.
    const reply = await this.script(
      `trap '' HUP
lock_run
REAL_BUN="$HOME/.local/share/mise/installs/bun/1.4.4/bin/bun"
mkdir -p "$R/home" "$R/tmp" "$R/bun-cache" "$R/data" "$R/worktrees"
cat >"$R/${kind}.sh" <<'ORK_WORKER'
set -euo pipefail
${body}
ORK_WORKER
setsid timeout --kill-after=10s ${duration} env -i \\
  PATH="$(dirname "$REAL_BUN"):/usr/bin:/bin:/usr/sbin:/sbin" LANG="\${LANG:-C.UTF-8}" \\
  HOME="$R/home" TMPDIR="$R/tmp" XDG_CONFIG_HOME="$R/home/.config" \\
  XDG_DATA_HOME="$R/home/.local/share" XDG_CACHE_HOME="$R/home/.cache" \\
  BUN_INSTALL_CACHE_DIR="$R/bun-cache" BUN_INSTALL_GLOBAL_STORE=0 \\
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CI=1 \\
  GIT_CONFIG_NOSYSTEM=1 ORKESTRATOR_HOST_REACHABILITY_CHECK=off \\
  RUN_ROOT="$R" REAL_BUN="$REAL_BUN" \\
  bash "$R/${kind}.sh" </dev/null >"$R/${kind}.log" 2>&1 9<&- &
PID=$!
for _ in $(seq 1 50); do
  START="$(birth "$PID" 2>/dev/null)" || START=""
  if [[ -n "$START" ]] && worker_is_ours "$PID" "$START" "${kind}"; then
    printf '%s %s\\n' "$PID" "$START" >"$R/${kind}.pid"
    printf 'started\\n'
    exit 0
  fi
  sleep 0.02
done
echo "remote ${kind} worker did not start" >&2
exit 1`,
      20_000,
    );
    signal?.throwIfAborted();
    if (reply.trim() !== "started")
      throw new SetupError(`Unexpected remote ${kind} launch response.`);
  }

  async cleanup(keep: boolean): Promise<"absent" | "kept" | "removed"> {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = (
          await this.script(
            `trap '' HUP
if [[ ! -e "$R" && ! -L "$R" ]]; then echo absent; exit 0; fi
lock_run
session_live() {
  local sessions
  sessions="$(ps -eo sid=,stat=)" || exit 1
  awk -v sid="$1" '$1 == sid && $2 !~ /^Z/ { found = 1 } END { exit !found }' <<<"$sessions"
}
for kind in install backend; do
  file="$R/$kind.pid"
  [[ ! -L "$file" ]] || exit 1
  [[ -f "$file" ]] || continue
  read -r PID START <"$file"
  [[ "$PID" =~ ^[1-9][0-9]+$ && "$START" =~ ^[0-9]+$ ]] || exit 1
  if worker_is_ours "$PID" "$START" "$kind"; then
    kill -TERM -- "-$PID" || ! session_live "$PID"
    for _ in $(seq 1 20); do
      if ! session_live "$PID"; then break; fi
      sleep 0.25
    done
    if worker_is_ours "$PID" "$START" "$kind"; then
      kill -KILL -- "-$PID" || ! session_live "$PID"
      for _ in $(seq 1 20); do
        if ! session_live "$PID"; then break; fi
        sleep 0.25
      done
    fi
  fi
  if session_live "$PID"; then echo "remote $kind session still exists or could not be identified" >&2; exit 1; fi
done
rm -f -- "$R/token"
[[ ! -e "$R/token" && ! -L "$R/token" ]]
${
  keep
    ? "echo kept"
    : `owned
rm -rf -- "$R"
[[ ! -e "$R" && ! -L "$R" ]]
echo removed`
}`,
            45_000,
          )
        ).trim();
        if (result === "absent" || result === (keep ? "kept" : "removed")) return result;
        throw new SetupError("Unexpected remote cleanup response.");
      } catch (error) {
        failure = error;
      }
    }
    throw new SetupError(
      `Cleanup could not be verified for ${this.host}:${this.root}: ${String(failure)}`,
    );
  }
}

export function skillCopiesScript(name: string): string {
  return `home="$R/data/capability-test-home"
if [[ -e "$home" || -L "$home" ]]; then
  find "$home" -path ${shellQuote(`*/${name}/SKILL.md`)} -type f -print0 |
    xargs -0 -r -n1 sh -c 'printf "%s\\0" "$(cat "$0")"'
fi`;
}

export function remotePortScript(): string {
  return `"$HOME/.local/share/mise/installs/bun/1.4.4/bin/bun" --no-env-file -e '
const forbidden = new Set([${[...FORBIDDEN_PORTS].join(",")}]);
const net = require("node:net");
const ports = [];
while (ports.length < 2) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  if (!forbidden.has(port) && !ports.includes(port)) ports.push(port);
}
console.log(ports.join(" "));
'`;
}

export async function waitForTunnel<T>(
  tunnel: ReturnType<typeof openTunnel>,
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const abort = new AbortController();
  try {
    return await Promise.race([
      tunnel.done.then(({ error, code, signal }) => {
        throw new SetupError(`SSH forward exited: ${error?.message ?? code ?? signal}`);
      }),
      read(AbortSignal.any([signal, abort.signal])),
    ]);
  } finally {
    abort.abort();
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}
