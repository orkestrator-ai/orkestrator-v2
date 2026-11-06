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
  expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([
    "Stop",
    "StopFailure",
    "UserPromptSubmit",
  ]);
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

test("every ~/.claude.json the entrypoint writes records the auto-mode answer", () => {
  // The file is rebuilt on every start, so a flag Claude Code wrote itself is
  // lost; without this one terminal Claude asks "Make auto mode your default
  // permission mode?" in every new Claude CLI tab after each start.
  const filter = entrypoint.match(
    /jq --argjson keep "\$CLAUDE_JSON_ALLOWED_KEYS" \\\n\s*'([\s\S]*?)' \\\n/,
  )?.[1];
  expect(filter, "the entrypoint filters the staged host ~/.claude.json").toBeDefined();
  const assignments = filter!.match(/^\s*\.[A-Za-z]+ = true \|$/gm)?.map((line) => line.trim());
  expect(assignments).toContain(".hasSeenAutoDefaultNudge = true |");
  expect(assignments).toContain(".bypassPermissionsModeAccepted = true |");

  // The fallback after a failed filter, and the config written with no host file.
  const written = [
    ...entrypoint.matchAll(/cat > "\$HOME\/\.claude\.json" << '(\w+)'\n([\s\S]*?)\n\1\n/g),
  ].map((match) => JSON.parse(match[2]!) as Record<string, unknown>);
  expect(written).toHaveLength(2);
  for (const config of written) {
    expect(config.hasSeenAutoDefaultNudge).toBe(true);
    expect(config.bypassPermissionsModeAccepted).toBe(true);
  }
});

test("the staged host ~/.claude.json keeps the auto-mode answer through the entrypoint's allowlist", () => {
  const keys = entrypoint.match(/^CLAUDE_JSON_ALLOWED_KEYS='(\[[^']*\])'$/m)?.[1];
  expect(keys, "the entrypoint names its ~/.claude.json allowlist").toBeDefined();
  expect(JSON.parse(keys!) as string[]).toContain("hasSeenAutoDefaultNudge");
});
