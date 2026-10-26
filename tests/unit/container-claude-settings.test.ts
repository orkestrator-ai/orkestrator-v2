import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_PINNED_RUNTIME_ENV } from "@orkestrator/protocol/terminal-agent-launch";

const docker = (name: string) =>
  readFileSync(path.join(import.meta.dir, "../../docker", name), "utf8");
const entrypoint = docker("entrypoint.sh");
const body = entrypoint.match(
  /cat > "\$HOME\/\.claude\/settings\.json" << 'EOF'\n([\s\S]*?)\nEOF\n/,
)?.[1];

test("container Claude settings start terminal Claude in bypass mode without a consent dialog", () => {
  expect(body, "the entrypoint writes ~/.claude/settings.json").toBeDefined();
  const settings = JSON.parse(body!) as {
    skipDangerousModePermissionPrompt?: unknown;
    permissions?: { defaultMode?: unknown };
    hooks?: Record<string, unknown>;
  };
  expect(settings.permissions?.defaultMode).toBe("bypassPermissions");
  // Current Claude Code reads the consent only from settings; the file is
  // rewritten on every start, so without it every start asks again.
  expect(settings.skipDangerousModePermissionPrompt).toBe(true);
  expect(Object.keys(settings.hooks ?? {}).sort()).toEqual(["Stop", "UserPromptSubmit"]);
});

test("the image keeps its pinned Claude CLI on its pin, as the host does", () => {
  const env = new Map<string, string>();
  for (const line of docker("Dockerfile").split("\n")) {
    if (!line.startsWith("ENV ")) continue;
    for (const pair of line.slice(4).trim().split(/\s+/)) {
      const [name, ...value] = pair.split("=");
      if (name && value.length > 0) env.set(name, value.join("="));
    }
  }
  for (const [name, value] of Object.entries(CLAUDE_PINNED_RUNTIME_ENV)) {
    expect(env.get(name), name).toBe(value);
  }
});
