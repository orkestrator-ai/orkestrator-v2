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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScriptedModel } from "../../../../../scripts/opencode2-steer-probe.js";
import { OPENCODE2_LAUNCH_ROOT } from "../agent-credential-files.js";
import { filterProjectOpenCodeConfig } from "../opencode-project-config.js";
import {
  OPENCODE_HOST_CONFIG_INPUT,
  openCode2LaunchConfigScript,
  openCode2LaunchPlugins,
} from "../opencode2-container-launch.js";
import { startOpenCode2OnFreePort } from "./live-server.test-support.js";
import {
  OPENCODE2_GITHUB_ENV_PLUGIN_ID,
  buildOpenCode2GitHubEnvironmentPluginSource,
} from "./container-server.js";
import { OPENCODE2_FLAGS } from "./server.js";
import { mintOpenCode2InputId } from "./steer.js";

/**
 * A 2.x server started the way `orkestrator-bridge-launch opencode2` starts
 * one, against the real pinned binary and outside a container: the root
 * config script's directory (built as this user), the launcher's environment
 * under an empty one, and plugins planted where node could write them. Run
 * with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH. The model is scripted on
 * loopback; the GitHub token is a fake.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const liveTest = process.env.RUN_LIVE_OPENCODE2 === "1" && binary ? test : test.skip;

const FAKE_TOKEN = "ghp_fakeOrkestratorLaunchToken00000000";

let root: string | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let model: ScriptedModel | undefined;
afterEach(async () => {
  server?.kill("SIGTERM");
  await server?.exited;
  model?.stop();
  if (root) {
    await Bun.spawn(["chmod", "-R", "u+w", root]).exited;
    await rm(root, { recursive: true, force: true });
  }
  root = server = model = undefined;
});

const planted = (marker: string, id: string) => `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "loaded");
export default { id: ${JSON.stringify(id)}, async setup() {} };
`;

liveTest(
  "a launched 2.x server loads only root's plugins, applies its start environment and hides its password",
  async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "ork-opencode2-launch-")));
    const at = (...parts: string[]) => path.join(root!, ...parts);
    const run = at("run");
    const input = at("input");
    const workspace = at("workspace");
    const home = at("home");
    const markers = at("markers");
    for (const directory of [run, input, workspace, home, markers, at("tmp")]) {
      await mkdir(directory, { recursive: true });
    }
    // Every request body the model receives, to see what reached the prompt.
    const bodies: string[] = [];
    const serve = Bun.serve;
    (Bun as unknown as { serve: unknown }).serve = (options: Parameters<typeof Bun.serve>[0]) =>
      serve({
        ...options,
        fetch: async (request: Request, server: unknown) => {
          bodies.push(await request.clone().text());
          return (
            options as { fetch: (r: Request, s: unknown) => Response | Promise<Response> }
          ).fetch(request, server);
        },
      } as Parameters<typeof Bun.serve>[0]);
    model = new ScriptedModel();
    let modelUrl: string;
    try {
      modelUrl = model.start();
    } finally {
      (Bun as unknown as { serve: unknown }).serve = serve;
    }
    // The user's host configuration: a provider, and a plugin key that must not install.
    await writeFile(
      path.join(input, "opencode.json"),
      JSON.stringify({
        permission: { bash: "allow" },
        plugin: ["opencode-planted-plugin"],
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fixture",
            options: { baseURL: `${modelUrl}/v1`, apiKey: "test-key" },
            models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
          },
        },
        model: "fixture/fixture",
      }),
    );
    // Plugins in every place node can write.
    for (const [directory, id] of [
      [path.join(workspace, ".opencode", "plugins", "w"), "workspace"],
      [path.join(home, ".config", "opencode", "plugins", "x"), "xdg"],
      [path.join(home, ".opencode", "plugins", "h"), "home"],
    ] as const) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "index.ts"), planted(path.join(markers, id), id));
    }
    // The checkout's AGENTS.md points at the server's own environment; the
    // backend's copy (read as the user, before the start) is what the server reads.
    await symlink("/proc/self/environ", path.join(workspace, "AGENTS.md"));
    const project = path.join(run, "project");
    await mkdir(path.join(project, "instructions"), { recursive: true });
    await writeFile(path.join(project, "instructions", "0.md"), "COPIED-AGENTS-MARKER\n");
    // A project provider override must not replace the trusted host provider.
    const providerModule = path.join(workspace, "provider.ts");
    await writeFile(providerModule, planted(path.join(markers, "provider"), "provider"));
    const filtered = await filterProjectOpenCodeConfig(
      [
        {
          name: "opencode.json",
          text: JSON.stringify({
            provider: { fixture: { npm: `file://${providerModule}` } },
          }),
        },
      ],
      async (relative) => (relative === "AGENTS.md" ? "COPIED-AGENTS-MARKER\n" : undefined),
      (index) => path.join(project, "instructions", `${index}.md`),
      workspace,
    );
    expect(filtered.text).not.toContain(providerModule);
    await writeFile(path.join(project, "opencode.json"), filtered.text!);
    const credentialFile = at("tmp", "github-token");
    await writeFile(credentialFile, `${FAKE_TOKEN}\n`, { mode: 0o600 });

    // Root's directory, as the config script builds it (ownership aside),
    // with the GitHub plugin reading this test's token file.
    const uid = String(process.getuid?.() ?? 0);
    const script = openCode2LaunchConfigScript()
      .replaceAll(OPENCODE2_LAUNCH_ROOT, run)
      .replaceAll(OPENCODE_HOST_CONFIG_INPUT, input)
      .replaceAll("/usr/local/bin/bun", process.execPath)
      .replace(`!= 0 ]`, `!= ${uid} ]`)
      .replace('chown -R 0:0 "$next"', "true");
    expect(Bun.spawnSync(["sh", "-c", script]).exitCode).toBe(0);
    // The launched plugins are root's; the GitHub one here reads this test's token file.
    expect(openCode2LaunchPlugins().map(({ id }) => id)).toContain(OPENCODE2_GITHUB_ENV_PLUGIN_ID);
    await writeFile(
      path.join(run, "opencode", "plugins", OPENCODE2_GITHUB_ENV_PLUGIN_ID, "index.ts"),
      buildOpenCode2GitHubEnvironmentPluginSource(credentialFile),
    );
    await mkdir(path.join(run, "cache", "opencode", "bin"), { recursive: true });
    // Root-owned in a container: nothing below it is the server's to write.
    await Bun.spawn(["chmod", "-R", "a-w", path.join(run, "opencode"), path.join(run, "cache")])
      .exited;

    // The start script's environment, which the credential plugin applies.
    const snapshot = at("tmp", `.orkestrator-bridge-env-opencode2-${"b".repeat(32)}`);
    await writeFile(snapshot, "ORK_SNAPSHOT_PROBE=from-snapshot\0OPENCODE_CONFIG_DIR=/planted\0", {
      mode: 0o600,
    });
    const password = `okb_${"q".repeat(43)}`;
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
          // What the launcher exports, in its order, under `env -i`.
          env: {
            OPENCODE_PASSWORD: password,
            OPENCODE_FLAGS: OPENCODE2_FLAGS,
            OPENCODE_DB: at("data", "opencode2.db"),
            ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT: snapshot,
            ORKESTRATOR_BRIDGE_LAUNCH_KEYS: "OPENCODE_PASSWORD,OPENCODE_FLAGS,OPENCODE_DB",
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: home,
            LANG: "C.UTF-8",
            XDG_CONFIG_HOME: path.join(run, "config"),
            OPENCODE_CONFIG_DIR: path.join(run, "opencode"),
            OPENCODE_TEST_HOME: path.join(run, "home"),
            XDG_CACHE_HOME: path.join(run, "cache"),
            XDG_DATA_HOME: at("data"),
            XDG_STATE_HOME: at("state"),
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_CONFIG: path.join(run, "project", "opencode.json"),
          },
          stdout: "ignore",
          stderr: Bun.file(at("serve.stderr")),
        }),
    });
    const client = started.client;
    // Before the warm request the server is still dumpable: its environment is readable.
    const environ = `/proc/${started.server.pid}/environ`;
    expect((await readFile(environ)).length).toBeGreaterThan(0);
    // The backend's warm request loads the plugins, which make it non-dumpable.
    await client.api("GET", "/api/agent", "OpenCode agents", {});
    await expect(readFile(environ)).rejects.toThrow();

    const session = await client.createSession({
      model: { providerID: "fixture", id: "fixture" },
    });
    await client.prompt(session.id, {
      id: mintOpenCode2InputId(),
      text: "RUN_BASH:echo PW=${OPENCODE_PASSWORD:+SET} SNAP=$ORK_SNAPSHOT_PROBE CFG=${OPENCODE_CONFIG_DIR:-unset} GH=${GH_TOKEN:+SET} CACHE=${XDG_CACHE_HOME:-unset} END",
      delivery: "steer",
    });
    let output = "";
    for (let attempt = 0; attempt < 150 && !output.includes("END"); attempt++) {
      const rows = (await client.listMessages(session.id, { limit: 20, order: "asc" }))
        .messages as Array<{ content?: Array<{ type: string; state?: { content?: unknown } }> }>;
      const tool = rows.flatMap((row) => row.content ?? []).find((part) => part.type === "tool");
      output = JSON.stringify(tool?.state?.content ?? "");
      if (!output.includes("END")) await Bun.sleep(100);
    }
    // The snapshot reaches the tools; no OPENCODE_ variable from it does, nor the password.
    expect(output).toContain("PW= SNAP=from-snapshot");
    expect(output).toContain("GH=SET");
    expect(output).toContain("CACHE=unset");
    expect(output).not.toContain("CFG=/planted");
    expect(output).toContain(`CFG=${path.join(run, "opencode")} `);
    // Only root's plugins ran.
    expect(await readdir(markers)).toEqual([]);
    // The copy reached the prompt; the password never did.
    expect(bodies.join("\n")).toContain("COPIED-AGENTS-MARKER");
    expect(bodies.join("\n")).not.toContain(password);
    // Nothing was installed into the read-only cache (the user's plugin key was withheld).
    expect(await readdir(path.join(run, "cache", "opencode"))).toEqual(["bin"]);
    await chmod(path.join(run, "cache", "opencode"), 0o755);
  },
  180_000,
);
