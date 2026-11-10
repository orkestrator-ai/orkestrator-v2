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
  OPENCODE_LAUNCH_CACHE_HOME,
  OPENCODE_LAUNCH_CONFIG_DIR,
  OPENCODE_LAUNCH_ROOT,
} from "./agent-credential-files.js";
import { CONTAINER_BRIDGE_LAUNCHER } from "./container-bridge-credential.js";
import {
  openCodeLaunchConfigScript,
  OPENCODE_HOST_CONFIG_INPUT,
} from "./opencode-container-launch.js";
import { openCodePackageCacheScript } from "./opencode-package-cache.js";
/** Opt-in regression against pinned 1.19.5. Local fixture packages replace only
 * installation; the real binary resolves and imports both provider and npm plugin
 * from the generated cache layout. No registry or model request is made. */
const binary = process.env.OPENCODE_CLI_PATH?.trim();
const liveTest = process.env.RUN_LIVE_OPENCODE === "1" && binary ? test : test.skip;

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
  "a launched 1.x server imports the providers root installed, from a read-only cache",
  async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "ork-opencode-cache-")));
    const at = (...parts: string[]) => path.join(root!, ...parts);
    const run = at("run");
    const input = at("input");
    const workspace = at("workspace");
    const markers = at("markers");
    const fixtures = at("fixtures");
    for (const directory of [run, input, workspace, markers, fixtures, at("home")]) {
      await mkdir(directory, { recursive: true });
    }
    // This provider is deliberately absent from the binary bundle.
    const providers = { plain: "orkestrator-fake-provider" } as const;
    for (const name of Object.values(providers)) {
      const directory = path.join(fixtures, name);
      await mkdir(directory, { recursive: true });
      for (const [file, text] of Object.entries(providerPackage(name))) {
        await writeFile(path.join(directory, file), text);
      }
    }
    const plugin = "orkestrator-fake-plugin";
    await mkdir(path.join(fixtures, plugin), { recursive: true });
    await writeFile(
      path.join(fixtures, plugin, "package.json"),
      JSON.stringify({ name: plugin, version: "1.0.0", type: "module", main: "index.js" }),
    );
    await writeFile(
      path.join(fixtures, plugin, "index.js"),
      `import { writeFileSync } from "node:fs"; export async function Plugin() { writeFileSync(${JSON.stringify(path.join(markers, "plugin"))}, "loaded"); return {}; }`,
    );
    await writeFile(
      path.join(input, "opencode.json"),
      JSON.stringify({
        plugin: [plugin],
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

    expect(Bun.spawnSync([binary!, "--version"]).stdout.toString().trim()).toBe("1.19.5");
    const uid = String(process.getuid?.() ?? 0);
    const configScript = openCodeLaunchConfigScript()
      .replaceAll(OPENCODE_LAUNCH_ROOT, run)
      .replaceAll(OPENCODE_HOST_CONFIG_INPUT, input)
      .replaceAll("/usr/local/bin/bun", process.execPath)
      .replace(`!= 0 ]`, `!= ${uid} ]`)
      .replace('chown -R 0:0 "$next"', "true");
    expect(Bun.spawnSync(["sh", "-c", configScript]).exitCode).toBe(0);

    await rm(path.join(run, "config", "opencode", "plugins"), { recursive: true, force: true });

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
    const cacheScript = openCodePackageCacheScript("opencode")
      .replaceAll(OPENCODE_LAUNCH_CACHE_HOME, cache)
      .replaceAll(OPENCODE_LAUNCH_CONFIG_DIR, path.join(run, "config", "opencode"))
      .replaceAll(CONTAINER_BRIDGE_LAUNCHER, launcher)
      .replaceAll("/usr/local/bin/bun", bun)
      .replace('chown -R 0:0 "$cache"', "true")
      .replace('chown -R 0:0 "$stage"', "true")
      .replace('"$(stat -c %u "$cache")" != 0', `"$(stat -c %u "$cache")" != ${uid}`);
    const filled = Bun.spawnSync(["sh", "-c", cacheScript]);
    expect(filled.exitCode).toBe(0);
    expect((await readFile(installs, "utf8")).trim().split("\n")).toEqual([
      "orkestrator-fake-provider",
      "orkestrator-fake-plugin",
    ]);
    const packages = path.join(cache, "opencode", "packages");
    const layout = async () => (await readdir(packages)).sort();
    const before = await layout();
    expect(before).toEqual(["orkestrator-fake-plugin@latest", "orkestrator-fake-provider"]);
    // Root-owned in a container: nothing below it is the server's to write.
    await Bun.spawn(["chmod", "-R", "a-w", path.join(run, "config", "opencode"), cache]).exited;

    const password = `okb_${"c".repeat(43)}`;
    const port = 40_000 + Math.floor(Math.random() * 1_000);
    server = Bun.spawn([binary!, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: workspace,
      env: {
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DB: at("data", "opencode.db"),
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: at("home"),
        LANG: "C.UTF-8",
        XDG_CONFIG_HOME: path.join(run, "config"),
        OPENCODE_CONFIG_DIR: path.join(run, "config", "opencode"),
        OPENCODE_TEST_HOME: path.join(run, "home"),
        XDG_CACHE_HOME: cache,
        XDG_DATA_HOME: at("data"),
        XDG_STATE_HOME: at("state"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    const api = async (route: string, body?: unknown) =>
      fetch(base + route, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Basic ${btoa(`opencode:${password}`)}`,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt++) {
      ready = await api("/global/health").then(
        (r) => r.ok,
        () => false,
      );
      if (!ready) await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    expect((await api("/agent")).ok).toBe(true);
    expect(await readFile(path.join(markers, "plugin"), "utf8")).toBe("loaded");
    const session = (await (await api("/session", {})).json()) as { id: string };
    expect(
      (
        await api(`/session/${session.id}/prompt_async`, {
          model: { providerID: "plain", modelID: "m" },
          parts: [{ type: "text", text: "fixture" }],
        })
      ).ok,
    ).toBe(true);
    let marker: string | undefined;
    for (let attempt = 0; attempt < 150 && marker === undefined; attempt++) {
      marker = await readFile(path.join(markers, "plain"), "utf8").catch(() => undefined);
      if (marker === undefined) await Bun.sleep(100);
    }
    expect(marker).toBe(providers.plain);
    expect(await readdir(at("home"))).toEqual([]);
    // Nothing was installed beside it: no new generation and no staging directory.
    expect(await layout()).toEqual(before);
  },
  180_000,
);
