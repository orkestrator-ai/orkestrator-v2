import { describe, expect, test } from "bun:test";
import {
  initMcpServerStatus,
  mcpScope,
} from "../../../../../../bridges/claude-bridge/src/services/mcp-runtime-status";

import type { McpConfigSource } from "@orkestrator/protocol/mcp-management";

import {
  joinLiveMcpServer,
  latestRuntimeApply,
  mcpApplyRuntimeId,
  type McpLiveServerRef,
} from "./mcp-live-join";
import { definition, environmentTarget, operation, snapshot } from "./mcp-test-fixtures";

const userSource = snapshot().sources[0]!;
const projectSource: McpConfigSource = {
  ...userSource,
  sourceId: "claude:project",
  scope: "project",
  owner: "native-project",
  label: "Project (this worktree)",
  displayPath: "<worktree>/.mcp.json",
  precedence: 30,
};
const ref = (overrides: Partial<McpLiveServerRef> = {}): McpLiveServerRef => ({
  provider: "claude",
  environmentId: null,
  serverName: "docs",
  ...overrides,
});

const shadowed = snapshot({
  sources: [userSource, projectSource],
  definitions: [
    definition({ status: "shadowed", shadowedBy: "claude:project/ZG9jcw" }),
    definition({ entryId: "claude:project/ZG9jcw", sourceId: "claude:project", shadows: [] }),
    definition({ entryId: "claude:user/b3RoZXI", name: "other" }),
  ],
});

describe("joinLiveMcpServer", () => {
  test("picks the row the session loads, not every row with the name", () => {
    expect(joinLiveMcpServer(shadowed, ref())).toEqual({
      kind: "saved",
      entryId: "claude:project/ZG9jcw",
      sourceLabel: "Project (this worktree)",
      alsoNamed: 1,
    });
  });

  test("a live scope narrows the candidates to sources of that scope", () => {
    expect(joinLiveMcpServer(shadowed, ref({ scope: "user" }))).toMatchObject({
      kind: "saved",
      entryId: "claude:user/ZG9jcw",
    });
    expect(joinLiveMcpServer(shadowed, ref({ scope: "project" }))).toMatchObject({
      entryId: "claude:project/ZG9jcw",
    });
  });

  test("Claude bridge scopes distinguish same-named user, local and project definitions", () => {
    const localSource: McpConfigSource = {
      ...userSource,
      sourceId: "claude:local",
      scope: "claude-local",
      precedence: 20,
    };
    const rows = snapshot({
      sources: [userSource, localSource, projectSource],
      definitions: [
        definition({ status: "shadowed" }),
        definition({ entryId: "local-docs", sourceId: localSource.sourceId, status: "shadowed" }),
        definition({ entryId: "project-docs", sourceId: projectSource.sourceId }),
      ],
    });
    for (const [sdkScope, entryId] of [
      ["user", "claude:user/ZG9jcw"],
      ["local", "local-docs"],
      ["project", "project-docs"],
    ]) {
      expect(joinLiveMcpServer(rows, ref({ scope: mcpScope(sdkScope, "docs") }))).toMatchObject({
        kind: "saved",
        entryId,
      });
    }
  });

  test("native SSE local scope selects the local saved row despite a project duplicate", () => {
    const localSource: McpConfigSource = {
      ...userSource,
      sourceId: "claude:local",
      scope: "claude-local",
      precedence: 20,
    };
    const rows = snapshot({
      sources: [localSource, projectSource],
      definitions: [
        definition({ entryId: "local-docs", sourceId: localSource.sourceId, status: "shadowed" }),
        definition({ entryId: "project-docs", sourceId: projectSource.sourceId }),
      ],
    });
    const layers = new Map([["inline", "project"]] as const);
    for (const scope of [
      mcpScope("local", "docs", "local", layers),
      initMcpServerStatus({ name: "docs", source: "local" }, layers).scope,
    ]) {
      expect(joinLiveMcpServer(rows, ref({ scope }))).toMatchObject({
        kind: "saved",
        entryId: "local-docs",
      });
    }
  });

  for (const provider of ["codex", "opencode"] as const) {
    test(`${provider} scope-less injected rows beat shadowed file entries`, () => {
      const rows = snapshot({
        target: { ...snapshot().target, provider },
        definitions: [
          definition({ name: "orkestrator", status: "shadowed" }),
          definition({ name: "orkestrator", entryId: "injected", status: "protected" }),
        ],
      });
      expect(joinLiveMcpServer(rows, ref({ provider, serverName: "orkestrator" }))).toEqual({
        kind: "injected",
        entryId: "injected",
      });
    });
  }

  test("a scope no saved row has falls back to the name alone", () => {
    const userOnly = snapshot();
    expect(joinLiveMcpServer(userOnly, ref({ scope: "project" }))).toMatchObject({
      kind: "saved",
      entryId: "claude:user/ZG9jcw",
    });
  });

  test("the name must match exactly", () => {
    expect(joinLiveMcpServer(shadowed, ref({ serverName: "Docs" }))).toEqual({
      kind: "not-found",
    });
    expect(joinLiveMcpServer(shadowed, ref({ serverName: "doc" }))).toEqual({ kind: "not-found" });
  });

  test("another provider or environment is another target", () => {
    expect(joinLiveMcpServer(shadowed, ref({ provider: "codex" }))).toEqual({
      kind: "other-target",
    });
    expect(joinLiveMcpServer(shadowed, ref({ environmentId: "e1" }))).toEqual({
      kind: "other-target",
    });
    const environment = snapshot({ target: environmentTarget("e1") });
    expect(joinLiveMcpServer(environment, ref({ provider: "pi", environmentId: null })).kind).toBe(
      "other-target",
    );
    expect(joinLiveMcpServer(environment, ref({ provider: "pi", environmentId: "e1" })).kind).toBe(
      "saved",
    );
  });

  test("injected and plugin servers have no saved row", () => {
    const protectedRow = snapshot({
      definitions: [
        definition({ entryId: "claude:injected/b3Jr", name: "orkestrator", status: "protected" }),
      ],
    });
    expect(
      joinLiveMcpServer(protectedRow, ref({ serverName: "orkestrator", scope: "orkestrator" })),
    ).toEqual({ kind: "injected", entryId: "claude:injected/b3Jr" });
    expect(joinLiveMcpServer(shadowed, ref({ scope: "plugin" }))).toEqual({ kind: "plugin" });
  });

  test("a plugin server joins its read-only plugin row by the CLI's exact name", () => {
    const pluginSource: McpConfigSource = {
      ...userSource,
      sourceId: "claude:plugin-0123456789abcdef",
      scope: "plugin",
      owner: "plugin",
      label: "Plugin docs",
      displayPath: "~/.claude/plugins/cache/m/docs/1.0.0/.mcp.json",
      precedence: 101,
      writable: false,
    };
    const name = "plugin:docs:search";
    const withPlugin = snapshot({
      sources: [userSource, pluginSource],
      definitions: [
        // A file entry that happens to share the name is never the plugin's server.
        definition({ entryId: "claude:user/x", name }),
        definition({
          entryId: "claude:plugin-0123456789abcdef/x",
          sourceId: pluginSource.sourceId,
          name,
        }),
      ],
    });
    // The pinned CLI reports a plugin server as scope `dynamic`, source `plugin`.
    const scope = mcpScope("dynamic", name, "plugin");
    expect(joinLiveMcpServer(withPlugin, ref({ serverName: name, scope }))).toEqual({
      kind: "plugin",
      entryId: "claude:plugin-0123456789abcdef/x",
      sourceLabel: "Plugin docs",
    });
    const disabled = snapshot({
      sources: [pluginSource],
      definitions: [
        definition({
          entryId: "claude:plugin-0123456789abcdef/x",
          sourceId: pluginSource.sourceId,
          name,
          status: "disabled",
          statusReason:
            'Disabled: enabledPlugins["docs@inline"] is false in ~/.claude/settings.json.',
        }),
      ],
    });
    expect(joinLiveMcpServer(disabled, ref({ serverName: name, scope }))).toMatchObject({
      kind: "plugin",
      disabledReason:
        'Disabled: enabledPlugins["docs@inline"] is false in ~/.claude/settings.json.',
    });
    expect(joinLiveMcpServer(withPlugin, ref({ serverName: "plugin:docs:other", scope }))).toEqual({
      kind: "plugin",
    });
  });

  test("Pi loads a saved name under the bridge's sanitized spelling", () => {
    const pi = snapshot({
      target: environmentTarget("e1"),
      definitions: [definition({ name: "my.docs" })],
    });
    expect(
      joinLiveMcpServer(pi, ref({ provider: "pi", environmentId: "e1", serverName: "my_docs" })),
    ).toMatchObject({ kind: "saved", loadedAs: "my_docs" });
    // Other providers never rename, so the same spelling is not a match there.
    expect(
      joinLiveMcpServer(
        snapshot({ definitions: [definition({ name: "my.docs" })] }),
        ref({ serverName: "my_docs" }),
      ),
    ).toEqual({ kind: "not-found" });
  });
});

describe("latestRuntimeApply", () => {
  const runtimeId = mcpApplyRuntimeId("e1", "e1:tab-1");
  const entry = (state: "applied" | "pending-next-turn", id = runtimeId) => ({
    runtimeId: id,
    environmentId: "e1",
    label: "env · tab-1",
    state,
    updatedAt: "2026-09-23T00:00:00Z",
  });

  test("returns the newest operation that lists the session", () => {
    const older = operation({
      operationId: "op-old",
      updatedAt: "2026-09-23T00:00:00Z",
      apply: { state: "applied", runtimes: [entry("applied")], omitted: 0 },
    });
    const newer = operation({
      operationId: "op-new",
      updatedAt: "2026-09-24T00:00:00Z",
      apply: { state: "pending-next-turn", runtimes: [entry("pending-next-turn")], omitted: 0 },
    });
    const unrelated = operation({
      operationId: "op-other",
      updatedAt: "2026-09-25T00:00:00Z",
      apply: {
        state: "applied",
        runtimes: [entry("applied", mcpApplyRuntimeId("e1", "e1:tab-2"))],
        omitted: 0,
      },
    });
    const found = latestRuntimeApply([older, unrelated, newer], runtimeId);
    expect(found?.operation.operationId).toBe("op-new");
    expect(found?.runtime.state).toBe("pending-next-turn");
    expect(latestRuntimeApply([unrelated], runtimeId)).toBeNull();
  });
});
