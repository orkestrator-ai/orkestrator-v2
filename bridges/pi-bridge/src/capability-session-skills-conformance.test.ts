/**
 * Agent Capabilities session-private skills for Pi, against the fake engine
 * (docs/architecture/agent-capabilities-management.md, "Session-private
 * delivery"; 8314 task 2).
 *
 * The real bridge router, the real Pi SDK (`AgentSession`, its resource
 * loader and its JSONL session files) and pi-ai's faux model, the one
 * `testing/fake-engine-server.ts` serves. No credential, no network call and
 * no billed turn. The backend stages a session's private skills into a
 * content-addressed directory under its own root and names it on each of that
 * session's prompts as `capabilityPlugins`; this proves that Pi loads exactly
 * that set for that session through the SDK's per-session skill paths, that
 * the model is told about it, that nothing is written into the shared Pi home,
 * that another session does not see it, and that the no-touch evidence route
 * reports the loaded `SKILL.md` paths the backend grades.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_SESSION_PLUGINS_DIR_ENV } from "@orkestrator/protocol/capability-resources";
import {
  parseCapabilitySessionEvidence,
  type CapabilitySessionEvidence,
} from "@orkestrator/protocol/capability-evidence";

// `config.ts` reads its environment once, at import; see `http.test.ts`.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
process.env.PI_OFFLINE = "1";
delete process.env.PI_BRIDGE_STATE_DIR;
const previous = {
  CWD: process.env.CWD,
  HOME: process.env.HOME,
  PI_AGENT_DIR: process.env.PI_AGENT_DIR,
  PI_SESSION_DIR: process.env.PI_SESSION_DIR,
  [CAPABILITY_SESSION_PLUGINS_DIR_ENV]: process.env[CAPABILITY_SESSION_PLUGINS_DIR_ENV],
};
const base = await realpath(await mkdtemp(join(tmpdir(), "pi-capability-session-skills-")));
const home = join(base, "home");
const agentDir = join(home, ".pi", "agent");
const project = join(base, "project");
const pluginsRoot = join(base, "data", "capability-session-plugins");
await Promise.all([
  mkdir(agentDir, { recursive: true }),
  mkdir(project, { recursive: true }),
  mkdir(pluginsRoot, { recursive: true }),
]);
process.env.CWD = project;
// Pi also reads `~/.agents/skills`; never the developer's.
process.env.HOME = home;
process.env.PI_AGENT_DIR = agentDir;
process.env.PI_SESSION_DIR = join(base, "sessions");
process.env[CAPABILITY_SESSION_PLUGINS_DIR_ENV] = pluginsRoot;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { closeSession, setAgentSessionTestHooks } = await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { nativeFetch } = await import("./testing/native-fetch.js");
const { userPrompts } = await import("./testing/fake-engine-responses.js");
const { ModelRuntime } = await import("./pi-sdk.js");
const { fauxAssistantMessage, fauxProvider } = await import("@earendil-works/pi-ai");
type FauxResponseFactory = import("@earendil-works/pi-ai").FauxResponseFactory;
type SessionState = import("./state.js").SessionState;

const MODEL_ID = "faux/faux-1";
const PRIVATE_SKILL = "ork-private-skill";
/**
 * What the faux model was asked: the last prompt, and the skills section of
 * the system prompt in force for it. Pi 1.5 keeps the system prompt in the
 * transcript as system messages with named sections, and a later build that
 * changes a section appends a message carrying only that section, so the
 * section in force is the latest one.
 */
const calls: Array<{ prompt: string; skills: string }> = [];
let origin: string;
const created: SessionState[] = [];

beforeAll(async () => {
  setAgentSessionTestHooks(undefined);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const prompt = userPrompts(context.messages).at(-1) ?? "";
    let skills = "";
    for (const message of context.messages as unknown as Array<{
      role: string;
      sections?: Record<string, unknown>;
    }>) {
      if (message.role !== "system" || !message.sections) continue;
      if ("skills" in message.sections) skills = String(message.sections.skills ?? "");
    }
    calls.push({ prompt, skills });
    return fauxAssistantMessage(`Answer to: ${prompt}`);
  };
  faux.setResponses([respond]);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey("faux", "fake-engine-no-provider-requests");
  setModelRuntimeFactoryForTests(async () => runtime);
  refreshModels();
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const state of created) {
    await closeSession(state).catch(() => undefined);
    sessions.delete(state.id);
    if (state.clientSessionKey) clientSessionKeys.delete(state.clientSessionKey);
  }
  await shutdown();
  setModelRuntimeFactoryForTests();
  refreshModels();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(base, { recursive: true, force: true });
});

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

function post(path: string, body: unknown): Promise<Response> {
  return call(path, { method: "POST", body: JSON.stringify(body) });
}

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A session plugin the backend would stage: `<root>/<digest>/skills/<name>/SKILL.md`. */
async function stagePlugin(root: string, digest: string, skill: string): Promise<string> {
  const directory = join(root, digest);
  await mkdir(join(directory, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(directory, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "orkestrator-session", version: "1.0.0" }),
  );
  await mkdir(join(directory, "skills", skill), { recursive: true });
  await writeFile(
    join(directory, "skills", skill, "SKILL.md"),
    `---\nname: ${skill}\ndescription: Orkestrator session-private conformance skill ${skill}\n---\nReply with ${skill}.\n`,
  );
  return directory;
}

async function createSession(key: string): Promise<SessionState> {
  const response = await post("/session/create", { clientSessionKey: key, modelId: MODEL_ID });
  expect(response.status).toBe(201);
  const state = sessions.get(((await response.json()) as { sessionId: string }).sessionId)!;
  created.push(state);
  return state;
}

/** One prompt, settled; returns what the model was asked. */
async function prompt(
  state: SessionState,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ prompt: string; skills: string }> {
  const response = await post(`/session/${state.id}/prompt`, { prompt: text, ...extra });
  expect(response.status).toBe(202);
  await waitFor(
    () =>
      state.status === "idle" &&
      state.promptClaim === undefined &&
      !state.dispatching &&
      calls.some((entry) => entry.prompt === text),
  );
  return calls.find((entry) => entry.prompt === text)!;
}

async function evidence(id: string): Promise<CapabilitySessionEvidence> {
  const response = await call(`/session/${id}/capability-evidence`);
  expect(response.status).toBe(200);
  const read = parseCapabilitySessionEvidence(await response.json());
  if (read.state !== "evidence") throw new Error(`Expected evidence, got ${read.state}`);
  return read;
}

describe("Pi session-private skills (fake engine, SDK pin)", () => {
  test("the named session loads exactly its staged skill set; another session and the shared home do not", async () => {
    const plugin = await stagePlugin(pluginsRoot, "a".repeat(40), PRIVATE_SKILL);
    const privateSkillFile = join(plugin, "skills", PRIVATE_SKILL, "SKILL.md");
    const owner = await createSession("capability-owner");
    const other = await createSession("capability-other");

    // Before any load the route answers in band, and an unknown session is `missing`.
    expect(await (await call(`/session/${owner.id}/capability-evidence`)).json()).toEqual({
      state: "none",
    });
    expect(await (await call("/session/no-such-session/capability-evidence")).json()).toEqual({
      state: "missing",
    });

    const ownerCall = await prompt(owner, "owner question", { capabilityPlugins: [plugin] });
    const otherCall = await prompt(other, "other question");

    // The model of the owning session is told about the skill, at its staged path.
    expect(ownerCall.skills).toContain(`<name>${PRIVATE_SKILL}</name>`);
    expect(ownerCall.skills).toContain(privateSkillFile);
    // The other session's model is not.
    expect(otherCall.skills).not.toContain(PRIVATE_SKILL);

    // The SDK's own resolution, as the evidence route reports it.
    const ownerEvidence = await evidence(owner.id);
    expect(ownerEvidence.loadedSkills).toEqual([{ name: PRIVATE_SKILL, path: privateSkillFile }]);
    expect(ownerEvidence.skills).toEqual([PRIVATE_SKILL]);
    expect(ownerEvidence.plugins).toEqual([]);
    const otherEvidence = await evidence(other.id);
    expect(otherEvidence.loadedSkills).toEqual([]);

    // Nothing was written into the shared Pi home or the cross-provider skill directory.
    expect(existsSync(join(agentDir, "skills"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills"))).toBe(false);
    expect((await readdir(plugin)).sort()).toEqual([".claude-plugin", "skills"]);

    // The session's command catalogue lists the skill for that session only.
    const ownerCommands = (await (await call(`/session/${owner.id}/commands`)).json()) as {
      commands?: Array<{ name: string }>;
    };
    expect(ownerCommands.commands?.map((command) => command.name)).toContain(
      `/skill:${PRIVATE_SKILL}`,
    );
    const otherCommands = (await (await call(`/session/${other.id}/commands`)).json()) as {
      commands?: Array<{ name: string }>;
    };
    expect(otherCommands.commands?.map((command) => command.name) ?? []).not.toContain(
      `/skill:${PRIVATE_SKILL}`,
    );
  });

  test("the same set on the next turn keeps the build; a turn naming none rebuilds without it", async () => {
    const plugin = await stagePlugin(pluginsRoot, "b".repeat(40), "ork-frozen-skill");
    const state = await createSession("capability-rebuild");
    const firstCall = await prompt(state, "first turn", { capabilityPlugins: [plugin] });
    expect(firstCall.skills).toContain("ork-frozen-skill");
    const first = await evidence(state.id);
    const live = state.session;

    await prompt(state, "second turn", { capabilityPlugins: [plugin] });
    expect(state.session).toBe(live);
    expect((await evidence(state.id)).generation).toBe(first.generation);

    const dropped = await prompt(state, "third turn");
    expect(state.session).not.toBe(live);
    expect(dropped.skills).not.toContain("ork-frozen-skill");
    const rebuilt = await evidence(state.id);
    expect(rebuilt.generation).toBe(first.generation + 1);
    expect(rebuilt.loadedSkills).toEqual([]);
  });

  test("a staged skill wins over a shared namesake on attach and on resource reload", async () => {
    const skill = "ork-collision";
    const plugin = await stagePlugin(pluginsRoot, "f".repeat(40), skill);
    const stagedFile = join(plugin, "skills", skill, "SKILL.md");
    const sharedDir = join(agentDir, "skills", skill);
    await mkdir(sharedDir, { recursive: true });
    const sharedFile = join(sharedDir, "SKILL.md");
    await writeFile(
      sharedFile,
      `---\nname: ${skill}\ndescription: Shared copy\n---\nShared instructions.\n`,
    );
    try {
      const owner = await createSession("capability-collision");
      const first = await prompt(owner, "collision before reload", { capabilityPlugins: [plugin] });
      expect(first.skills).toContain(stagedFile);
      expect(first.skills).not.toContain(sharedFile);
      const before = await evidence(owner.id);
      const live = owner.session;
      const addedDir = join(agentDir, "skills", "ork-reload-only");
      await mkdir(addedDir, { recursive: true });
      const addedFile = join(addedDir, "SKILL.md");
      await writeFile(
        addedFile,
        "---\nname: ork-reload-only\ndescription: Added before reload\n---\n",
      );
      const refreshed = await post(`/session/${owner.id}/commands/refresh`, {});
      expect(refreshed.status).toBe(200);
      const after = await evidence(owner.id);
      expect(owner.session).toBe(live);
      expect(after.generation).toBe(before.generation + 1);
      expect(after.loadedSkills).toEqual([
        { name: skill, path: stagedFile },
        { name: "ork-reload-only", path: addedFile },
      ]);
      const second = await prompt(owner, "collision after reload", { capabilityPlugins: [plugin] });
      expect(second.skills).toContain(stagedFile);
      expect(second.skills).not.toContain(sharedFile);
      const unrelated = await createSession("capability-collision-unrelated");
      expect((await prompt(unrelated, "shared copy only")).skills).toContain(sharedFile);
    } finally {
      await rm(join(agentDir, "skills"), { recursive: true, force: true });
    }
  });

  test("a read-only turn loads none of the session's private skills", async () => {
    const plugin = await stagePlugin(pluginsRoot, "c".repeat(40), "ork-readonly-skill");
    const state = await createSession("capability-read-only");
    const asked = await prompt(state, "read-only turn", {
      capabilityPlugins: [plugin],
      readOnly: true,
    });
    expect(asked.skills).not.toContain("ork-readonly-skill");
    expect((await evidence(state.id)).loadedSkills).toEqual([]);
  });

  test("a directory outside the backend's root, or a link inside it, is never loaded", async () => {
    const outside = await stagePlugin(join(base, "elsewhere"), "d".repeat(40), "ork-outside");
    const linked = join(pluginsRoot, "e".repeat(40));
    await symlink(outside, linked);
    const state = await createSession("capability-refused");
    const asked = await prompt(state, "refused turn", { capabilityPlugins: [outside, linked] });
    expect(asked.skills).not.toContain("ork-outside");
    expect((await evidence(state.id)).loadedSkills).toEqual([]);
  });
});
