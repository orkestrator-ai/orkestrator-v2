import { describe, expect, test } from "bun:test";
import {
  claudeConnection,
  codexConnection,
  grokConnection,
  httpProvider,
  piConnection,
} from "../agent-provider-test-support.js";
import {
  absolutePath,
  acpRuleDetail,
  claudeRuleDetail,
  codexRuleDetail,
  openCodeRuleDetail,
} from "./request-detail.js";

describe("codexRuleDetail", () => {
  test("reads an exact command, a managed-network host and file changes", () => {
    expect(
      codexRuleDetail(
        {
          ruleEligible: true,
          command: "/bin/zsh -lc 'npm test'",
          proposedCommandPrefix: ["npm", "test"],
        },
        "command-approval",
        true,
      ),
    ).toEqual({
      subject: { kind: "command", command: "/bin/zsh -lc 'npm test'" },
      proposal: ["npm", "test"],
      allowOnceAnswers: [],
    });
    expect(
      codexRuleDetail(
        { ruleEligible: true, command: "curl x", networkHost: "registry.npmjs.org" },
        "command-approval",
        true,
      )?.subject,
    ).toEqual({ kind: "network-host", host: "registry.npmjs.org" });
    // Codex 0.166.0 sends a managed-network approval with no command at all.
    expect(
      codexRuleDetail(
        { ruleEligible: true, networkHost: "probe-host.example.test" },
        "command-approval",
        true,
      )?.subject,
    ).toEqual({ kind: "network-host", host: "probe-host.example.test" });
    // Pi sends paths relative to its working directory.
    expect(
      codexRuleDetail(
        { ruleEligible: true, cwd: "/w", changes: [{ path: "src/a.ts" }, { path: "/w/b.ts" }] },
        "file-approval",
        true,
      )?.subject,
    ).toEqual({ kind: "file-change", paths: ["/w/src/a.ts", "/w/b.ts"] });
  });

  test("fails closed without the marker, when unactionable, oversized or widening", () => {
    expect(codexRuleDetail({ command: "npm test" }, "command-approval", true)).toBeNull();
    expect(
      codexRuleDetail({ ruleEligible: true, command: "npm test" }, "command-approval", false),
    ).toBeNull();
    expect(
      codexRuleDetail({ ruleEligible: true, command: "x".repeat(5_000) }, "command-approval", true),
    ).toBeNull();
    expect(
      codexRuleDetail(
        { ruleEligible: true, grantRoot: "/", changes: [{ path: "/w/a" }] },
        "file-approval",
        true,
      ),
    ).toBeNull();
    expect(
      codexRuleDetail({ ruleEligible: true, changes: [{ path: "a" }] }, "file-approval", true),
    ).toBeNull();
    expect(
      codexRuleDetail({ ruleEligible: true, permissions: { network: true } }, "permission", true),
    ).toBeNull();
  });
});

describe("acpRuleDetail", () => {
  test("needs the marker, an allow-once option and complete detail", () => {
    const base = { ruleEligible: true, kind: "command", command: "npm test" };
    expect(acpRuleDetail(base, "q0o0", "decision")).toEqual({
      subject: { kind: "command", command: "npm test" },
      allowOnceAnswers: [{ questionId: "decision", optionIds: ["q0o0"] }],
    });
    expect(acpRuleDetail(base, null, "decision")).toBeNull();
    expect(acpRuleDetail({ ...base, ruleEligible: undefined }, "q0o0", "decision")).toBeNull();
    expect(acpRuleDetail({ ...base, commandTruncated: true }, "q0o0", "decision")).toBeNull();
    expect(
      acpRuleDetail(
        { ruleEligible: true, kind: "file-change", paths: ["/w/a"], pathsOmitted: 2 },
        "q0o0",
        "decision",
      ),
    ).toBeNull();
  });
});

describe("claudeRuleDetail", () => {
  test("reads Bash, file, WebFetch and MCP approvals", () => {
    expect(
      claudeRuleDetail({ ruleEligible: true, command: "npm test" }, "command-approval")?.subject,
    ).toEqual({ kind: "command", command: "npm test" });
    expect(
      claudeRuleDetail({ ruleEligible: true, paths: ["/w/a.ts"] }, "file-approval")?.subject,
    ).toEqual({ kind: "file-change", paths: ["/w/a.ts"] });
    expect(
      claudeRuleDetail(
        { ruleEligible: true, toolName: "WebFetch", networkHost: "docs.example.com" },
        "permission",
      )?.subject,
    ).toEqual({ kind: "network-host", host: "docs.example.com" });
    expect(
      claudeRuleDetail(
        { ruleEligible: true, toolName: "mcp__linear__create_issue", mcpServer: "linear" },
        "permission",
      )?.subject,
    ).toEqual({ kind: "mcp-tool", server: "linear", tool: "create_issue" });
  });

  test("an MCP tool whose name does not carry its server's prefix is not matched", () => {
    expect(
      claudeRuleDetail(
        { ruleEligible: true, toolName: "mcp__other__create_issue", mcpServer: "linear" },
        "permission",
      ),
    ).toBeNull();
    expect(
      claudeRuleDetail({ toolName: "mcp__linear__x", mcpServer: "linear" }, "permission"),
    ).toBeNull();
    expect(
      claudeRuleDetail({ ruleEligible: true, toolName: "Task", input: "{}" }, "permission"),
    ).toBeNull();
  });
});

describe("openCodeRuleDetail", () => {
  test("matches a command only from the full metadata command", () => {
    expect(
      openCodeRuleDetail({ metadata: { command: "npm test" } }, "bash", ["npm test"], "/w")
        ?.subject,
    ).toEqual({ kind: "command", command: "npm test" });
    // A pattern without the full command, or a compound command split into
    // several patterns, is never matched.
    expect(openCodeRuleDetail({}, "bash", ["npm test"], "/w")).toBeNull();
    expect(
      openCodeRuleDetail({ metadata: { command: "npm test > out" } }, "bash", ["npm test"], "/w"),
    ).toBeNull();
    expect(
      openCodeRuleDetail({ metadata: { command: "a && b" } }, "bash", ["a", "b"], "/w"),
    ).toBeNull();
  });

  // OpenCode 1.19.4's `ShellTool.ask` sends `metadata: { command }` and one
  // pattern per tree-sitter `command` node (its trimmed text, with any
  // redirect), skipping `cd`/`pushd`. These are the payloads it builds.
  test("matches the payloads OpenCode 1.19.4 sends for a plain command only", () => {
    const ask = (command: string, patterns: string[]) =>
      openCodeRuleDetail({ metadata: { command } }, "bash", patterns, "/w")?.subject ?? null;
    expect(ask("git status --short", ["git status --short"])).toEqual({
      kind: "command",
      command: "git status --short",
    });
    expect(ask("npm run test -- --watch", ["npm run test -- --watch"])).toEqual({
      kind: "command",
      command: "npm run test -- --watch",
    });
    expect(ask("cd app && npm test", ["npm test"])).toBeNull();
    expect(ask("npm test; npm test", ["npm test"])).toBeNull();
    expect(ask("echo $(date)", ["echo $(date)", "date"])).toBeNull();
    expect(ask("ls | head", ["ls", "head"])).toBeNull();
    // OpenCode trims each pattern but not the command it reports.
    expect(ask("npm test\n", ["npm test"])).toBeNull();
  });

  test("asks for a multi-file patch, whose filepath is a joined relative list", () => {
    expect(
      openCodeRuleDetail(
        { metadata: { filepath: "src/a.ts, src/b.ts" } },
        "edit",
        ["src/a.ts", "src/b.ts"],
        "/w",
      ),
    ).toBeNull();
    expect(
      openCodeRuleDetail({ metadata: { filepath: "src/a.ts" } }, "edit", ["src/a.ts"], "/w")
        ?.subject,
    ).toEqual({ kind: "file-change", paths: ["/w/src/a.ts"] });
  });

  test("reads edits and fetches", () => {
    expect(
      openCodeRuleDetail({ metadata: { filepath: "/w/a.ts" } }, "edit", ["a.ts"], "/w")?.subject,
    ).toEqual({ kind: "file-change", paths: ["/w/a.ts"] });
    expect(openCodeRuleDetail({}, "edit", ["src/a.ts"], "/w")?.subject).toEqual({
      kind: "file-change",
      paths: ["/w/src/a.ts"],
    });
    expect(openCodeRuleDetail({}, "edit", ["src/a.ts"], undefined)).toBeNull();
    expect(
      openCodeRuleDetail({}, "webfetch", ["https://docs.example.com/a"], "/w")?.subject,
    ).toEqual({ kind: "network-host", host: "https://docs.example.com/a" });
    expect(openCodeRuleDetail({}, "webfetch", ["file:///etc/passwd"], "/w")).toBeNull();
    expect(openCodeRuleDetail({}, "task", ["x"], "/w")).toBeNull();
  });
});

test("absolutePath resolves only against an absolute directory", () => {
  expect(absolutePath("/a", undefined)).toBe("/a");
  expect(absolutePath("a", "/w/")).toBe("/w/a");
  expect(absolutePath("a", "w")).toBeNull();
  expect(absolutePath("", "/w")).toBeNull();
});

describe("bridge adapters", () => {
  const now = Date.now();

  test("Codex and Pi expose the detail of an eligible approval and drop it when it goes", async () => {
    for (const connection of [codexConnection, piConnection]) {
      let approvals: Array<Record<string, unknown>> = [
        {
          approvalId: "eligible",
          kind: "command",
          requestedAt: now,
          expiresAt: now + 60_000,
          command: "npm test",
          actionable: true,
          ruleEligible: true,
        },
        {
          approvalId: "old-bridge",
          kind: "command",
          requestedAt: now,
          expiresAt: now + 60_000,
          command: "npm test",
          actionable: true,
        },
      ];
      const { provider } = httpProvider((url) => {
        if (url.endsWith("/approvals")) return Response.json({ approvals });
        if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
        return new Response(null, { status: 404 });
      }, connection);
      const [eligible, old] = (await provider.interactions!.listPendingInteractions("s1")).requests;
      expect(provider.interactions!.permissionRuleDetail!("s1", eligible!.id)?.subject).toEqual({
        kind: "command",
        command: "npm test",
      });
      expect(provider.interactions!.permissionRuleDetail!("s1", old!.id)).toBeNull();
      // Another session cannot read it.
      expect(provider.interactions!.permissionRuleDetail!("s2", eligible!.id)).toBeNull();
      approvals = [];
      await provider.interactions!.listPendingInteractions("s1");
      expect(provider.interactions!.permissionRuleDetail!("s1", eligible!.id)).toBeNull();
    }
  });

  test("Grok selects the explicit allow-once option, never another allow", async () => {
    const approval = (options: Array<Record<string, unknown>>) => ({
      id: "g1",
      title: "Run",
      kind: "command",
      command: "npm test",
      ruleEligible: true,
      requestedAt: now,
      expiresAt: now + 60_000,
      options,
    });
    for (const [options, expected] of [
      [
        [
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "once", name: "Once", kind: "allow_once" },
        ],
        "q0:o1",
      ],
      [[{ optionId: "always", name: "Always", kind: "allow_always" }], null],
    ] as const) {
      const { provider } = httpProvider((url) => {
        if (url.endsWith("/approvals")) {
          return Response.json({ approvals: [approval([...options])] });
        }
        if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
        return new Response(null, { status: 404 });
      }, grokConnection);
      const [request] = (await provider.interactions!.listPendingInteractions("s1")).requests;
      const detail = provider.interactions!.permissionRuleDetail!("s1", request!.id);
      expect(detail?.allowOnceAnswers[0]?.optionIds?.[0] ?? null).toBe(expected);
    }
  });

  test("Claude exposes an eligible tool approval", async () => {
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/interactions")) {
        return Response.json({
          interactions: [
            {
              id: "c1",
              kind: "command-approval",
              toolName: "Bash",
              command: "npm test",
              requestedAt: now,
              expiresAt: now + 60_000,
              ruleEligible: true,
              proposedCommandPrefix: ["npm", "test"],
            },
          ],
        });
      }
      if (url.endsWith("/questions")) return Response.json({ questions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      return new Response(null, { status: 404 });
    }, claudeConnection);
    const [request] = (await provider.interactions!.listPendingInteractions("s1")).requests;
    expect(provider.interactions!.permissionRuleDetail!("s1", request!.id)).toEqual({
      subject: { kind: "command", command: "npm test" },
      proposal: ["npm", "test"],
      allowOnceAnswers: [],
    });
  });
});

test.each(["~/.ssh/config", "file:///outside/target", "@.env", "@../outside"])(
  "Pi alternate path fails closed at backend: %s",
  (path) => {
    expect(
      codexRuleDetail(
        { ruleEligible: true, cwd: "/workspace", changes: [{ path }] },
        "file-approval",
        true,
      ),
    ).toBeNull();
  },
);

test("Codex source and rename destination both enter rule matching", () => {
  expect(
    codexRuleDetail(
      {
        ruleEligible: true,
        cwd: "/workspace",
        changes: [{ path: "src/allowed.ts", movePath: "/outside/target" }],
      },
      "file-approval",
      true,
    )?.subject,
  ).toEqual({ kind: "file-change", paths: ["/workspace/src/allowed.ts", "/outside/target"] });
  expect(
    codexRuleDetail(
      {
        ruleEligible: true,
        cwd: "/workspace",
        changes: [{ path: "src/allowed.ts", movePath: 42 }],
      },
      "file-approval",
      true,
    ),
  ).toBeNull();
});
