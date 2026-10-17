import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { AGENT_TEST_HOST_PI_AGENT_DIR_ENV } from "./commands-runtime-state.js";
import { applyPiHostCredentialEnvironment } from "./host-agent-credentials.js";

let root: string;
let hostAgentDir: string;
const previousHostAgentDir = process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV];

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return { runtimeFlavor: "production", ...overrides } as CommandContext;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pi-host-credential-"));
  hostAgentDir = path.join(root, "host-home", ".pi", "agent");
  process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV] = hostAgentDir;
});

afterEach(async () => {
  if (previousHostAgentDir === undefined) delete process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV];
  else process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV] = previousHostAgentDir;
  await fs.rm(root, { recursive: true, force: true });
});

describe("applyPiHostCredentialEnvironment", () => {
  test("leaves a production bridge on Pi's own default directory", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(path.join(hostAgentDir, "auth.json"), "{}");
    const env: NodeJS.ProcessEnv = { PI_AGENT_DIR: "/leaked", PI_BRIDGE_AUTH_FILE: "/leaked" };

    await applyPiHostCredentialEnvironment(context(), env);

    expect(env.PI_AGENT_DIR).toBeUndefined();
    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
  });

  test("shares only the host auth file with an authorized agent-test profile", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(path.join(hostAgentDir, "auth.json"), "{}");
    const env: NodeJS.ProcessEnv = { PI_AGENT_DIR: "/leaked" };

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      env,
    );

    expect(env.PI_AGENT_DIR).toBeUndefined();
    expect(env.PI_BRIDGE_AUTH_FILE).toBe(path.join(hostAgentDir, "auth.json"));
  });

  test("gives a profile that did not authorize Pi no host path", async () => {
    await fs.mkdir(hostAgentDir, { recursive: true });
    await fs.writeFile(path.join(hostAgentDir, "auth.json"), "{}");
    const env: NodeJS.ProcessEnv = {};

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["claude"]) }),
      env,
    );

    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
  });

  test("never names a host auth file that does not exist", async () => {
    // Pi creates a missing credential file and its directory; the host's Pi
    // home must stay exactly as it was.
    const env: NodeJS.ProcessEnv = {};

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      env,
    );

    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
    expect(await fs.stat(path.join(root, "host-home")).catch(() => null)).toBeNull();
  });

  test("ignores a directory where the auth file should be", async () => {
    await fs.mkdir(path.join(hostAgentDir, "auth.json"), { recursive: true });
    const env: NodeJS.ProcessEnv = {};

    await applyPiHostCredentialEnvironment(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      env,
    );

    expect(env.PI_BRIDGE_AUTH_FILE).toBeUndefined();
  });
});
