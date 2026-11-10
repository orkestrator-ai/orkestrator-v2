import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// These tests own real subprocesses; bound them explicitly under aggregate load.
setDefaultTimeout(30_000);
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENCODE2_LAUNCH_CACHE_HOME,
  OPENCODE_LAUNCH_CACHE_HOME,
  OPENCODE_LAUNCH_CONFIG_DIR,
} from "./agent-credential-files.js";
import { CONTAINER_BRIDGE_LAUNCHER } from "./container-bridge-credential.js";
import {
  OPENCODE_PACKAGE_INSTALL_LIMIT,
  openCodeLaunchCacheHome,
  openCodePackageCacheScript,
  openCodePackageInstalls,
} from "./opencode-package-cache.js";

describe("openCodePackageInstalls", () => {
  test("provider packages and npm plugins, where 1.19.5 looks for them", () => {
    expect(
      openCodePackageInstalls([
        JSON.stringify({
          provider: {
            ollama: { npm: "ollama-ai-provider-v2" },
            scoped: { npm: "@scope/provider@1.2.3" },
            bundled: { npm: "@ai-sdk/openai-compatible" },
            none: { options: {} },
          },
          plugin: ["is-number", "versioned@7.0.0", "@scope/plugin"],
        }),
        // JSONC, and a later file repeating an earlier spec.
        '// comment\n{"provider":{"again":{"npm":"ollama-ai-provider-v2"}}}',
      ]),
    ).toEqual([
      { spec: "ollama-ai-provider-v2", directory: "ollama-ai-provider-v2" },
      { spec: "@scope/provider@1.2.3", directory: "@scope/provider@1.2.3" },
      { spec: "@ai-sdk/openai-compatible", directory: "@ai-sdk/openai-compatible" },
      { spec: "is-number", directory: "is-number@latest" },
      { spec: "versioned@7.0.0", directory: "versioned@7.0.0" },
      { spec: "@scope/plugin", directory: "@scope/plugin@latest" },
    ]);
  });

  test("never a path, URL, git spec or anything a shell could read twice", () => {
    expect(
      openCodePackageInstalls([
        JSON.stringify({
          provider: {
            a: { npm: "file:../x" },
            b: { npm: "git+https://example.test/x.git" },
            c: { npm: "https://example.test/x.tgz" },
            d: { npm: "../escape" },
            e: { npm: "x; rm -rf /" },
            f: { npm: "$(id)" },
            g: { npm: "x@1 2" },
            h: { npm: 7 },
          },
          plugin: ["file:///tmp/p.js", "./local.js", "/abs/plugin.js", "pkg@>=1 <2"],
        }),
        "not json",
        "[]",
      ]),
    ).toEqual([]);
  });
});

test("each server has its own root-owned cache", () => {
  expect(openCodeLaunchCacheHome("opencode")).toBe(OPENCODE_LAUNCH_CACHE_HOME);
  expect(openCodeLaunchCacheHome("opencode2")).toBe(OPENCODE2_LAUNCH_CACHE_HOME);
});

describe.skipIf(process.platform !== "linux")("filling the cache as root", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  /**
   * The script with its fixed paths in a temporary directory, run as this user.
   * `bun add` is a stand-in that records its arguments and writes the package;
   * `bun -e` is the real Bun, so the spec extraction is the one root runs.
   */
  async function fill(
    kind: "opencode" | "opencode2",
    options: { launcherMarker?: boolean; config?: string; failing?: string } = {},
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-opencode-cache-"));
    directories.push(directory);
    const cache = path.join(directory, "cache");
    const config = path.join(directory, "config");
    const launcher = path.join(directory, "launcher");
    const installs = path.join(directory, "installs.log");
    await mkdir(config, { recursive: true });
    await writeFile(
      launcher,
      options.launcherMarker === false
        ? "#!/bin/sh\n"
        : "#!/bin/sh\n# ORKESTRATOR_CAPABILITY opencode2-launch=1\n",
    );
    if (options.config) await writeFile(path.join(config, "opencode.json"), options.config);
    const bun = path.join(directory, "bun");
    await writeFile(
      bun,
      `#!/bin/sh
case " $* " in
  *" -e "*) exec ${process.execPath} "$@" ;;
esac
spec=""; for arg in "$@"; do spec="$arg"; done
printf '%s|%s|%s\\n' "$spec" "$(pwd)" "$*" >> ${installs}
[ "$spec" = "${options.failing ?? "-"}" ] && exit 1
name="\${spec%@*}"; [ -n "$name" ] && [ "\${spec#@}" != "$spec" ] && [ "\${name#@}" = "$name" ] && name="$spec"
mkdir -p "node_modules/$name"; printf '{"name":"%s"}' "$name" > "node_modules/$name/package.json"
`,
    );
    await chmod(bun, 0o755);
    const uid = String(process.getuid?.() ?? 0);
    const script = openCodePackageCacheScript(kind)
      .replaceAll(openCodeLaunchCacheHome(kind), cache)
      .replaceAll(OPENCODE_LAUNCH_CONFIG_DIR, config)
      .replaceAll(CONTAINER_BRIDGE_LAUNCHER, launcher)
      .replaceAll("/usr/local/bin/bun", bun)
      .replace('chown -R 0:0 "$cache"', "true")
      .replace('chown -R 0:0 "$stage"', "true")
      .replace('"$(stat -c %u "$cache")" != 0', `"$(stat -c %u "$cache")" != ${uid}`);
    const result = Bun.spawnSync(["sh", "-c", script]);
    const log = await readFile(installs, "utf8").catch(() => "");
    return {
      cache,
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      installs: log.split("\n").filter(Boolean),
      run: () => Bun.spawnSync(["sh", "-c", script]),
      installLog: () => readFile(installs, "utf8").catch(() => ""),
    };
  }

  test("installs what the user's configuration names, with scripts off, and keeps it", async () => {
    const config = JSON.stringify({
      provider: { o: { npm: "ollama-ai-provider-v2" } },
      plugin: ["is-number", "file:///tmp/local.js"],
    });
    const filled = await fill("opencode", { config });
    expect(filled.exitCode).toBe(0);
    expect(filled.installs).toHaveLength(2);
    for (const line of filled.installs) {
      expect(line).toContain("add --exact --ignore-scripts");
    }
    const packages = path.join(filled.cache, "opencode", "packages");
    expect((await readdir(packages)).sort()).toEqual(["is-number@latest", "ollama-ai-provider-v2"]);
    expect(
      await readFile(
        path.join(
          packages,
          "ollama-ai-provider-v2",
          "node_modules",
          "ollama-ai-provider-v2",
          "package.json",
        ),
        "utf8",
      ),
    ).toContain("ollama-ai-provider-v2");
    // OpenCode creates opencode/bin at start and cannot in a read-only cache.
    expect((await stat(path.join(filled.cache, "opencode", "bin"))).isDirectory()).toBe(true);
    expect((await stat(path.join(packages, "is-number@latest"))).mode & 0o777).toBe(0o755);
    // No staging directory left behind.
    expect((await readdir(path.join(filled.cache, "opencode"))).sort()).toEqual([
      "bin",
      "packages",
    ]);
    // Present packages are not installed again.
    expect(filled.run().exitCode).toBe(0);
    expect((await filled.installLog()).split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("a failed install leaves nothing behind and does not fail the start", async () => {
    const filled = await fill("opencode", {
      config: JSON.stringify({ provider: { a: { npm: "broken" }, b: { npm: "working" } } }),
      failing: "broken",
    });
    expect(filled.exitCode).toBe(0);
    expect(filled.stderr).toContain("OpenCode package broken could not be installed");
    expect(await readdir(path.join(filled.cache, "opencode", "packages"))).toEqual(["working"]);
    expect((await readdir(path.join(filled.cache, "opencode"))).sort()).toEqual([
      "bin",
      "packages",
    ]);
  });

  test("installs at most the limit per start", async () => {
    const provider = Object.fromEntries(
      Array.from({ length: OPENCODE_PACKAGE_INSTALL_LIMIT + 3 }, (_, index) => [
        `p${index}`,
        { npm: `pkg${index}` },
      ]),
    );
    const filled = await fill("opencode", { config: JSON.stringify({ provider }) });
    expect(filled.installs).toHaveLength(OPENCODE_PACKAGE_INSTALL_LIMIT);
  });

  test("2.x gets an empty root-owned cache and no installs", async () => {
    const filled = await fill("opencode2", {
      config: JSON.stringify({ provider: { o: { npm: "ollama-ai-provider-v2" } } }),
    });
    expect(filled.exitCode).toBe(0);
    expect(filled.installs).toEqual([]);
    expect((await readdir(path.join(filled.cache, "opencode"))).sort()).toEqual([
      "bin",
      "packages",
    ]);
  });

  test("does nothing on an image whose launcher does not use it", async () => {
    const filled = await fill("opencode", {
      launcherMarker: false,
      config: JSON.stringify({ provider: { o: { npm: "x" } } }),
    });
    expect(filled.exitCode).toBe(0);
    expect(filled.installs).toEqual([]);
    await expect(stat(filled.cache)).rejects.toThrow();
  });
});
