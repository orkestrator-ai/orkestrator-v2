import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ExternalPermissionRuleFile,
  NativeAgentPermissionRule,
} from "@orkestrator/protocol/permission-rules";
import * as realBackend from "@/lib/backend";

function rule(overrides: Partial<NativeAgentPermissionRule> = {}): NativeAgentPermissionRule {
  return {
    id: "rule-1",
    provider: "codex",
    scope: "project",
    projectId: "project-1",
    kind: "command-prefix",
    pattern: "npm test",
    createdAt: 1,
    createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "i" },
    lastUsedAt: Date.UTC(2026, 9, 27, 10, 0),
    useCount: 3,
    ...overrides,
  };
}

let rules = [
  rule(),
  rule({ id: "rule-2", provider: "claude", kind: "network-host", pattern: "example.com" }),
];
const external: ExternalPermissionRuleFile[] = [
  {
    provider: "codex",
    location: "host",
    label: "Host Codex home",
    path: "/Users/me/.codex/rules/default.rules",
    entries: ['prefix_rule(pattern=["curl"], decision="allow")'],
    truncated: false,
    guidance: "Edit or delete the line in this file.",
  },
];
const listPermissionRules = mock(async () => ({ rules, applications: [] }));
const listExternalPermissionRules = mock(async () => ({ files: external }));
const deletePermissionRule = mock(async (id: string) => {
  rules = rules.filter((entry) => entry.id !== id);
  return { deleted: true };
});
const deleteProjectPermissionRules = mock(async () => ({ deleted: 0 }));

mock.module("@/lib/backend", () => ({
  ...realBackend,
  listPermissionRules,
  listExternalPermissionRules,
  deletePermissionRule,
  deleteProjectPermissionRules,
}));

const { PermissionsSettings } = await import("./PermissionsSettings");

afterEach(() => {
  cleanup();
  rules = [
    rule(),
    rule({ id: "rule-2", provider: "claude", kind: "network-host", pattern: "example.com" }),
  ];
  deletePermissionRule.mockClear();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("PermissionsSettings", () => {
  test("lists each rule with its agent, scope and use, and the provider files read-only", async () => {
    render(<PermissionsSettings />);
    const rows = await screen.findAllByTestId("permission-rule-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("npm test")).toBeTruthy();
    expect(rows[0]!.textContent).toContain("Whole project");
    expect(rows[0]!.textContent).toContain("Used 3 times");
    const file = await screen.findByTestId("external-rule-file");
    expect(file.textContent).toContain("/Users/me/.codex/rules/default.rules");
    expect(file.textContent).toContain('prefix_rule(pattern=["curl"]');
    // Read-only: the provider's rules have no remove control.
    expect(within(file).queryByRole("button") === null).toBe(true);
  });

  test("removes a rule after confirming", async () => {
    render(<PermissionsSettings />);
    await screen.findAllByTestId("permission-rule-row");
    fireEvent.click(screen.getByRole("button", { name: "Remove rule npm test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deletePermissionRule).toHaveBeenCalledTimes(1));
    expect(deletePermissionRule.mock.calls[0]![0]).toBe("rule-1");
    await waitFor(() => expect(screen.getAllByTestId("permission-rule-row")).toHaveLength(1));
  });
});
