import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  BRIDGE_EXECUTION_POLICY_ENV,
  coordinatorProcessPolicy,
  createPiSessionServices,
  newSessionState,
  piResourceLoaderPolicy,
} from "./agent-session.js";

/**
 * A Pi coordinator loads the user's and the checkout's skills, against the
 * real pinned SDK, while the project stays untrusted and no extension loads.
 */
const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

const globals = globalThis as { __orkCoordinatorSkillsLoaded?: string[] };
let previousPolicy: string | undefined;
let previousHome: string | undefined;
beforeEach(() => {
  previousPolicy = process.env[BRIDGE_EXECUTION_POLICY_ENV];
  // Pi finds `~/.agents/skills` through HOME; never the developer's own.
  previousHome = process.env.HOME;
});
afterEach(() => {
  delete globals.__orkCoordinatorSkillsLoaded;
  if (previousPolicy === undefined) delete process.env[BRIDGE_EXECUTION_POLICY_ENV];
  else process.env[BRIDGE_EXECUTION_POLICY_ENV] = previousPolicy;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nSteps.\n`;
const extension = (name: string) => `
globalThis.__orkCoordinatorSkillsLoaded = [...(globalThis.__orkCoordinatorSkillsLoaded ?? []), ${JSON.stringify(name)}];
export default function () {}
`;

async function fixture(): Promise<{ cwd: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ork-pi-coordinator-skills-"));
  directories.push(root);
  const cwd = join(root, "checkout");
  const agentDir = join(root, "agent");
  process.env.HOME = join(root, "home");
  await write(join(root, "home/.agents/skills/shared/SKILL.md"), skill("shared"));
  await write(join(agentDir, "skills/mine/SKILL.md"), skill("mine"));
  await write(join(agentDir, "extensions/user-probe.js"), extension("user-probe"));
  await write(join(agentDir, "settings.json"), "{}");
  await write(join(cwd, ".pi/skills/pi-local/SKILL.md"), skill("pi-local"));
  await write(join(cwd, ".agents/skills/agents-local/SKILL.md"), skill("agents-local"));
  await write(join(cwd, ".claude/skills/release/SKILL.md"), skill("release"));
  await write(join(cwd, ".pi/extensions/project-probe.js"), extension("project-probe"));
  // Project settings only an untrusted project leaves unread.
  await write(join(cwd, ".pi/settings.json"), JSON.stringify({ defaultModel: "project-model" }));
  return { cwd, agentDir };
}

async function skillsFor(
  state: ReturnType<typeof newSessionState>,
  cwd: string,
  agentDir: string,
): Promise<string[]> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const services = await createPiSessionServices(state, { cwd, agentDir, settingsManager });
  return services.resourceLoader
    .getSkills()
    .skills.map((loaded) => loaded.name)
    .toSorted();
}

describe("Pi coordinator skills", () => {
  test("a coordinator loads the user's and the checkout's skills, and no extension", async () => {
    const { cwd, agentDir } = await fixture();
    process.env[BRIDGE_EXECUTION_POLICY_ENV] = "coordinator-read-only";
    const state = newSessionState(undefined, coordinatorProcessPolicy());
    // As the bridge sets it for a coordinator policy (`ensureSession`).
    state.readOnly = true;
    expect(piResourceLoaderPolicy(state, cwd)).toMatchObject({
      discovery: { noExtensions: true, noSkills: false },
      projectTrusted: false,
    });
    expect(await skillsFor(state, cwd, agentDir)).toEqual([
      "agents-local",
      "mine",
      "pi-local",
      "release",
      "shared",
    ]);
    expect(globals.__orkCoordinatorSkillsLoaded).toBeUndefined();
  });

  test("the same policy outside a coordinator process loads none", async () => {
    const { cwd, agentDir } = await fixture();
    delete process.env[BRIDGE_EXECUTION_POLICY_ENV];
    const state = newSessionState(undefined, coordinatorProcessPolicy());
    state.readOnly = true;
    expect(piResourceLoaderPolicy(state, cwd).discovery.noSkills).toBe(true);
    expect(await skillsFor(state, cwd, agentDir)).toEqual([]);
  });
});
