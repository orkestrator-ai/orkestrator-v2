import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV } from "@orkestrator/protocol/coordinator";

import { resolveClaudeDiscoveryConfig, resolveClaudeTurnPlugins } from "./claude-query-config.js";
import { BRIDGE_EXECUTION_POLICY_ENV, coordinatorProcessPolicy } from "./read-only-policy.js";
import {
  claudeLaunchConflict,
  claudeLaunchProfile,
  claudeLaunchResourceProfile,
} from "./session-manager-runtime.js";
import {
  createSession,
  nextQueryCall,
  sendPrompt,
  track,
  withTemporaryClaudeHome,
  withWorkspaceCwd,
} from "./session-manager-test-harness.js";

/**
 * A coordinator loads the user's and the project's skills, mirrored into
 * plugins without their hooks or tool grants, and nothing else from either
 * settings layer. A skill that names Write in `allowed-tools` still cannot
 * write: the tool stays denied by name and by the bridge's own hook.
 */
const GREEDY_SKILL = [
  "---",
  "name: release",
  "description: Cut a release.",
  "allowed-tools: Write, Edit, Bash(*), EnterWorktree",
  "hooks:",
  "  Stop:",
  "    - hooks:",
  "        - type: command",
  "          command: touch /tmp/should-not-run",
  "---",
  "Write the changelog, then run !`git tag v1`.",
  "",
].join("\n");

async function withCheckout<T>(
  run: (paths: { checkout: string; userSkills: string; home: string }) => Promise<T>,
): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coordinator-skills-session-")));
  const checkout = join(root, "checkout");
  const userSkills = join(root, "user-claude", "skills");
  for (const [dir, name] of [
    [join(checkout, ".claude", "skills"), "release"],
    [userSkills, "notes"],
  ] as const) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      name === "release" ? GREEDY_SKILL : "---\nname: notes\ndescription: Take notes.\n---\nb\n",
    );
  }
  // Settings a worker would load, and a coordinator must not.
  writeFileSync(
    join(checkout, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
  );
  try {
    return await withTemporaryClaudeHome("coordinator-skills-home-", (home) =>
      withWorkspaceCwd(checkout, () => run({ checkout, userSkills, home })),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withCoordinatorProcess<T>(userSkills: string, run: () => Promise<T>): Promise<T> {
  const previous = {
    policy: process.env[BRIDGE_EXECUTION_POLICY_ENV],
    skills: process.env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV],
  };
  process.env[BRIDGE_EXECUTION_POLICY_ENV] = "coordinator-read-only";
  process.env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV] = userSkills;
  try {
    return await run();
  } finally {
    if (previous.policy === undefined) delete process.env[BRIDGE_EXECUTION_POLICY_ENV];
    else process.env[BRIDGE_EXECUTION_POLICY_ENV] = previous.policy;
    if (previous.skills === undefined) delete process.env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV];
    else process.env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV] = previous.skills;
  }
}

async function preToolUse(hooks: HookCallback[], toolName: string, toolInput: unknown) {
  for (const hook of hooks) {
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput } as never,
      "tool-use",
      { signal: new AbortController().signal },
    );
    const decision = (output as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput?.permissionDecision;
    if (decision) return decision;
  }
  return undefined;
}

describe("coordinator skills", () => {
  test("a coordinator turn loads both skill sets as mirrored plugins and nothing else", async () => {
    await withCheckout(({ userSkills, home }) =>
      withCoordinatorProcess(userSkills, async () => {
        const session = createSession("coordinator-skills");
        track(session.id);
        session.executionPolicy = coordinatorProcessPolicy();
        const prompt = sendPrompt(session.id, "release it");
        const call = await nextQueryCall();
        const { options } = call;

        // Still no settings layer: its hooks, permissions, env, MCP servers
        // and CLAUDE.md stay out.
        expect(options.settingSources).toEqual([]);
        expect(options.disallowedTools).toContain("ProposeGoal");
        const mirrors = join(home, ".claude", "orkestrator", "coordinator-skills");
        const paths = (options.plugins ?? []).map((plugin) => plugin.path);
        expect(paths).toHaveLength(2);
        expect(paths.every((path) => path.startsWith(mirrors))).toBe(true);
        expect(
          readdirSync(mirrors)
            .toSorted()
            .map((name) => name.split("-")[0]),
        ).toEqual(["project", "user"]);
        // Each mirrored skill is allowed by name; Write is not, whatever the
        // skill's `allowed-tools` says.
        expect(options.allowedTools).toEqual(
          expect.arrayContaining(["Skill(user-skills:notes)", "Skill(project-skills:release)"]),
        );
        expect(options.allowedTools).not.toContain("Skill");
        for (const tool of ["Write", "Edit", "EnterWorktree", "PowerShell"]) {
          expect(options.allowedTools).not.toContain(tool);
          expect(options.disallowedTools).toContain(tool);
        }
        // No plugin or skill hook and no skill inline shell, at the policy layer.
        expect(options.managedSettings).toEqual({
          allowManagedHooksOnly: true,
          disableSkillShellExecution: true,
        });
        // The bridge's own hook refuses a granted Write and an unvetted shell.
        const hooks = options.hooks!.PreToolUse!.flatMap((matcher) => matcher.hooks);
        expect(await preToolUse(hooks, "Write", { file_path: "x", content: "y" })).toBe("deny");
        expect(await preToolUse(hooks, "EnterWorktree", { name: "x" })).toBe("deny");
        expect(await preToolUse(hooks, "Bash", { command: "git tag v1" })).toBe("deny");
        expect(await preToolUse(hooks, "Bash", { command: "bash scripts/tag.sh" })).toBe("deny");

        call.push({ type: "result", subtype: "success" });
        call.finish();
        await prompt;
      }),
    );
  });

  test("the command-discovery probe sees the same plugins and managed settings", async () => {
    await withCheckout(({ userSkills }) =>
      withCoordinatorProcess(userSkills, async () => {
        const config = await resolveClaudeDiscoveryConfig(coordinatorProcessPolicy(), {
          readOnly: false,
          includeLocalSettings: false,
        });
        expect(config.settingSources).toEqual([]);
        expect(config.plugins).toHaveLength(2);
        expect(config.managedSettings).toEqual({
          allowManagedHooksOnly: true,
          disableSkillShellExecution: true,
        });
      }),
    );
  });

  test("a changed skill set is a launch conflict, so a warm CLI is replaced", async () => {
    await withCheckout(({ checkout, userSkills }) =>
      withCoordinatorProcess(userSkills, async () => {
        const session = createSession("coordinator-skills-fingerprint");
        track(session.id);
        session.executionPolicy = coordinatorProcessPolicy();
        const launch = async () => ({
          ...claudeLaunchProfile(session, undefined),
          ...claudeLaunchResourceProfile(
            (await resolveClaudeTurnPlugins(checkout, coordinatorProcessPolicy(), [])).plugins,
            {},
          ),
        });
        const before = await launch();
        expect(claudeLaunchConflict(before, await launch())).toBeUndefined();

        mkdirSync(join(userSkills, "deploy"));
        writeFileSync(join(userSkills, "deploy", "SKILL.md"), "---\nname: deploy\n---\nShip.\n");
        const added = await launch();
        expect(claudeLaunchConflict(before, added)).toBe("plugins");

        writeFileSync(
          join(checkout, ".claude", "skills", "release", "SKILL.md"),
          "---\nname: release\ndescription: Edited.\n---\nb\n",
        );
        expect(claudeLaunchConflict(added, await launch())).toBe("plugins");
      }),
    );
  });

  test("a worker turn reads its skills through its own settings, unmirrored", async () => {
    await withCheckout(async () => {
      const session = createSession("worker-skills");
      track(session.id);
      const prompt = sendPrompt(session.id, "release it");
      const call = await nextQueryCall();
      expect(call.options.settingSources).toEqual(["user", "project"]);
      expect(call.options.plugins).toBeUndefined();
      expect(call.options.managedSettings).toBeUndefined();
      expect(call.options.allowedTools?.some((tool) => tool.startsWith("Skill("))).toBe(false);
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
    });
  });

  test("a read-only review in a worker bridge drops plugin hooks but loads no mirrored skills", async () => {
    await withCheckout(async () => {
      const session = createSession("worker-review-skills");
      track(session.id);
      const prompt = sendPrompt(session.id, "review", { readOnly: true });
      const call = await nextQueryCall();
      expect(call.options.settingSources).toEqual([]);
      expect(call.options.plugins).toBeUndefined();
      expect(call.options.managedSettings).toEqual({
        allowManagedHooksOnly: true,
        disableSkillShellExecution: true,
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
    });
  });
});
