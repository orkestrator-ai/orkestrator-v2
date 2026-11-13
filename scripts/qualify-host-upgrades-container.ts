#!/usr/bin/env bun
/**
 * 0033 qualification in a disposable systemd container: the standalone
 * service (install from npm, self-update, broken-release rollback, the
 * `engines.bun` refusal), linger, and the host's dependency tasks
 * (`host.image.update` against GHCR, `host.gh.update` latest and pinned).
 *
 * It runs only against a disposable rootless Docker daemon, never the host's:
 *
 *   mise run build:cli
 *   mise run docker:disposable -- start --name q0033
 *   eval "$(mise run docker:disposable -- env --name q0033)"
 *   bun scripts/qualify-host-upgrades-container.ts --report output/qualification-0033/report.json
 *   mise run docker:disposable -- stop --name q0033
 *
 * The container boots systemd as PID 1 (`--privileged` inside the rootless
 * daemon's user namespace, which grants nothing on the host) with a user
 * `qual` whose linger is on, so `user@1001.service` runs without a login.
 * This checkout is mounted read-only at its own path; every service, data
 * directory and Bun cache lives in the container. The daemon's socket is
 * mounted in so the service's backend can pull and tag images on that same
 * disposable daemon (the release image is about 7 GB unpacked).
 *
 * Phases (`--phases`, default all):
 * - service: `scripts/qualify-standalone-service.ts` as `qual` (cancel,
 *   update, rollback and engines, with Bun 1.4.3 for the engines service).
 * - linger: a service installed from npm in a login session (`su - qual`)
 *   keeps running after that session ends, after a second login, and after a
 *   container reboot with nobody logged in; with linger turned off its
 *   backend stops, and turning linger on starts it again.
 * - host-tasks: on the same service, `host image update --wait` pulls
 *   `ghcr.io/orkestrator-ai/orkestrator-v2:<to>` and tags it as the service's
 *   private `--docker-image`; `host gh latest --wait` installs the newest
 *   upstream `gh` under `toolchains/gh-latest/<version>`; `host gh pinned
 *   --wait` returns to the pin.
 *
 * Only the container, the image this script built and the images the
 * host-tasks phase pulled or tagged are removed (by exact name); the daemon
 * itself is removed with `docker:disposable stop`. Exits 0 when every check
 * held, 1 when one did not, 2 on setup errors.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dir, "..");
/** The repository's Docker shim: every call but `network create` is the real CLI. */
const DOCKER = path.join(
  ROOT,
  "apps",
  "desktop",
  "scripts",
  "dev",
  "docker-qualification-bin",
  "docker",
);
const USER = "qual";
const UID = 1001;
const SOCKET_IN_CONTAINER = "/opt/qualify/docker.sock";
const RELEASE_IMAGE = "ghcr.io/orkestrator-ai/orkestrator-v2";
const PRIVATE_IMAGE_TAG = "orkestrator-v2:qualify-0033";
/** The host service's port inside the container's own network namespace. */
const HOST_SERVICE_PORT = 41733;

/** Bun releases, checked against the release's SHASUMS256.txt before unpacking. */
export const BUN_DOWNLOADS: Record<string, Record<string, string>> = {
  "1.4.4": {
    x64: "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
  },
  "1.4.3": {
    x64: "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18",
  },
};

export class SetupError extends Error {}

export type Phase = "service" | "linger" | "host-tasks";
export const PHASES: readonly Phase[] = ["service", "linger", "host-tasks"];

export interface Options {
  name: string;
  from: string;
  to: string;
  enginesFrom: string;
  enginesTo: string;
  phases: Set<Phase>;
  report: string;
  keep: boolean;
}

export function parseOptions(argv: string[]): Options {
  const option = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback;
  };
  const phases = option("--phases", PHASES.join(",")).split(",");
  if (phases.length === 0 || phases.some((phase) => !PHASES.includes(phase as Phase))) {
    throw new SetupError(`--phases must be a nonempty subset of ${PHASES.join(",")}`);
  }
  const name = option("--name", "q0033");
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new SetupError("--name must be [a-z0-9-]");
  const to = option("--to", "2.38.1-beta");
  return {
    name,
    from: option("--from", "2.38.0-beta"),
    to,
    enginesFrom: option("--engines-from", "2.29.0-beta"),
    enginesTo: option("--engines-to", to),
    phases: new Set(phases as Phase[]),
    report: option("--report", ""),
    keep: argv.includes("--keep"),
  };
}

/**
 * The socket of the disposable rootless daemon selected by
 * `eval "$(mise run docker:disposable -- env --name <n>)"`. Anything else,
 * including the host daemon, is refused.
 */
export function disposableSocket(env: Record<string, string | undefined>): string {
  if (env.ORKESTRATOR_DISPOSABLE_DOCKER_MODE !== "rootless") {
    throw new SetupError(
      'Select a disposable rootless daemon first: eval "$(mise run docker:disposable -- env --name <n>)"',
    );
  }
  const host = env.DOCKER_HOST ?? "";
  const match = /^unix:\/\/(\/.+\/docker\.sock)$/.exec(host);
  if (!match || !/\/ork-ddd-[^/]+\/docker\.sock$/.test(match[1]!)) {
    throw new SetupError(`DOCKER_HOST is not a disposable daemon's socket: ${host || "(unset)"}`);
  }
  return match[1]!;
}

export function dockerfile(arch = process.arch): string {
  const buns = Object.entries(BUN_DOWNLOADS).map(([version, sums]) => {
    const sum = sums[arch];
    if (!sum) throw new SetupError(`No pinned Bun ${version} for ${arch}`);
    return `${version}:${sum}`;
  });
  const zip = arch === "arm64" ? "bun-linux-aarch64.zip" : "bun-linux-x64.zip";
  return `FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y --no-install-recommends \\
      systemd systemd-sysv dbus dbus-user-session libpam-systemd docker-cli \\
      ca-certificates curl unzip procps tar gzip git iproute2 \\
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; for spec in ${buns.join(" ")}; do \\
      v=\${spec%%:*}; sum=\${spec#*:}; \\
      curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v$v/${zip}; \\
      echo "$sum  /tmp/bun.zip" | sha256sum -c -; \\
      mkdir -p /opt/bun-$v; unzip -q -j /tmp/bun.zip -d /opt/bun-$v; rm /tmp/bun.zip; \\
      chmod 755 /opt/bun-$v/bun; \\
    done; \\
    ln -s /opt/bun-1.4.4/bun /usr/local/bin/bun; ln -s /opt/bun-1.4.4/bun /usr/local/bin/bunx
RUN useradd -m -u ${UID} -s /bin/bash ${USER} \\
    && mkdir -p /var/lib/systemd/linger /opt/qualify && touch /var/lib/systemd/linger/${USER} \\
    && systemctl mask systemd-firstboot.service systemd-udevd.service systemd-modules-load.service \\
       getty.target console-getty.service sys-kernel-config.mount sys-kernel-debug.mount \\
       sys-kernel-tracing.mount proc-sys-fs-binfmt_misc.automount
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Check {
  phase: string;
  name: string;
  ok: boolean;
  detail?: unknown;
}

/** First JSON object in a command's stdout (a login shell may print before it). */
export function parseJson(stdout: string): Record<string, any> | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

/** The last non-empty line of terminal output (CRLF-tolerant). */
export function lastLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

/**
 * How many login sessions `user` has in `loginctl list-sessions --json=short`
 * output. The user manager's own session (class `manager`, systemd 256 and
 * later) is not a login; null when the output cannot be read.
 */
export function loginSessions(json: string, user: string): number | null {
  try {
    const sessions = JSON.parse(json) as Array<{ user?: string; class?: string }>;
    return sessions.filter(
      (session) => session.user === user && !String(session.class ?? "").startsWith("manager"),
    ).length;
  } catch {
    return null;
  }
}

/** Whether the snapshot shows `gh` following upstream at `version`, outside its pin. */
export function ghFollowsLatest(host: Record<string, any> | null, version: string): boolean {
  const gh = (host?.tools as Array<Record<string, any>> | undefined)?.find(
    (tool) => tool.name === "gh",
  );
  return (
    host?.ghChannel === "latest" &&
    gh?.channel === "latest" &&
    gh?.installedVersion === version &&
    gh?.installedVersion !== gh?.pinnedVersion
  );
}

/** Whether the snapshot shows `gh` back on its pin. */
export function ghOnPin(host: Record<string, any> | null): boolean {
  const gh = (host?.tools as Array<Record<string, any>> | undefined)?.find(
    (tool) => tool.name === "gh",
  );
  return (
    host?.ghChannel === "pinned" &&
    gh?.channel === "pinned" &&
    gh?.source === "managed" &&
    gh?.installedVersion === gh?.pinnedVersion
  );
}

export async function qualifyHostUpgradesContainer(argv = process.argv.slice(2)): Promise<number> {
  const checks: Check[] = [];
  const log = (text: string) => console.error(`[qualify-0033] ${new Date().toISOString()} ${text}`);
  const check = (phase: string, name: string, ok: boolean, detail?: unknown) => {
    checks.push({ phase, name, ok, ...(detail === undefined ? {} : { detail }) });
    log(
      `${ok ? "PASS" : "FAIL"} ${phase}: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
    );
    return ok;
  };
  const startedAt = new Date().toISOString();
  let options: Options | null = null;
  let status = 0;
  let serviceReport: unknown = null;
  const created: { container?: string; image?: string; pulled: string[] } = { pulled: [] };
  const work = mkdtempSync(path.join(os.tmpdir(), "ork-qualify-0033-"));

  async function run(
    command: string[],
    timeoutMs = 20 * 60_000,
    stdin?: string,
  ): Promise<RunResult> {
    const child = Bun.spawn(command, {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  }
  const docker = (args: string[], timeoutMs?: number, stdin?: string) =>
    run([DOCKER, ...args], timeoutMs, stdin);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor<T>(
    what: string,
    read: () => Promise<T | null>,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(2_000);
    }
  }

  try {
    options = parseOptions(argv);
    const socket = disposableSocket(process.env);
    if (!existsSync(path.join(ROOT, "packages", "cli", "dist"))) {
      throw new SetupError("Build the client first: mise run build:cli");
    }
    const container = `${options.name}-systemd`;
    const image = `${options.name}-systemd:qualify`;
    const opts = options;

    // --- container -------------------------------------------------------
    writeFileSync(path.join(work, "Dockerfile"), dockerfile());
    log(`building ${image} on the disposable daemon`);
    const built = await docker(["build", "-t", image, work], 30 * 60_000);
    if (built.code !== 0) throw new SetupError(`docker build failed: ${built.stderr.slice(-800)}`);
    created.image = image;
    const started = await docker([
      "run",
      "-d",
      "--name",
      container,
      "--hostname",
      container,
      "--privileged",
      "--cgroupns=private",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/run/lock",
      "-v",
      `${ROOT}:${ROOT}:ro`,
      "-v",
      `${socket}:${SOCKET_IN_CONTAINER}`,
      image,
    ]);
    if (started.code !== 0)
      throw new SetupError(`docker run failed: ${started.stderr.slice(-800)}`);
    created.container = container;

    const userEnv = [
      "-e",
      `XDG_RUNTIME_DIR=/run/user/${UID}`,
      "-e",
      `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${UID}/bus`,
    ];
    /** A command as `qual` without a login session (what a service manager sees). */
    const asUser = (command: string[], timeoutMs?: number, env: string[] = []) =>
      docker(
        ["exec", "-u", USER, "-w", `/home/${USER}`, ...userEnv, ...env, container, ...command],
        timeoutMs,
      );
    const asRoot = (command: string[], timeoutMs?: number) =>
      docker(["exec", container, ...command], timeoutMs);
    /** A login session: PAM opens it with pam_systemd, and it ends when the script exits. */
    /**
     * A login session: `su -` under a pseudo-terminal (`script`), so PAM opens
     * a `user`-class TTY session with pam_systemd (without a TTY systemd 257
     * classes it `background`), and it ends when the script exits. stdout and
     * stderr arrive merged, as from a terminal.
     */
    let logins = 0;
    async function login(script: string, timeoutMs?: number): Promise<RunResult> {
      const file = `/tmp/qualify-login-${++logins}.sh`;
      const written = await docker(
        ["exec", "-i", container, "sh", "-c", `cat > ${file} && chmod 0644 ${file}`],
        60_000,
        script,
      );
      if (written.code !== 0) throw new SetupError(`could not stage ${file}: ${written.stderr}`);
      return docker(
        [
          "exec",
          container,
          "script",
          "-qec",
          `su - ${USER} -s /bin/bash -c 'bash ${file}'`,
          "/dev/null",
        ],
        timeoutMs,
      );
    }

    async function booted() {
      await waitFor(
        "systemd and the lingering user manager",
        async () => {
          const system = await asRoot(["systemctl", "is-system-running", "--wait"], 120_000);
          const manager = await asRoot(["systemctl", "is-active", `user@${UID}.service`], 30_000);
          return /running|degraded/.test(system.stdout) && manager.stdout.trim() === "active"
            ? true
            : null;
        },
        5 * 60_000,
      );
    }
    await booted();
    const system = await asRoot(["systemctl", "is-system-running"]);
    check("container", "systemd booted with the lingering user manager", true, {
      system: system.stdout.trim(),
    });
    // The daemon's socket belongs to its "docker" group; give qual that gid.
    const gid = (await asRoot(["stat", "-c", "%g", SOCKET_IN_CONTAINER])).stdout.trim();
    if (!/^\d+$/.test(gid)) throw new SetupError("Could not read the mounted socket's group");
    await asRoot(["sh", "-c", `getent group ${gid} >/dev/null || groupadd -g ${gid} hostdocker`]);
    const added = await asRoot(["usermod", "-aG", gid, USER]);
    if (added.code !== 0) throw new SetupError(`usermod failed: ${added.stderr}`);
    // The lingering manager started at boot, before the group: restart it so
    // the units it starts get the group too.
    const manager = await asRoot(["systemctl", "restart", `user@${UID}.service`], 120_000);
    if (manager.code !== 0)
      throw new SetupError(`restarting user@${UID} failed: ${manager.stderr}`);
    await booted();

    // --- service ---------------------------------------------------------
    if (opts.phases.has("service")) {
      const report = `/home/${USER}/service-report.json`;
      log("running scripts/qualify-standalone-service.ts as qual");
      const result = await asUser(
        [
          "bun",
          path.join(ROOT, "scripts", "qualify-standalone-service.ts"),
          "--from",
          opts.from,
          "--to",
          opts.to,
          "--engines-bun",
          "/opt/bun-1.4.3/bun",
          "--engines-from",
          opts.enginesFrom,
          "--engines-to",
          opts.enginesTo,
          "--report",
          report,
        ],
        90 * 60_000,
      );
      serviceReport = parseJson((await asRoot(["cat", report])).stdout);
      check("service", "qualify-standalone-service.ts passed every check", result.code === 0, {
        code: result.code,
        failed: ((serviceReport as { checks?: Check[] } | null)?.checks ?? [])
          .filter((entry) => !entry.ok)
          .map((entry) => `${entry.phase}: ${entry.name}`),
      });
      if (result.code !== 0) log(result.stderr.slice(-2000));
    }

    // --- linger and host tasks share one service -------------------------
    if (opts.phases.has("linger") || opts.phases.has("host-tasks")) {
      const dataDir = `/home/${USER}/host-service`;
      const cli = ["bun", path.join(ROOT, "packages", "cli", "bin", "orkestrator.js")];
      const cliEnv = ["-e", `ORKESTRATOR_CLI_CONFIG_DIR=/home/${USER}/cli-config`];
      const ork = (args: string[], timeoutMs?: number) =>
        asUser([...cli, ...args], timeoutMs, cliEnv);
      const descriptor = async () =>
        parseJson((await asRoot(["cat", `${dataDir}/backend-instance.json`])).stdout) as {
          generation: string;
          pid: number;
          appVersion: string;
        } | null;
      /** Login sessions of qual; systemd 256+ also lists the user manager (class `manager`). */
      const qualSessions = async () =>
        loginSessions((await asRoot(["loginctl", "list-sessions", "--json=short"])).stdout, USER);
      const serving = (previous: string | null) =>
        waitFor(
          `the service to serve ${opts.to}`,
          async () => {
            const current = await descriptor();
            if (!current || current.appVersion !== opts.to || current.generation === previous)
              return null;
            const host = await ork(["--connection", "host", "host", "status", "--json"], 60_000);
            return host.code === 0 ? current : null;
          },
          8 * 60_000,
        );

      log(`installing the host service: orkestrator@${opts.to} from npm in a login session`);
      // Cursor only: the launcher's toolchain install is gh alone.
      const install = await login(
        `set -eu
mkdir -p ${dataDir}
printf '%s\\n' '{"global":{"enabledAgentPlatforms":["cursor"]}}' > ${dataDir}/config.json
export BUN_INSTALL_CACHE_DIR=$HOME/bun-cache
out=$(bun x orkestrator@${opts.to} service install --data-dir ${dataDir} --release ${opts.to} --yes --skip-start --json -- --host 127.0.0.1 --allow-non-tailscale-bind --port ${HOST_SERVICE_PORT} --runtime-flavor agent-test --docker-image ${PRIVATE_IMAGE_TAG})
unit=$(printf '%s' "$out" | bun -e 'console.log((await Bun.stdin.json()).result.unit.file)')
# The unit's own environment, before its first boot: no Control MCP, and the disposable daemon.
bun -e 'const f=process.argv[1]; const t=await Bun.file(f).text(); const add="Environment=\\"ORKESTRATOR_CONTROL_MCP_DISABLED=1\\"\\nEnvironment=\\"DOCKER_HOST=unix://${SOCKET_IN_CONTAINER}\\"\\n"; if(!t.includes("Environment=NODE_ENV=production\\n")) process.exit(3); await Bun.write(f, t.replace("Environment=NODE_ENV=production\\n", "$&"+add));' "$unit"
# What service install runs when it is not told --skip-start.
systemctl --user daemon-reload
systemctl --user enable --now "$(basename "$unit")"
loginctl show-session "$XDG_SESSION_ID" -p Name -p Class >&2 || true
printf '%s\\n' "$out"
`,
        15 * 60_000,
      );
      const installed = parseJson(install.stdout);
      const unit = installed?.result?.unit as { name: string; file: string } | undefined;
      if (install.code !== 0 || !unit) {
        throw new SetupError(
          `host service install failed (${install.code}): ${install.stdout.slice(-800)}`,
        );
      }
      const connected = await ork([
        "connection",
        "add",
        "host",
        "--data-dir",
        dataDir,
        "--no-check",
        "--json",
      ]);
      if (connected.code !== 0) throw new SetupError(`connection add failed: ${connected.stderr}`);
      const first = await serving(null);
      const session = /Class=\S+/.exec(install.stdout)?.[0] ?? null;
      check(
        "linger",
        `service install of ${opts.to} from npm in a login session serves`,
        session === "Class=user",
        { unit: unit.name, session },
      );

      const active = async () =>
        (await asUser(["systemctl", "--user", "is-active", unit.name])).stdout.trim();
      const pidAlive = async (pid: number) =>
        (await asRoot(["kill", "-0", String(pid)])).code === 0;

      if (opts.phases.has("linger")) {
        const linger = (
          await asRoot(["loginctl", "show-user", USER, "-p", "Linger"])
        ).stdout.trim();
        check("linger", "linger is on for the service user", linger === "Linger=yes", { linger });
        // Logged out: the login session has closed. Wait past UserStopDelaySec (10 s).
        await waitFor(
          "the login session to close",
          async () => ((await qualSessions()) === 0 ? true : null),
          60_000,
        );
        await sleep(20_000);
        const afterLogout = await descriptor();
        check(
          "linger",
          "after logout the unit is still active and its backend never restarted",
          (await active()) === "active" &&
            afterLogout?.generation === first.generation &&
            (await pidAlive(first.pid)),
          { active: await active(), sameGeneration: afterLogout?.generation === first.generation },
        );
        const again = await login(`systemctl --user is-active ${unit.name}\n`, 60_000);
        await waitFor(
          "the second login session to close",
          async () => ((await qualSessions()) === 0 ? true : null),
          60_000,
        );
        await sleep(15_000);
        check(
          "linger",
          "logging in again finds it active, and it stays active after that logout",
          lastLine(again.stdout) === "active" &&
            (await active()) === "active" &&
            (await descriptor())?.generation === first.generation,
          { inSession: lastLine(again.stdout), after: await active() },
        );
      }

      if (opts.phases.has("host-tasks")) {
        const hostStatus = async () =>
          parseJson(
            (await ork(["--connection", "host", "host", "status", "--json"], 60_000)).stdout,
          )?.result ?? null;
        const reference = `${RELEASE_IMAGE}:${opts.to}`;
        log(`host image update: pulling ${reference} (several GB)`);
        const pulled = await ork(
          [
            "--connection",
            "host",
            "host",
            "image",
            "update",
            "--wait",
            "--timeout",
            "60m",
            "--json",
          ],
          65 * 60_000,
        );
        created.pulled.push(reference, PRIVATE_IMAGE_TAG);
        const pulledJson = parseJson(pulled.stdout);
        const taskResult = pulledJson?.result?.host?.tasks?.["image-update"]?.result ?? null;
        check(
          "host-tasks",
          "host image update --wait succeeds and tags the release image as the private image",
          pulled.code === 0 &&
            pulledJson?.receipt?.state === "succeeded" &&
            taskResult?.reference === reference &&
            taskResult?.tag === PRIVATE_IMAGE_TAG,
          {
            code: pulled.code,
            receipt: pulledJson?.receipt?.state,
            result: taskResult,
            error: pulledJson?.error?.message ?? pulledJson?.failure,
          },
        );
        const ids = await Promise.all(
          [reference, PRIVATE_IMAGE_TAG].map(async (ref) =>
            (await docker(["image", "inspect", "--format", "{{.Id}}", ref])).stdout.trim(),
          ),
        );
        const imageHost = await hostStatus();
        const imageStatus = imageHost?.image ?? null;
        check(
          "host-tasks",
          "the private tag moved to the release image, which this backend accepts",
          Boolean(ids[0]) &&
            ids[0] === ids[1] &&
            imageStatus?.name === PRIVATE_IMAGE_TAG &&
            imageStatus?.present === true &&
            imageStatus?.compatible === true &&
            imageStatus?.olderThanBackend !== true &&
            imageStatus?.releaseReference === reference,
          {
            sameId: Boolean(ids[0]) && ids[0] === ids[1],
            image: imageStatus && {
              name: imageStatus.name,
              present: imageStatus.present,
              compatible: imageStatus.compatible,
              builtForVersion: imageStatus.builtForVersion,
              olderThanBackend: imageStatus.olderThanBackend,
              reason: imageStatus.reason,
            },
          },
        );

        const release = (await (
          await fetch("https://api.github.com/repos/cli/cli/releases/latest", {
            headers: {
              accept: "application/vnd.github+json",
              "user-agent": "orkestrator-qualification",
            },
          })
        ).json()) as { tag_name?: string };
        const upstream = String(release.tag_name ?? "").replace(/^v/, "");
        const latest = await ork(
          ["--connection", "host", "host", "gh", "latest", "--wait", "--json"],
          15 * 60_000,
        );
        const latestHost = await hostStatus();
        const ghFile = `${dataDir}/toolchains/gh-latest/${upstream}/gh`;
        const probe = await asUser([ghFile, "--version"]);
        const pin = (latestHost?.tools as Array<Record<string, any>> | undefined)?.find(
          (tool) => tool.name === "gh",
        )?.pinnedVersion;
        check(
          "host-tasks",
          `host gh latest installs gh ${upstream} under toolchains/gh-latest and selects it`,
          latest.code === 0 &&
            parseJson(latest.stdout)?.receipt?.state === "succeeded" &&
            ghFollowsLatest(latestHost, upstream) &&
            probe.code === 0 &&
            probe.stdout.includes(upstream),
          {
            code: latest.code,
            upstream,
            pinned: pin,
            gh: (latestHost?.tools as Array<Record<string, any>> | undefined)?.find(
              (tool) => tool.name === "gh",
            ),
            probe: probe.stdout.split("\n")[0],
          },
        );
        const pinned = await ork(
          ["--connection", "host", "host", "gh", "pinned", "--wait", "--json"],
          15 * 60_000,
        );
        const pinnedHost = await hostStatus();
        check(
          "host-tasks",
          "host gh pinned returns gh to its pin",
          pinned.code === 0 &&
            parseJson(pinned.stdout)?.receipt?.state === "succeeded" &&
            ghOnPin(pinnedHost),
          {
            code: pinned.code,
            gh: (pinnedHost?.tools as Array<Record<string, any>> | undefined)?.find(
              (tool) => tool.name === "gh",
            ),
          },
        );
      }

      if (opts.phases.has("linger")) {
        log("rebooting the container with nobody logged in");
        const before = await descriptor();
        const restarted = await docker(["restart", "-t", "60", container], 5 * 60_000);
        if (restarted.code !== 0) throw new Error(`docker restart failed: ${restarted.stderr}`);
        await booted();
        const afterBoot = await serving(before?.generation ?? null).catch(() => null);
        check(
          "linger",
          "after a reboot with nobody logged in the unit starts and serves",
          afterBoot !== null && (await active()) === "active" && (await qualSessions()) === 0,
          { active: await active(), sessions: await qualSessions(), served: afterBoot !== null },
        );
        // Control: the same service without linger.
        const lingering = await descriptor();
        await asRoot(["loginctl", "disable-linger", USER]);
        const stopped = await waitFor(
          "the user manager to stop without linger",
          async () =>
            (await asRoot(["systemctl", "is-active", `user@${UID}.service`])).stdout.trim() !==
              "active" &&
            lingering &&
            !(await pidAlive(lingering.pid))
              ? true
              : null,
          90_000,
        ).catch(() => false);
        check(
          "linger",
          "control: with linger off and nobody logged in the backend stops",
          stopped === true,
        );
        await asRoot(["loginctl", "enable-linger", USER]);
        const relingered = await serving(lingering?.generation ?? null).catch(() => null);
        check(
          "linger",
          "control: turning linger back on starts the unit again",
          relingered !== null && (await active()) === "active",
        );
      }

      const removed = await ork([
        "service",
        "uninstall",
        "--data-dir",
        dataDir,
        "--purge",
        "--json",
      ]);
      await asUser(["systemctl", "--user", "daemon-reload"]);
      const gone = (await asRoot(["test", "-e", unit.file])).code !== 0;
      check("cleanup", `${unit.name} uninstalled`, removed.code === 0 && gone, {
        code: removed.code,
        error: parseJson(removed.stdout)?.error?.message,
      });
    }

    status = checks.length > 0 && checks.every((entry) => entry.ok) ? 0 : 1;
  } catch (error) {
    status = error instanceof SetupError ? 2 : 1;
    log(`stopped: ${error instanceof Error ? error.message : String(error)}`);
    checks.push({ phase: "run", name: "completed", ok: false, detail: String(error) });
  } finally {
    if (!options?.keep) {
      if (created.container) await docker(["rm", "-f", created.container], 5 * 60_000);
      for (const ref of [...created.pulled, ...(created.image ? [created.image] : [])]) {
        await docker(["image", "rm", ref], 5 * 60_000);
      }
    } else if (created.container) {
      log(`kept ${created.container} and its images (--keep)`);
    }
    rmSync(work, { recursive: true, force: true });
    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      host: `${process.platform}-${process.arch}`,
      daemon: process.env.ORKESTRATOR_DISPOSABLE_DOCKER_MODE ?? null,
      from: options?.from,
      to: options?.to,
      engines: options ? { from: options.enginesFrom, to: options.enginesTo, bun: "1.4.3" } : null,
      checks,
      service: serviceReport,
      passed: status === 0,
    };
    if (options?.report) {
      mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true });
      writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    }
    log(status === 0 ? "every check passed" : `finished with status ${status}`);
  }
  return status;
}

if (import.meta.main) process.exit(await qualifyHostUpgradesContainer());
