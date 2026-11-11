import { enabledInstalledPlugins } from "@orkestrator/protocol/node/claude-plugin-set";
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gnuToolPath, titleWithSkip } from "../../../tests/unit/gnu-shell-tools";
import {
  STAGED_INPUT_RELAY_DIR,
  scrubStagedProvider,
  stagePortableInputs,
  stagedInputRelayPaths,
  type InputSourceRoots,
} from "../src/core/portable-inputs";

/**
 * The root entrypoint's relay (`relay_staged_inputs`) run on the host. The
 * unprivileged half (`as_input_user`, `setpriv` to node in the image) runs as
 * the test user; `unreadable` decides what the `find ! -readable` probe sees,
 * standing in for node's view of a rootless daemon's owner-only mounts.
 * GNU fixtures execute the image's flags unchanged. macOS also runs every
 * case with BSD tools, translating only rm's filesystem bound and du's
 * apparent-byte-size flags to their native equivalents.
 */
const rootEntrypoint = await fs.readFile(
  path.join(import.meta.dir, "../../../docker/network-policy-entrypoint.sh"),
  "utf8",
);
const entrypoint = await fs.readFile(
  path.join(import.meta.dir, "../../../docker/entrypoint.sh"),
  "utf8",
);

// Probe the flags themselves rather than localized/version-dependent branding.
const rmProbe = Bun.spawnSync({
  cmd: ["rm", "-rf", "--one-file-system", "--"],
  env: { PATH: gnuToolPath },
  stderr: "pipe",
});
const duProbe = Bun.spawnSync({
  cmd: [
    "du",
    "-s",
    "-B1",
    "--apparent-size",
    path.join(import.meta.dir, "../../../docker/network-policy-entrypoint.sh"),
  ],
  env: { PATH: gnuToolPath },
  stdout: "pipe",
  stderr: "pipe",
});
const missingRelayFlags = [
  ...(rmProbe.exitCode === 0 ? [] : ["rm --one-file-system"]),
  ...(duProbe.exitCode === 0 &&
  Number(duProbe.stdout.toString().split("\t")[0]) === Buffer.byteLength(rootEntrypoint)
    ? []
    : ["du -s -B1 --apparent-size"]),
];
const NO_GNU_RELAY_TOOLS =
  missingRelayFlags.length === 0
    ? undefined
    : `needs ${missingRelayFlags.join(", ")} (macOS: brew install coreutils)`;

type RelayTools = "GNU" | "BSD";
const BSD_RELAY_ADAPTERS = `
rm() {
  local args=()
  for arg in "$@"; do
    if [ "$arg" = --one-file-system ]; then args+=(-x); else args+=("$arg"); fi
  done
  /bin/rm "\${args[@]}"
}
du() {
  local args=()
  for arg in "$@"; do
    if [ "$arg" = --apparent-size ]; then args+=(-A); else args+=("$arg"); fi
  done
  # BSD du reports in blocks of at least 512 bytes. Convert its rounded-up
  # apparent size back to bytes; the GNU lane checks the exact byte behavior.
  BLOCKSIZE=512 /usr/bin/du "\${args[@]}" | awk -F '\t' '{printf "%.0f\\n", $1 * 512}'
}`;

function shellFunction(source: string, name: string): string {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  if (!body) throw new Error(`Missing shell function: ${name}`);
  return body;
}

function shellAssignment(source: string, name: string): string {
  const line = source.match(new RegExp(`^${name}=.*$`, "m"))?.[0];
  if (!line) throw new Error(`Missing shell assignment: ${name}`);
  return line;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-relay-"));
  roots.push(root);
  return root;
}

function relay(
  sourceRoot: string,
  relayDir: string,
  options: {
    unreadable: boolean;
    maxEntries?: number;
    maxBytes?: number;
    stateDir?: string;
    /** node cannot remove anything below the relay (stands in for an immutable file). */
    nodeCannotRemove?: boolean;
  },
  tools: RelayTools,
) {
  const script = [
    "set -euo pipefail",
    shellAssignment(rootEntrypoint, "STAGED_INPUT_MOUNTS"),
    `STAGED_INPUT_RELAY_MAX_ENTRIES=${options.maxEntries ?? 20000}`,
    options.maxBytes === undefined
      ? shellAssignment(rootEntrypoint, "STAGED_INPUT_RELAY_MAX_BYTES")
      : `STAGED_INPUT_RELAY_MAX_BYTES=${options.maxBytes}`,
    tools === "BSD" ? BSD_RELAY_ADAPTERS : "",
    // The image's node user and group share a name; the host's test user may
    // belong to a differently named primary group (for example on macOS).
    `install() {
      local args=()
      while [ "$#" -gt 0 ]; do
        if [ "$1" = -g ]; then shift; args+=(-g "$(id -g)"); else args+=("$1"); fi
        shift
      done
      command install "\${args[@]}"
    }`,
    // node's view: the probe reports an unreadable entry, or none.
    `as_input_user() {
      if [ "$1" = find ]; then ${options.unreadable ? 'echo "$2"' : "true"}; return 0; fi
      ${options.nodeCannotRemove ? 'case "$1" in rm|chmod) return 1 ;; esac' : ""}
      "$@"
    }`,
    shellFunction(rootEntrypoint, "staged_input_digest"),
    shellFunction(rootEntrypoint, "remove_relay_copies"),
    shellFunction(rootEntrypoint, "relay_staged_inputs"),
    `relay_staged_inputs "$SOURCE_ROOT" "$RELAY_DIR" "$(id -un)" "$STATE_DIR" || echo "Staged inputs were not relayed" >&2`,
  ].join("\n");
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    env: {
      // Force the native lane to run without any Homebrew tools, even when
      // installed, so it also covers Macs without GNU coreutils.
      PATH: tools === "BSD" ? "/usr/bin:/bin:/usr/sbin:/sbin" : gnuToolPath,
      SOURCE_ROOT: sourceRoot,
      RELAY_DIR: relayDir,
      // Root's digests of what it relayed, beside the relay as under /run.
      STATE_DIR: options.stateDir ?? path.join(path.dirname(relayDir), "orkestrator-relay-state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

/** The mount points as the container sees them, from a real staged revision. */
async function mountedRevision(root: string) {
  const home = path.join(root, "home");
  await fs.mkdir(path.join(home, ".codex", "rules"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "auth.json"), '{"OPENAI_API_KEY":"sk-test"}');
  await fs.writeFile(path.join(home, ".codex", "config.toml"), "model = 'x'\n");
  await fs.writeFile(path.join(home, ".codex", "rules", "default.rules"), "allow\n");
  await fs.writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Test\n");
  const dataDir = path.join(root, "data");
  const inputRoots: InputSourceRoots = { home, agentTest: false };
  const staged = await stagePortableInputs(
    dataDir,
    "env-relay",
    new Set(["codex", "git"]),
    inputRoots,
  );
  // Docker's view: each staged source bound at its target below `/`.
  const container = path.join(root, "container");
  for (const mount of staged.mounts) {
    const target = path.join(container, mount.target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(mount.source, `${target}.bind`);
    await fs.cp(mount.source, target, { recursive: true, preserveTimestamps: true });
  }
  return { staged, dataDir, container };
}

for (const tools of (process.platform === "darwin" ? ["GNU", "BSD"] : ["GNU"]) as RelayTools[]) {
  // Linux and CI must fail on missing capabilities, never skip security cases.
  const skip =
    tools === "GNU" && process.platform === "darwin" && !process.env.CI
      ? NO_GNU_RELAY_TOOLS
      : undefined;
  describe.skipIf(skip !== undefined)(titleWithSkip(`staged input relay (${tools})`, skip), () => {
    const runRelay = (source: string, destination: string, options: Parameters<typeof relay>[2]) =>
      relay(source, destination, options, tools);
    if (tools === "GNU") {
      test("the required GNU flags are available", () => {
        expect(NO_GNU_RELAY_TOOLS).toBeUndefined();
      });
    }
    test("a mount node cannot read is copied owner-only into node's directory", async () => {
      const root = await tempRoot();
      const { container } = await mountedRevision(root);
      const relayDir = path.join(root, "run", "orkestrator-inputs");
      await fs.mkdir(path.dirname(relayDir), { recursive: true });
      expect(runRelay(container, relayDir, { unreadable: true })).toEqual({
        exitCode: 0,
        stderr: "",
      });

      expect((await fs.stat(relayDir)).mode & 0o777).toBe(0o700);
      const auth = path.join(relayDir, "codex-home", "auth.json");
      expect(await fs.readFile(auth, "utf8")).toContain("OPENAI_API_KEY");
      expect((await fs.stat(auth)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(relayDir, "codex-home"))).mode & 0o777).toBe(0o700);
      expect(
        await fs.readFile(path.join(relayDir, "codex-home", "rules", "default.rules"), "utf8"),
      ).toBe("allow\n");
      expect(await fs.readFile(path.join(relayDir, "tmp", "gitconfig"), "utf8")).toContain("Test");
      // Mounts the backend did not bind are not invented.
      expect((await fs.readdir(relayDir)).sort()).toEqual(["codex-home", "tmp"]);
    });

    test("a mount node can read is left alone, and an earlier relay is removed", async () => {
      const root = await tempRoot();
      const { container } = await mountedRevision(root);
      const relayDir = path.join(root, "orkestrator-inputs");
      await fs.mkdir(path.join(relayDir, "codex-home"), { recursive: true });
      await fs.writeFile(path.join(relayDir, "codex-home", "auth.json"), "stale");
      expect(runRelay(container, relayDir, { unreadable: false })).toEqual({
        exitCode: 0,
        stderr: "",
      });
      await expect(fs.stat(relayDir)).rejects.toThrow();
    });

    test("a revoked provider's emptied mount relays nothing at the next boot", async () => {
      const root = await tempRoot();
      const { container, dataDir, staged } = await mountedRevision(root);
      const relayDir = path.join(root, "orkestrator-inputs");
      expect(runRelay(container, relayDir, { unreadable: true })).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(await fs.readdir(path.join(relayDir, "codex-home"))).toContain("auth.json");

      expect(await scrubStagedProvider(dataDir, "env-relay", staged.revision, "codex")).toBe(true);
      // The bound directory now shows the emptied stage.
      const codexMount = path.join(container, "codex-home");
      await fs.rm(codexMount, { recursive: true });
      await fs.cp(await fs.readlink(`${codexMount}.bind`), codexMount, { recursive: true });
      expect(runRelay(container, relayDir, { unreadable: true })).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(await fs.readdir(path.join(relayDir, "codex-home"))).toEqual([]);
    });

    test("links are never followed, and an over-bound mount is not relayed", async () => {
      const root = await tempRoot();
      const container = path.join(root, "container");
      const secret = path.join(root, "secret.txt");
      await fs.writeFile(secret, "host secret");
      await fs.mkdir(path.join(container, "codex-home"), { recursive: true });
      await fs.symlink(secret, path.join(container, "codex-home", "auth.json"));
      await fs.symlink(path.join(root, "elsewhere"), path.join(container, "pi-config"));
      const relayDir = path.join(root, "orkestrator-inputs");
      expect(runRelay(container, relayDir, { unreadable: true })).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const relayed = path.join(relayDir, "codex-home", "auth.json");
      expect((await fs.lstat(relayed)).isSymbolicLink()).toBe(true);
      // A mount point that is itself a link is skipped.
      await expect(fs.lstat(path.join(relayDir, "pi-config"))).rejects.toThrow();

      await fs.writeFile(path.join(container, "codex-home", "one"), "1");
      await fs.writeFile(path.join(container, "codex-home", "two"), "2");
      const bounded = runRelay(container, relayDir, { unreadable: true, maxEntries: 2 });
      expect(bounded.stderr).toContain("Staged input /codex-home is over the relay bounds");
      await expect(fs.stat(path.join(relayDir, "codex-home"))).rejects.toThrow();
    });
    if (tools === "GNU") {
      // The skip needs GNU find's -printf; elsewhere every mount is relayed in
      // full, which the cases above already cover.
      describe("an unchanged mount is not relayed again", () => {
        // A relay removes the old copy before it writes the new one, and ext4
        // (the CI runners' /tmp) hands the freed inode number straight to the
        // next file, so a replaced copy could read as kept. Each inode read
        // also takes a hard link outside the relay directory, which keeps that
        // inode allocated until the test's roots are removed.
        let held = 0;
        const inode = async (file: string) => {
          const holdDir = await tempRoot();
          await fs.link(file, path.join(holdDir, `held-${held++}`));
          return (await fs.stat(file)).ino;
        };
        const ok = { exitCode: 0, stderr: "" };

        test("a second boot keeps the copy, and a changed mount alone is relayed", async () => {
          const root = await tempRoot();
          const { container } = await mountedRevision(root);
          const relayDir = path.join(root, "run", "orkestrator-inputs");
          const stateDir = path.join(root, "run", "orkestrator-relay-state");
          await fs.mkdir(path.dirname(relayDir), { recursive: true });
          const options = { unreadable: true, stateDir };
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o700);
          expect((await fs.readdir(stateDir)).sort()).toEqual(["codex-home", "tmp%2Fgitconfig"]);
          const config = path.join(relayDir, "codex-home", "config.toml");
          const gitconfig = path.join(relayDir, "tmp", "gitconfig");
          const before = { config: await inode(config), gitconfig: await inode(gitconfig) };

          expect(runRelay(container, relayDir, options)).toEqual(ok);
          expect(await inode(config)).toBe(before.config);
          expect(await inode(gitconfig)).toBe(before.gitconfig);

          // The backend rewrites a login in place before a start.
          await fs.writeFile(
            path.join(container, "codex-home", "auth.json"),
            '{"OPENAI_API_KEY":"sk-two"}',
          );
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          expect(await inode(config)).not.toBe(before.config);
          expect(
            await fs.readFile(path.join(relayDir, "codex-home", "auth.json"), "utf8"),
          ).toContain("sk-two");
          expect(await inode(gitconfig)).toBe(before.gitconfig);
        });

        test("a mode, a name or a link target counts as a change", async () => {
          const root = await tempRoot();
          const { container } = await mountedRevision(root);
          const relayDir = path.join(root, "orkestrator-inputs");
          const options = { unreadable: true };
          const codex = path.join(container, "codex-home");
          const relayed = path.join(relayDir, "codex-home", "config.toml");
          await fs.symlink("rules", path.join(codex, "linked"));
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          for (const change of [
            () => fs.chmod(path.join(codex, "rules", "default.rules"), 0o640),
            () => fs.rename(path.join(codex, "rules"), path.join(codex, "rules2")),
            async () => {
              await fs.unlink(path.join(codex, "linked"));
              await fs.symlink("rules2", path.join(codex, "linked"));
            },
          ]) {
            const before = await inode(relayed);
            await change();
            expect(runRelay(container, relayDir, options)).toEqual(ok);
            expect(await inode(relayed)).not.toBe(before);
          }
          expect(await fs.readlink(path.join(relayDir, "codex-home", "linked"))).toBe("rules2");
        });

        test("a copy that is gone, or a digest that is, is relayed again", async () => {
          const root = await tempRoot();
          const { container } = await mountedRevision(root);
          const relayDir = path.join(root, "orkestrator-inputs");
          const stateDir = path.join(root, "orkestrator-relay-state");
          const options = { unreadable: true, stateDir };
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          // Revocation removes a running container's relayed copy.
          await fs.rm(path.join(relayDir, "codex-home"), { recursive: true });
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          const relayed = path.join(relayDir, "codex-home", "config.toml");
          expect(await fs.readFile(relayed, "utf8")).toBe("model = 'x'\n");

          const before = await inode(relayed);
          await fs.rm(path.join(stateDir, "codex-home"));
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          expect(await inode(relayed)).not.toBe(before);

          // A digest that does not match is not taken for one that does.
          const again = await inode(relayed);
          await fs.writeFile(path.join(stateDir, "codex-home"), "0".repeat(64) + "\n");
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          expect(await inode(relayed)).not.toBe(again);
        });

        test("a kept copy does not keep a removed or now-readable mount's copy", async () => {
          const root = await tempRoot();
          const { container } = await mountedRevision(root);
          const relayDir = path.join(root, "orkestrator-inputs");
          const stateDir = path.join(root, "orkestrator-relay-state");
          const options = { unreadable: true, stateDir };
          await fs.writeFile(path.join(container, "claude-config.json"), "{}");
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          expect((await fs.readdir(relayDir)).sort()).toEqual([
            "claude-config.json",
            "codex-home",
            "tmp",
          ]);
          const config = path.join(relayDir, "codex-home", "config.toml");
          const before = await inode(config);

          await fs.rm(path.join(container, "tmp", "gitconfig"));
          await fs.rm(path.join(container, "claude-config.json"));
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          expect(await inode(config)).toBe(before);
          await expect(fs.lstat(path.join(relayDir, "tmp", "gitconfig"))).rejects.toThrow();
          await expect(fs.lstat(path.join(relayDir, "claude-config.json"))).rejects.toThrow();
          expect((await fs.readdir(stateDir)).sort()).toEqual(["codex-home"]);

          // Nothing left to keep: the relay and its digests go, as before.
          expect(runRelay(container, relayDir, { unreadable: false, stateDir })).toEqual(ok);
          await expect(fs.stat(relayDir)).rejects.toThrow();
          await expect(fs.stat(stateDir)).rejects.toThrow();
        });

        test("a copy node made unwritable is still replaced while another is kept", async () => {
          const root = await tempRoot();
          const { container } = await mountedRevision(root);
          const relayDir = path.join(root, "orkestrator-inputs");
          const stateDir = path.join(root, "orkestrator-relay-state");
          const options = { unreadable: true, stateDir };
          expect(runRelay(container, relayDir, options)).toEqual(ok);
          const gitconfig = path.join(relayDir, "tmp", "gitconfig");
          const kept = await inode(gitconfig);
          // A workload leaves a populated directory of its copy read-only.
          const rules = path.join(relayDir, "codex-home", "rules");
          await fs.chmod(rules, 0o500);
          try {
            await fs.rm(path.join(container, "codex-home", "rules", "default.rules"));
            expect(runRelay(container, relayDir, options)).toEqual(ok);
            await expect(fs.lstat(path.join(rules, "default.rules"))).rejects.toThrow();
            expect(await fs.readdir(rules)).toEqual([]);
            expect(await inode(gitconfig)).toBe(kept);

            // The whole mount removed from the source: its copy goes too.
            await fs.chmod(rules, 0o500);
            await fs.rm(path.join(container, "codex-home"), { recursive: true });
            expect(runRelay(container, relayDir, options)).toEqual(ok);
            await expect(fs.lstat(path.join(relayDir, "codex-home"))).rejects.toThrow();
            expect(await inode(gitconfig)).toBe(kept);
          } finally {
            await fs.chmod(rules, 0o700).catch(() => undefined);
          }
        });

        test("a copy node cannot remove makes root rebuild the whole relay", async () => {
          const root = await tempRoot();
          const { container } = await mountedRevision(root);
          const relayDir = path.join(root, "orkestrator-inputs");
          const stateDir = path.join(root, "orkestrator-relay-state");
          expect(runRelay(container, relayDir, { unreadable: true, stateDir })).toEqual(ok);
          const gitconfig = path.join(relayDir, "tmp", "gitconfig");
          const kept = await inode(gitconfig);
          await fs.rm(path.join(container, "codex-home", "rules", "default.rules"));
          const result = runRelay(container, relayDir, {
            unreadable: true,
            stateDir,
            nodeCannotRemove: true,
          });
          expect(result).toEqual({
            exitCode: 0,
            stderr:
              "Stale staged input copies could not be removed; relaying every staged input again\n",
          });
          // The stale file is gone, and the copy that would have been kept is
          // a fresh relay matching the source.
          await expect(
            fs.lstat(path.join(relayDir, "codex-home", "rules", "default.rules")),
          ).rejects.toThrow();
          expect(await fs.readFile(path.join(relayDir, "codex-home", "config.toml"), "utf8")).toBe(
            "model = 'x'\n",
          );
          expect(await inode(gitconfig)).not.toBe(kept);
          expect(await fs.readFile(gitconfig, "utf8")).toContain("Test");
          expect((await fs.readdir(stateDir)).sort()).toEqual(["codex-home", "tmp%2Fgitconfig"]);
        });

        test("an over-bound mount loses its kept copy and digest", async () => {
          const root = await tempRoot();
          const { container } = await mountedRevision(root);
          const relayDir = path.join(root, "orkestrator-inputs");
          const stateDir = path.join(root, "orkestrator-relay-state");
          expect(runRelay(container, relayDir, { unreadable: true, stateDir })).toEqual(ok);
          const bounded = runRelay(container, relayDir, {
            unreadable: true,
            stateDir,
            maxEntries: 3,
          });
          expect(bounded.stderr).toContain("Staged input /codex-home is over the relay bounds");
          await expect(fs.lstat(path.join(relayDir, "codex-home"))).rejects.toThrow();
          expect(await fs.readdir(stateDir)).toEqual(["tmp%2Fgitconfig"]);
        });

        test("a linked state directory is replaced, never followed", async () => {
          const root = await tempRoot();
          const { container } = await mountedRevision(root);
          const relayDir = path.join(root, "orkestrator-inputs");
          const stateDir = path.join(root, "orkestrator-relay-state");
          const elsewhere = path.join(root, "elsewhere");
          await fs.mkdir(elsewhere);
          await fs.symlink(elsewhere, stateDir);
          expect(runRelay(container, relayDir, { unreadable: true, stateDir })).toEqual(ok);
          expect((await fs.lstat(stateDir)).isDirectory()).toBe(true);
          expect(await fs.readdir(elsewhere)).toEqual([]);
        });
      });
    }
    test("apparent bytes bound sparse files without following symlinks", async () => {
      const root = await tempRoot();
      const container = path.join(root, "container");
      const source = path.join(container, "codex-home");
      await fs.mkdir(source, { recursive: true });
      const sparse = path.join(source, "large");
      await fs.writeFile(sparse, "");
      await fs.truncate(sparse, 1024 * 1024);
      const relayDir = path.join(root, "orkestrator-inputs");
      const bounded = runRelay(container, relayDir, { unreadable: true, maxBytes: 512 * 1024 });
      expect(bounded.exitCode).toBe(0);
      expect(bounded.stderr).toContain("Staged input /codex-home is over the relay bounds");
      await expect(fs.stat(relayDir)).rejects.toThrow();

      await fs.unlink(sparse);
      await fs.symlink(path.join(root, "secret"), sparse);
      await fs.writeFile(path.join(root, "secret"), "");
      await fs.truncate(path.join(root, "secret"), 1024 * 1024);
      expect(runRelay(container, relayDir, { unreadable: true, maxBytes: 512 * 1024 })).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect((await fs.lstat(path.join(relayDir, "codex-home", "large"))).isSymbolicLink()).toBe(
        true,
      );
    });
  });
}

describe("entrypoint input resolution", () => {
  const resolve = (relayDir: string, name: string) => {
    const script = [
      `STAGED_INPUT_RELAY_DIR="$RELAY_DIR"`,
      shellFunction(entrypoint, "staged_input_path"),
      `staged_input_path "$NAME"`,
    ].join("\n");
    return Bun.spawnSync({
      cmd: ["bash", "-c", script],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RELAY_DIR: relayDir, NAME: name },
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
  };

  test("reads the relayed copy when there is one, the mount otherwise", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, "codex-home"));
    await fs.mkdir(path.join(root, "claude-config"));
    await fs.writeFile(path.join(root, "claude-config", ".credentials.json"), "{}");
    await fs.symlink(path.join(root, "codex-home"), path.join(root, "grok-home"));
    expect(resolve(root, "/codex-home")).toBe(path.join(root, "codex-home"));
    expect(resolve(root, "/claude-config/.credentials.json")).toBe(
      path.join(root, "claude-config", ".credentials.json"),
    );
    expect(resolve(root, "/claude-config.json")).toBe("/claude-config.json");
    // A link in the relay is never taken for a relayed input.
    expect(resolve(root, "/grok-home")).toBe("/grok-home");
  });

  test("the copy helpers read a relayed mount in place of the mount", async () => {
    const root = await tempRoot();
    const relayDir = path.join(root, "relay");
    await fs.mkdir(path.join(relayDir, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(relayDir, "codex-home", "config.toml"), "relayed\n");
    const home = path.join(root, "home");
    const helpers = [
      "log_progress",
      "agent_copy_warn",
      "report_agent_copy_skips",
      "agent_source_path_has_symlink",
      "agent_destination_path_has_symlink",
      "copy_agent_file",
    ]
      .map((name) => shellFunction(entrypoint, name))
      .join("\n");
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `set -e\nAGENT_COPY_SKIPPED=""\nSTAGED_INPUT_RELAY_DIR="$RELAY_DIR"\n${helpers}\nmkdir -p "$HOME/.codex"\ncopy_agent_file /codex-home "$HOME/.codex" config.toml Codex`,
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        RELAY_DIR: relayDir,
        PROGRESS_FILE: path.join(root, "progress"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8")).toBe("relayed\n");
  });

  for (const linked of [false, true]) {
    test(`plugin enablement reads the relay and rejects linked settings (linked=${linked})`, async () => {
      const root = await tempRoot();
      const relayDir = path.join(root, "relay");
      const config = path.join(relayDir, "claude-config");
      const home = path.join(root, "home");
      await fs.mkdir(config, { recursive: true });
      await fs.mkdir(path.join(home, ".claude"), { recursive: true });
      const host = path.join(root, "host-settings.json");
      await fs.writeFile(
        host,
        JSON.stringify({
          enabledPlugins: {
            "review@fixture": true,
            "off@fixture": false,
            "invalid@fixture": "true",
          },
          env: { UNTRUSTED: "excluded" },
        }),
      );
      const input = path.join(config, "settings.json");
      if (linked) await fs.symlink(host, input);
      else await fs.copyFile(host, input);
      const output = path.join(home, ".claude", "settings.json");
      await fs.writeFile(output, '{"permissions":{"defaultMode":"bypassPermissions"}}');
      // Execute the production merge with no readable raw mount, only a relay.
      const merge = entrypoint.slice(
        entrypoint.indexOf("CLAUDE_SETTINGS_INPUT="),
        entrypoint.indexOf("# Copy and filter ~/.claude.json"),
      );
      expect(merge).toContain('jq --slurpfile host "$CLAUDE_SETTINGS_INPUT"');
      const result = Bun.spawnSync({
        cmd: [
          "bash",
          "-ec",
          [
            'STAGED_INPUT_RELAY_DIR="$RELAY_DIR"',
            shellFunction(entrypoint, "staged_input_path"),
            "log_progress() { :; }",
            merge,
          ].join("\n"),
        ],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, RELAY_DIR: relayDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const settings = JSON.parse(await fs.readFile(output, "utf8"));
      expect(settings.permissions.defaultMode).toBe("bypassPermissions");
      expect(settings.env).toBeUndefined();
      expect(settings.enabledPlugins).toEqual(
        linked
          ? undefined
          : {
              "review@fixture": true,
              "off@fixture": false,
            },
      );
      const installed = [
        { type: "local" as const, path: "/plugin", installedId: "review@fixture" },
      ];
      expect(enabledInstalledPlugins(installed, { user: settings }, ["user"])).toEqual(
        linked ? [] : installed,
      );
    });
  }

  test("the backend's relay path and revocation targets match the image", () => {
    expect(shellAssignment(entrypoint, "STAGED_INPUT_RELAY_DIR")).toBe(
      `STAGED_INPUT_RELAY_DIR=${STAGED_INPUT_RELAY_DIR}`,
    );
    expect(shellAssignment(rootEntrypoint, "STAGED_INPUT_RELAY_DIR")).toBe(
      `STAGED_INPUT_RELAY_DIR=${STAGED_INPUT_RELAY_DIR}`,
    );
    expect(stagedInputRelayPaths("codex")).toEqual([`${STAGED_INPUT_RELAY_DIR}/codex-home`]);
    expect(stagedInputRelayPaths("opencode")).toEqual([
      `${STAGED_INPUT_RELAY_DIR}/opencode-config`,
      `${STAGED_INPUT_RELAY_DIR}/opencode-data`,
      `${STAGED_INPUT_RELAY_DIR}/opencode-state/model.json`,
    ]);
    expect(stagedInputRelayPaths("claude")).toContain(`${STAGED_INPUT_RELAY_DIR}/claude-config`);
  });
});
