/**
 * Agent Capabilities conformance for Pi (docs/architecture/agent-capabilities-management.md,
 * "Provider support"; 8314 task 1).
 *
 * The capability executor writes skills and prompt templates into the
 * directories the support table says Pi reads. This asks the pinned Pi SDK's
 * own resource loader, the one a session's attach and the bridge's command
 * catalogue use, whether it lists them. The SDK and the pinned `pi` binary are
 * the same version (`tests/unit/version-drift.test.ts`), and the listing needs
 * no credential, no network and no model.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newSessionState, piResourceLoaderPolicy } from "./agent-session.js";
import { readResourceCommands } from "./command-preview.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Orkestrator conformance skill ${name}\n---\nReply with ${name}.\n`;

/** A fresh HOME and agent directory, as the executor's homes resolve them. */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "ork-pi-capability-conformance-"));
  roots.push(root);
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { home, agentDir, cwd };
}

async function listed(
  box: { home: string; agentDir: string; cwd: string },
  projectResources = true,
): Promise<string[]> {
  const previous = process.env.HOME;
  process.env.HOME = box.home;
  try {
    const state = newSessionState(undefined, {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "auto-approve",
      projectResources,
      networkAccess: "full",
    });
    const result = await readResourceCommands({
      cwd: box.cwd,
      agentDir: box.agentDir,
      policy: piResourceLoaderPolicy(state),
    });
    return result.commands.map((command) => command.name);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

describe("Pi loads what the capability executor delivers (SDK pin)", () => {
  test("a skill in ~/.pi/agent/skills (pi-user-skills) is listed, and gone after removal", async () => {
    const box = await sandbox();
    const directory = join(box.agentDir, "skills", "ork-pi-skill");
    await write(join(directory, "SKILL.md"), skill("ork-pi-skill"));
    expect(await listed(box)).toContain("/skill:ork-pi-skill");
    await rm(directory, { recursive: true });
    expect(await listed(box)).not.toContain("/skill:ork-pi-skill");
  });

  test("a skill in ~/.agents/skills (agents-shared-skills) is listed", async () => {
    const box = await sandbox();
    await write(join(box.home, ".agents", "skills", "ork-shared", "SKILL.md"), skill("ork-shared"));
    expect(await listed(box)).toContain("/skill:ork-shared");
  });

  test("with project resources off (the host default) the user's deliveries load and the project's do not", async () => {
    const box = await sandbox();
    await write(join(box.agentDir, "skills", "ork-user", "SKILL.md"), skill("ork-user"));
    await write(join(box.home, ".agents", "skills", "ork-shared", "SKILL.md"), skill("ork-shared"));
    await write(join(box.agentDir, "prompts", "ork-prompt.md"), "---\ndescription: p\n---\nSay\n");
    await write(join(box.cwd, ".pi", "skills", "ork-repo", "SKILL.md"), skill("ork-repo"));
    await write(
      join(box.cwd, ".pi", "prompts", "ork-repo-prompt.md"),
      "---\ndescription: p\n---\nx\n",
    );
    const names = await listed(box, false);
    expect(names).toEqual(
      expect.arrayContaining(["/skill:ork-user", "/skill:ork-shared", "/ork-prompt"]),
    );
    expect(names).not.toContain("/skill:ork-repo");
    expect(names).not.toContain("/ork-repo-prompt");
  });

  test("Pi does not read ~/.claude/skills, so a copy there never reaches it", async () => {
    const box = await sandbox();
    await write(join(box.home, ".claude", "skills", "ork-claude", "SKILL.md"), skill("ork-claude"));
    expect(await listed(box)).not.toContain("/skill:ork-claude");
  });

  test("a prompt template in ~/.pi/agent/prompts (pi-user-prompts) is listed", async () => {
    const box = await sandbox();
    await write(
      join(box.agentDir, "prompts", "ork-prompt.md"),
      "---\ndescription: Orkestrator conformance prompt\n---\nSay $@\n",
    );
    expect(await listed(box)).toContain("/ork-prompt");
  });
});
