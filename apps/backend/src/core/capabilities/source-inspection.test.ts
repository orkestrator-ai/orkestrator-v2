import { compareCapabilityRevisions } from "@orkestrator/protocol/capability-resources-resolve";
import { describe, expect, test } from "bun:test";

import { assertFetchableRepo, inspectFiles } from "./source-inspection.js";
import { validatePackageFiles } from "./security.js";

const files = (entries: Record<string, string>, executable: string[] = []) =>
  validatePackageFiles(
    Object.entries(entries).map(([path, content]) => ({
      path,
      content: Buffer.from(content),
      executable: executable.includes(path),
    })),
  );

const source = { kind: "managed" as const, managedId: "m1" };

describe("inspection", () => {
  test("a plugin's skill, MCP server and hook are separate components with their own risk", () => {
    const inspected = inspectFiles(
      source,
      files({
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "quality",
          description: "Quality tools",
          author: { name: "Team" },
        }),
        "skills/review/SKILL.md": "---\nname: review\ndescription: Reviews code\n---\nBody",
        "skills/review/scripts/lint.sh": "#!/bin/sh",
        "hooks/hooks.json": JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
          },
        }),
        ".mcp.json": JSON.stringify({
          mcpServers: {
            docs: {
              type: "http",
              url: "https://docs.example.com/mcp",
              headers: { Authorization: "Bearer abc123" },
            },
          },
        }),
      }),
    );
    const kinds = Object.fromEntries(
      inspected.components.map((component) => [component.kind, component]),
    );
    expect(inspected.displayName).toBe("quality");
    expect(inspected.publisher).toBe("Team");
    expect(kinds.skill?.risk).toBe("executable");
    expect(kinds.hook?.risk).toBe("privileged");
    expect(kinds.hook?.executes).toEqual(["./guard.sh"]);
    expect(kinds.hook?.triggers).toEqual(["PreToolUse"]);
    expect(kinds["mcp-server"]?.endpoints?.[0]).toBe("docs.example.com");
    expect(
      inspected.files.find((file) => file.path === ".mcp.json")?.content.toString(),
    ).not.toContain("abc123");
    expect(kinds["mcp-server"]?.requirements.envRefs).toEqual(["Authorization"]);
    expect(kinds["native-plugin"]?.risk).toBe("privileged");
    expect(kinds.skill?.dependencies).toEqual([kinds["native-plugin"]!.id]);
    expect(
      inspected.warnings.some((warning) =>
        warning.includes("literal environment or header values were removed"),
      ),
    ).toBe(true);
    expect(inspected.risk).toBe("privileged");
  });

  test("MCP argument and same-host path changes escalate with redacted metadata", () => {
    const components = (definition: object) =>
      inspectFiles(
        source,
        files({
          ".mcp.json": JSON.stringify({ docs: definition }),
        }),
      ).components;
    const local = { command: "local-tool", args: ["--default"] };
    const remote = { url: "https://example.com/one" };
    expect(
      compareCapabilityRevisions(
        components(local),
        components({ ...local, args: ["--different"] }),
      )[0]?.escalation,
    ).toContain("MCP server");
    const changedRemote = components({ url: "https://example.com/two" });
    expect(changedRemote[0]?.endpoints).toEqual(["example.com"]);
    expect(compareCapabilityRevisions(components(remote), changedRemote)[0]?.escalation).toContain(
      "MCP server",
    );
  });

  test("a skill's nested reference SKILL.md is not a second skill", () => {
    const inspected = inspectFiles(
      source,
      files({
        "SKILL.md": "---\nname: top\n---\n",
        "references/inner/SKILL.md": "---\nname: inner\n---\n",
      }),
    );
    expect(inspected.components.map((component) => component.name)).toEqual(["top"]);
  });

  test("secrets are reported by kind", () => {
    const inspected = inspectFiles(
      source,
      files({ "SKILL.md": "---\nname: a\n---\nkey AKIAABCDEFGHIJKLMNOP", ".env": "X=1" }),
    );
    expect(inspected.secretsFound.sort()).toEqual(["AWS access key", "environment file"]);
  });

  test("an empty source is refused", () => {
    expect(() => inspectFiles(source, files({ "README.txt": "hi" }))).toThrow("No skill");
  });

  test("only https and SSH repositories can be fetched", () => {
    expect(() => assertFetchableRepo("https://github.com/a/b")).not.toThrow();
    expect(() => assertFetchableRepo("git@github.com:a/b.git")).not.toThrow();
    for (const bad of [
      "/home/me/repo",
      "file:///etc",
      "ext::sh -c id",
      "--upload-pack=x",
      "http://insecure/x",
      "https://user:synthetic-password@github.com/a/b",
      "https://synthetic-token@github.com/a/b",
    ]) {
      expect(() => assertFetchableRepo(bad)).toThrow();
    }
  });
});
