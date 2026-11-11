import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

// These tests own real subprocesses; bound them explicitly under aggregate load.
setDefaultTimeout(30_000);
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENCODE2_LAUNCH_CACHE_HOME,
  OPENCODE2_LAUNCH_CONFIG_DIR,
  OPENCODE2_LAUNCH_ROOT,
} from "../agent-credential-files.js";
import { CONTAINER_BRIDGE_LAUNCHER } from "../container-bridge-credential.js";
import { OPENCODE_HOST_CONFIG_INPUT } from "../opencode-container-launch.js";
import { openCodePackageCacheScript } from "../opencode-package-cache.js";
import { openCode2LaunchConfigScript } from "../opencode2-container-launch.js";
import { startOpenCode2OnFreePort } from "./live-server.test-support.js";
import { OPENCODE2_FLAGS } from "./server.js";
import { mintOpenCode2InputId } from "./steer.js";

/**
 * Root's 2.x package cache against the real pinned binary, outside a
 * container (7550 task 2). The root config script and the root cache script
 * run as they do in a container (paths moved into a temporary directory,
 * ownership aside); `bun add` is a stand-in that copies a local fake provider
 * package, so no registry is reached, while `bun -e` is the real Bun. The
 * server then starts with the launcher's environment and the cache read-only,
 * and each provider's factory writes a marker when 2.x imports it. Run with
 * RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH. No model is reached.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const liveTest = process.env.RUN_LIVE_OPENCODE2 === "1" && binary ? test : test.skip;

let root: string | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
afterEach(async () => {
  server?.kill("SIGTERM");
  await server?.exited;
  if (root) {
    await Bun.spawn(["chmod", "-R", "u+w", root]).exited;
    await rm(root, { recursive: true, force: true });
  }
  root = server = undefined;
});

/** A provider package whose `create*` factory records that it was imported. */
const providerPackage = (name: string) => ({
  "package.json": JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
  "index.js": `import { writeFileSync } from "node:fs";
export function createFakeProvider(options) {
  writeFileSync(options.marker, ${JSON.stringify(name)});
  const fail = () => { throw new Error("fake provider: no model"); };
  return Object.assign(fail, { languageModel: fail, chat: fail });
}
`,
});

liveTest(
  "a launched 2.x server imports the providers root installed, from a read-only cache",
  async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "ork-opencode2-cache-")));
    const at = (...parts: string[]) => path.join(root!, ...parts);
    const run = at("run");
    const input = at("input");
    const workspace = at("workspace");
    const markers = at("markers");
    const fixtures = at("fixtures");
    for (const directory of [run, input, workspace, markers, fixtures, at("home")]) {
      await mkdir(directory, { recursive: true });
    }
    // One provider 2.x treats as a plain registry package, one as an AI SDK
    // package it installs as its `ai-v6` tag. Neither is bundled.
    const providers = {
      plain: "orkestrator-fake-provider",
      aisdk: "@ai-sdk/orkestrator-fake",
    } as const;
    for (const name of Object.values(providers)) {
      const directory = path.join(fixtures, name);
      await mkdir(directory, { recursive: true });
      for (const [file, text] of Object.entries(providerPackage(name))) {
        await writeFile(path.join(directory, file), text);
      }
    }
    await writeFile(
      path.join(input, "opencode.json"),
      JSON.stringify({
        provider: Object.fromEntries(
          Object.entries(providers).map(([id, npm]) => [
            id,
            {
              npm,
              name: id,
              options: { apiKey: "test-key", marker: path.join(markers, id) },
              models: { m: { name: "m", limit: { context: 16000, output: 2000 } } },
            },
          ]),
        ),
      }),
    );

    const uid = String(process.getuid?.() ?? 0);
    const configScript = openCode2LaunchConfigScript()
      .replaceAll(OPENCODE2_LAUNCH_ROOT, run)
      .replaceAll(OPENCODE_HOST_CONFIG_INPUT, input)
      .replaceAll("/usr/local/bin/bun", process.execPath)
      .replace(`!= 0 ]`, `!= ${uid} ]`)
      .replace('chown -R 0:0 "$next"', "true");
    expect(Bun.spawnSync(["sh", "-c", configScript]).exitCode).toBe(0);

    // `bun add <spec>` copies the fixture named by the spec's package name.
    const launcher = at("launcher");
    await writeFile(launcher, "#!/bin/sh\n# ORKESTRATOR_CAPABILITY opencode2-launch=1\n");
    const installs = at("installs.log");
    const bun = at("bun");
    await writeFile(
      bun,
      `#!/bin/sh
case " $* " in
  *" -e "*) exec ${process.execPath} "$@" ;;
esac
spec=""; for arg in "$@"; do spec="$arg"; done
printf '%s\\n' "$spec" >> ${installs}
name="\${spec%@*}"; [ "\${spec#@}" != "$spec" ] && [ "\${name#@}" = "$name" ] && name="$spec"
mkdir -p "node_modules/$(dirname "$name")" && cp -R "${fixtures}/$name" "node_modules/$name"
`,
    );
    await chmod(bun, 0o755);
    const cache = path.join(run, "cache");
    const cacheScript = openCodePackageCacheScript("opencode2")
      .replaceAll(OPENCODE2_LAUNCH_CACHE_HOME, cache)
      .replaceAll(OPENCODE2_LAUNCH_CONFIG_DIR, path.join(run, "opencode"))
      .replaceAll(CONTAINER_BRIDGE_LAUNCHER, launcher)
      .replaceAll("/usr/local/bin/bun", bun)
      .replace('chown -R 0:0 "$cache"', "true")
      .replace('chown -R 0:0 "$stage"', "true")
      .replace('"$(stat -c %u "$cache")" != 0', `"$(stat -c %u "$cache")" != ${uid}`);
    const filled = Bun.spawnSync(["sh", "-c", cacheScript]);
    expect(filled.exitCode).toBe(0);
    expect((await readFile(installs, "utf8")).trim().split("\n")).toEqual([
      "orkestrator-fake-provider",
      "@ai-sdk/orkestrator-fake@ai-v6",
    ]);
    const npm = path.join(cache, "opencode", "npm");
    const layout = async () => ({
      top: (await readdir(npm)).sort(),
      scoped: await readdir(path.join(npm, "@ai-sdk")),
      plain: await readdir(path.join(npm, "orkestrator-fake-provider@latest")),
      aisdk: await readdir(path.join(npm, "@ai-sdk", "orkestrator-fake@ai-v6")),
    });
    const before = await layout();
    expect(before).toEqual({
      top: ["@ai-sdk", "orkestrator-fake-provider@latest"],
      scoped: ["orkestrator-fake@ai-v6"],
      plain: ["1"],
      aisdk: ["1"],
    });
    // Root-owned in a container: nothing below it is the server's to write.
    await Bun.spawn(["chmod", "-R", "a-w", path.join(run, "opencode"), cache]).exited;

    const password = `okb_${"c".repeat(43)}`;
    const started = await startOpenCode2OnFreePort({
      stderrPath: at("serve.stderr"),
      password,
      directory: workspace,
      onSpawn: (spawned) => {
        server = spawned;
      },
      spawn: (port) =>
        Bun.spawn([binary!, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
          cwd: workspace,
          env: {
            OPENCODE_PASSWORD: password,
            OPENCODE_FLAGS: OPENCODE2_FLAGS,
            OPENCODE_DB: at("data", "opencode2.db"),
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: at("home"),
            LANG: "C.UTF-8",
            XDG_CONFIG_HOME: path.join(run, "config"),
            OPENCODE_CONFIG_DIR: path.join(run, "opencode"),
            OPENCODE_TEST_HOME: path.join(run, "home"),
            XDG_CACHE_HOME: cache,
            XDG_DATA_HOME: at("data"),
            XDG_STATE_HOME: at("state"),
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_DISABLE_AUTOUPDATE: "1",
          },
          stdout: "ignore",
          stderr: Bun.file(at("serve.stderr")),
        }),
    });
    const client = started.client;
    await client.api("GET", "/api/agent", "OpenCode agents", {});

    for (const id of Object.keys(providers)) {
      const session = await client.createSession({ model: { providerID: id, id: "m" } });
      await client.prompt(session.id, {
        id: mintOpenCode2InputId(),
        text: "hello",
        delivery: "steer",
      });
      let marker: string | undefined;
      for (let attempt = 0; attempt < 150 && marker === undefined; attempt++) {
        marker = await readFile(path.join(markers, id), "utf8").catch(() => undefined);
        if (marker === undefined) await Bun.sleep(100);
      }
      // 2.x imported root's copy: the factory of the package named by the configuration ran.
      expect(marker).toBe(providers[id as keyof typeof providers]);
    }
    // Nothing was installed beside it: no new generation and no staging directory.
    expect(await layout()).toEqual(before);
  },
  180_000,
);
