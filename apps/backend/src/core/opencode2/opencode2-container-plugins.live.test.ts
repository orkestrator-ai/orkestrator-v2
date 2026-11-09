import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import {
  OPENCODE2_GITHUB_ENV_PLUGIN_ID,
  buildOpenCode2GitHubEnvironmentPluginSource,
  openCode2ContainerPlugins,
} from "./container-server.js";
import { OPENCODE2_FLAGS } from "./server.js";
import { mintOpenCode2InputId } from "./steer.js";

/**
 * The plugins a container's 2.x server is started with, against the real
 * pinned binary: the agent's shell gets the managed GitHub token from its
 * file, read per shell, and never the server password. The container's 1.x
 * plugins sit in the shared config directory, as they do in a container, and
 * do not stop 2.x. Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH. The
 * token is a fake; nothing leaves the machine (the model is scripted).
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const liveTest = process.env.RUN_LIVE_OPENCODE2 === "1" && binary ? test : test.skip;

const FAKE_TOKEN = "ghp_fakeOrkestratorTestToken0000000000";

let fixture: OpenCode2Fixture | undefined;
let root: string | undefined;
afterEach(async () => {
  await fixture?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  fixture = undefined;
  root = undefined;
});

/** What the agent's shell sees, as SET/empty and a length; never the values. */
const PROBE =
  "RUN_BASH:echo PW=${OPENCODE_PASSWORD:+SET} GH=${GH_TOKEN:+SET} GT=${GITHUB_TOKEN:+SET} LEN=${#GH_TOKEN} END";

async function shellSees(f: OpenCode2Fixture): Promise<string> {
  const client = new OpenCode2Client({
    baseUrl: f.baseUrl,
    password: f.password,
    directory: f.directory,
  });
  const session = await client.createSession({ model: { providerID: "fixture", id: "fixture" } });
  await client.prompt(session.id, { id: mintOpenCode2InputId(), text: PROBE, delivery: "steer" });
  for (let attempt = 0; attempt < 150; attempt++) {
    const rows = (await client.listMessages(session.id, { limit: 20, order: "asc" }))
      .messages as Array<{ content?: Array<{ type: string; state?: { content?: unknown } }> }>;
    const tool = rows.flatMap((row) => row.content ?? []).find((part) => part.type === "tool");
    const output = JSON.stringify(tool?.state?.content ?? "");
    if (output.includes("END")) return output;
    await Bun.sleep(100);
  }
  throw new Error("the shell tool never answered");
}

liveTest(
  "a container 2.x server's shells get the managed GitHub token and never its password",
  async () => {
    root = await mkdtemp(path.join(tmpdir(), "ork-opencode2-container-plugins-"));
    const credentialFile = path.join(root, "orkestrator-ai", "github-token");
    const configDir = path.join(root, "orkestrator-opencode2");
    for (const plugin of openCode2ContainerPlugins()) {
      const source =
        plugin.id === OPENCODE2_GITHUB_ENV_PLUGIN_ID
          ? buildOpenCode2GitHubEnvironmentPluginSource(credentialFile)
          : plugin.source;
      await mkdir(path.join(configDir, "plugins", plugin.id), { recursive: true });
      await writeFile(path.join(configDir, "plugins", plugin.id, "index.ts"), source);
    }
    // A container's 1.x plugins, in the config directory both lines read.
    const xdgConfig = path.join(root, "xdg-config");
    await mkdir(path.join(xdgConfig, "opencode", "plugins"), { recursive: true });
    await writeFile(
      path.join(xdgConfig, "opencode", "plugins", "orkestrator-github-env.js"),
      'export const OrkestratorGitHubEnvironmentPlugin = async () => ({ "shell.env": async () => {} });\n',
    );

    fixture = await startOpenCode2Fixture(binary!, {
      env: {
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_FLAGS: OPENCODE2_FLAGS,
        XDG_CONFIG_HOME: xdgConfig,
      },
    });
    // No token file yet: nothing added, and no password either.
    expect(await shellSees(fixture)).toContain("PW= GH= GT= LEN=0 END");

    // A token synced while the server runs reaches the next shell.
    await mkdir(path.dirname(credentialFile), { recursive: true });
    await writeFile(credentialFile, `${FAKE_TOKEN}\n`, { mode: 0o600 });
    expect(await shellSees(fixture)).toContain(`PW= GH=SET GT=SET LEN=${FAKE_TOKEN.length} END`);

    // The server still authenticates with the password its plugin removed.
    const client = new OpenCode2Client({
      baseUrl: fixture.baseUrl,
      password: fixture.password,
      directory: fixture.directory,
    });
    expect((await client.info()).version.startsWith("2.")).toBe(true);
  },
  180_000,
);
