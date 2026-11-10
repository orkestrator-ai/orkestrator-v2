/**
 * How a host OpenCode 1.x server is given Orkestrator's plugins (to-do 7402):
 * through Orkestrator's own `OPENCODE_CONFIG_DIR`, or, when the user named a
 * directory of their own, through `OPENCODE_CONFIG_CONTENT`'s plugin list; and
 * a coordinator's server refused when neither is possible. The pinned binary
 * loading those entries is qualified offline in
 * `opencode-coordinator-read-boundary-live.test.ts`.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCODE_CREDENTIAL_PLUGIN_FILE } from "./agent-credential-files.js";
import {
  installHostOpenCodePlugins,
  OpenCodeCoordinatorReadBoundaryUnavailableError,
} from "./opencode-host-credential.js";
import {
  buildOpenCodeReadBoundaryPluginSource,
  OPENCODE_READ_BOUNDARY_PLUGIN_FILE,
} from "./opencode-read-boundary-plugin.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-opencode-host-plugins-"));
  directories.push(directory);
  return directory;
}

function pluginUrls(dataDir: string): string[] {
  return [OPENCODE_CREDENTIAL_PLUGIN_FILE, OPENCODE_READ_BOUNDARY_PLUGIN_FILE].map(
    (file) => pathToFileURL(path.join(dataDir, "opencode-host-config", "plugins", file)).href,
  );
}

test("with no user directory, Orkestrator's directory carries the plugins", async () => {
  const dataDir = await dataDirectory();
  const env: Record<string, string | undefined> = {};
  expect(await installHostOpenCodePlugins(env, dataDir, { coordinator: true })).toEqual({
    mode: "config-dir",
  });
  expect(env.OPENCODE_CONFIG_DIR).toBe(path.join(dataDir, "opencode-host-config"));
  expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
});

test("a user directory is kept and the plugins are added as config entries", async () => {
  const dataDir = await dataDirectory();
  const env: Record<string, string | undefined> = { OPENCODE_CONFIG_DIR: "/home/me/opencode" };
  expect(await installHostOpenCodePlugins(env, dataDir, { coordinator: true })).toEqual({
    mode: "config-content",
  });
  expect(env.OPENCODE_CONFIG_DIR).toBe("/home/me/opencode");
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ plugin: pluginUrls(dataDir) });
  // The entries name files that exist, written whole.
  const readBoundary = new URL(pluginUrls(dataDir)[1]!);
  expect(await readFile(readBoundary, "utf8")).toBe(buildOpenCodeReadBoundaryPluginSource());
});

test("the user's own inline configuration and plugins are kept", async () => {
  const dataDir = await dataDirectory();
  const ours = pluginUrls(dataDir);
  const env: Record<string, string | undefined> = {
    OPENCODE_CONFIG_DIR: "/home/me/opencode",
    // JSONC, as OpenCode reads it, with a substitution token it expands later.
    OPENCODE_CONFIG_CONTENT: `{
      // the user's own
      "model": "anthropic/claude",
      "provider": { "x": { "options": { "apiKey": "{env:X_KEY}" } } },
      "plugin": ["opencode-user-plugin", "${ours[0]}"],
    }`,
  };
  await installHostOpenCodePlugins(env, dataDir, { coordinator: false });
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
    model: "anthropic/claude",
    provider: { x: { options: { apiKey: "{env:X_KEY}" } } },
    // Never listed twice, and the user's own first.
    plugin: ["opencode-user-plugin", ...ours],
  });
});

for (const [label, content] of [
  ["unparseable", "{ not json"],
  ["not an object", '["a"]'],
  ["a plugin entry that is not a list of strings", '{ "plugin": "one" }'],
] as const) {
  test(`a coordinator's server is refused when the user's inline configuration is ${label}`, async () => {
    const dataDir = await dataDirectory();
    const env: Record<string, string | undefined> = {
      OPENCODE_CONFIG_DIR: "/home/me/opencode",
      OPENCODE_CONFIG_CONTENT: content,
    };
    const refusal = await installHostOpenCodePlugins(env, dataDir, { coordinator: true }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(OpenCodeCoordinatorReadBoundaryUnavailableError);
    // The message never quotes the content, which may carry secrets.
    expect((refusal as Error).message).not.toContain(content);
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(content);

    // Any other server starts without the plugins, as it always has.
    expect(await installHostOpenCodePlugins(env, dataDir, { coordinator: false })).toEqual({
      mode: "skipped",
      reason: "config-content-unusable",
    });
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(content);
    expect(env.OPENCODE_CONFIG_DIR).toBe("/home/me/opencode");
  });
}
