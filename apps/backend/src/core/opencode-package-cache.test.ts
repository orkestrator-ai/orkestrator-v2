import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// These tests own real subprocesses; bound them explicitly under aggregate load.
setDefaultTimeout(30_000);
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PINNED_TOOLCHAIN_VERSIONS } from "@orkestrator/toolchain/manifest";
import {
  OPENCODE2_LAUNCH_CACHE_HOME,
  OPENCODE2_LAUNCH_CONFIG_DIR,
} from "./agent-credential-files.js";
import { CONTAINER_BRIDGE_LAUNCHER } from "./container-bridge-credential.js";
import {
  OPENCODE2_PACKAGE_LAYOUT_VERSION,
  OPENCODE_PACKAGE_INSTALL_LIMIT,
  openCodePackageCacheScript,
  openCodePackageInstalls,
} from "./opencode-package-cache.js";

describe("openCodePackageInstalls", () => {
  test("provider packages only, where 2.2.6 looks for them", () => {
    expect(
      openCodePackageInstalls([
        JSON.stringify({
          provider: {
            ollama: { npm: "ollama-ai-provider-v2" },
            pinned: { npm: "pinned-provider@1.2.3" },
            scoped: { npm: "@scope/provider" },
            taggedScoped: { npm: "@scope/provider@next" },
            // A bare `@ai-sdk/<name>` is 2.2.6's `ai-v6` tag; a versioned one is not.
            elevenlabs: { npm: "@ai-sdk/elevenlabs" },
            versioned: { npm: "@ai-sdk/openai@2.0.0" },
            none: { options: {} },
          },
          // 2.x is never given a plugin key; nothing here is installed.
          plugin: ["is-number"],
        }),
        '// comment\n{"provider":{"again":{"npm":"@ai-sdk/elevenlabs"}}}',
      ]),
    ).toEqual([
      { spec: "ollama-ai-provider-v2", directory: "ollama-ai-provider-v2@latest/1" },
      { spec: "pinned-provider@1.2.3", directory: "pinned-provider@1.2.3/1" },
      { spec: "@scope/provider", directory: "@scope/provider@latest/1" },
      { spec: "@scope/provider@next", directory: "@scope/provider@next/1" },
      { spec: "@ai-sdk/elevenlabs@ai-v6", directory: "@ai-sdk/elevenlabs@ai-v6/1" },
      { spec: "@ai-sdk/openai@2.0.0", directory: "@ai-sdk/openai@2.0.0/1" },
    ]);
  });

  test("never a path, URL or git spec", () => {
    expect(
      openCodePackageInstalls([
        JSON.stringify({
          provider: {
            a: { npm: "file:///workspace/provider.ts" },
            b: { npm: "git+https://example.test/x.git" },
            c: { npm: "../escape" },
            d: { npm: "@ai-sdk/../x" },
          },
        }),
      ]),
    ).toEqual([]);
  });

  test("the layout is the pinned 2.x's", () => {
    // The `ai-v6` tag and the `npm/<name>@<tag>/<generation>` directories are
    // read from the 2.2.6 binary, not from its configuration. When the pin
    // moves, run opencode2-package-cache.live.test.ts against the new binary
    // (and read its npm service) before moving OPENCODE2_PACKAGE_LAYOUT_VERSION.
    expect(PINNED_TOOLCHAIN_VERSIONS.opencode2).toBe(OPENCODE2_PACKAGE_LAYOUT_VERSION);
  });
});

test("the server's cache is its own root-owned directory", () => {
  expect(OPENCODE2_LAUNCH_CACHE_HOME).toBe("/run/orkestrator-opencode2/cache");
  expect(openCodePackageCacheScript()).toContain(`cache=${OPENCODE2_LAUNCH_CACHE_HOME}`);
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
    options: {
      launcherMarker?: boolean;
      config?: string;
      configFile?: [string, string];
      failing?: string;
    } = {},
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
    if (options.configFile) {
      await writeFile(path.join(config, options.configFile[0]), options.configFile[1]);
    }
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
    const script = openCodePackageCacheScript()
      .replaceAll(OPENCODE2_LAUNCH_CACHE_HOME, cache)
      .replaceAll(OPENCODE2_LAUNCH_CONFIG_DIR, config)
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

  test("a failed install leaves nothing behind and does not fail the start", async () => {
    const filled = await fill({
      config: JSON.stringify({ provider: { a: { npm: "broken" }, b: { npm: "working" } } }),
      failing: "broken",
    });
    expect(filled.exitCode).toBe(0);
    expect(filled.stderr).toContain("OpenCode package broken could not be installed");
    expect(await readdir(path.join(filled.cache, "opencode", "npm"))).toEqual(["working@latest"]);
    expect((await readdir(path.join(filled.cache, "opencode"))).sort()).toEqual(["bin", "npm"]);
  });

  test("installs at most the limit per start and progresses on restart", async () => {
    const provider = Object.fromEntries(
      Array.from({ length: OPENCODE_PACKAGE_INSTALL_LIMIT + 3 }, (_, index) => [
        `p${index}`,
        { npm: `pkg${index}` },
      ]),
    );
    const filled = await fill({ config: JSON.stringify({ provider }) });
    expect(filled.installs).toHaveLength(OPENCODE_PACKAGE_INSTALL_LIMIT);
    expect(filled.run().exitCode).toBe(0);
    expect((await filled.installLog()).split("\n").filter(Boolean)).toHaveLength(
      OPENCODE_PACKAGE_INSTALL_LIMIT + 3,
    );
  });

  test("2.x installs the user's providers where 2.2.6 imports them, and keeps them", async () => {
    // What 2.x's merged configuration looks like: `opencode.jsonc`, no plugin key.
    const filled = await fill({
      config: undefined,
      configFile: [
        "opencode.jsonc",
        JSON.stringify({
          provider: {
            o: { npm: "ollama-ai-provider-v2" },
            e: { npm: "@ai-sdk/elevenlabs" },
            p: { npm: "file:///workspace/planted.ts" },
          },
        }),
      ],
    });
    expect(filled.exitCode).toBe(0);
    expect(filled.installs.map((line) => line.split("|")[0])).toEqual([
      "ollama-ai-provider-v2",
      "@ai-sdk/elevenlabs@ai-v6",
    ]);
    for (const line of filled.installs) {
      expect(line).toContain("add --exact --ignore-scripts");
    }
    const npm = path.join(filled.cache, "opencode", "npm");
    for (const [directory, name] of [
      ["ollama-ai-provider-v2@latest", "ollama-ai-provider-v2"],
      ["@ai-sdk/elevenlabs@ai-v6", "@ai-sdk/elevenlabs"],
    ] as const) {
      // One numeric generation holding node_modules/<name>: what 2.2.6 imports.
      expect(await readdir(path.join(npm, directory))).toEqual(["1"]);
      expect(
        await readFile(
          path.join(npm, directory, "1", "node_modules", name, "package.json"),
          "utf8",
        ),
      ).toContain(name);
      expect((await stat(path.join(npm, directory, "1"))).mode & 0o777).toBe(0o755);
    }
    expect((await readdir(path.join(filled.cache, "opencode"))).sort()).toEqual(["bin", "npm"]);
    // Present packages are not installed again.
    expect(filled.run().exitCode).toBe(0);
    expect((await filled.installLog()).split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("2.x with no providers gets an empty root-owned cache", async () => {
    const filled = await fill({});
    expect(filled.exitCode).toBe(0);
    expect(filled.installs).toEqual([]);
    expect((await readdir(path.join(filled.cache, "opencode"))).sort()).toEqual(["bin", "npm"]);
  });

  test("does nothing on an image whose launcher does not use it", async () => {
    const filled = await fill({
      launcherMarker: false,
      config: JSON.stringify({ provider: { o: { npm: "x" } } }),
    });
    expect(filled.exitCode).toBe(0);
    expect(filled.installs).toEqual([]);
    await expect(stat(filled.cache)).rejects.toThrow();
  });
});
