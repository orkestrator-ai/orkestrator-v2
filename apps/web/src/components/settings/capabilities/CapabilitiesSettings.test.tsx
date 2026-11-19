import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  CapabilityOperationSnapshot,
  CapabilityPackageDetail,
  CapabilityPackageSummary,
  CapabilitySetup,
} from "@orkestrator/protocol/capability-resources";

import { capabilitiesApi } from "@/lib/backend/capabilities";

import { ChangePreview } from "./ChangePreview";
import { LibraryView } from "./LibraryView";
import { PackageDetail } from "./PackageDetail";

const setup: CapabilitySetup = {
  id: "my-setup",
  name: "My setup",
  builtIn: true,
  revision: 2,
  packageSelections: [{ packageId: "managed:review", version: "latest" }],
  providerSelectors: [],
  machineSelectors: [],
  exclusions: [],
  parentSetupIds: [],
  updatePolicy: "approve",
  updatedAt: "2026-11-19T00:00:00.000Z",
};

const summary: CapabilityPackageSummary = {
  id: "managed:review",
  displayName: "review",
  description: "Reviews changes",
  source: { kind: "managed", managedId: "review" },
  sourceLabel: "Authored in Orkestrator",
  revision: "abc123def456",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  provenance: "managed",
  risk: "instructions",
  kinds: ["skill"],
  componentCount: 1,
  components: [
    { id: "managed:review#skill:", kind: "skill", name: "review", risk: "instructions" },
  ],
  assignedSetupIds: ["my-setup"],
  readiness: "pending",
  attention: 0,
  updateAvailable: true,
  pinned: false,
  paused: false,
  updatedAt: "2026-11-19T00:00:00.000Z",
};

const detail: CapabilityPackageDetail = {
  package: summary,
  components: [
    {
      id: "managed:review#skill:",
      packageId: "managed:review",
      kind: "skill",
      pathOrKey: "",
      name: "review",
      dependencies: [],
      providerHints: [],
      requirements: {},
      risk: "instructions",
    },
  ],
  availability: [
    {
      target: { nodeId: "bk_self", provider: "claude" },
      nodeName: "Desk",
      componentId: "managed:review#skill:",
      status: "installed-next-session",
      verification: "present",
      locationId: "claude-user-skills",
      alsoVisibleTo: ["cursor", "grok", "opencode", "pi"],
      remedy: "Start a new session to load it.",
    },
    {
      target: { nodeId: "bk_laptop", provider: "codex" },
      nodeName: "Laptop",
      componentId: "managed:review#skill:",
      status: "offline",
      verification: "requested",
      reason: "Waiting for the machine to connect.",
    },
  ],
  previousRevisions: [],
  files: [{ path: "SKILL.md", bytes: 120, executable: false }],
};

beforeEach(() => {
  spyOn(capabilitiesApi, "listCapabilityPackages").mockResolvedValue({
    revision: 1,
    packages: [summary],
    truncated: 0,
    epoch: 1,
  });
  spyOn(capabilitiesApi, "getCapabilityPackage").mockResolvedValue(detail);
});

afterEach(() => {
  cleanup();
  mock.restore();
});

test("the library shows one row per package with its readiness and update state", async () => {
  const onOpen = mock(() => undefined);
  render(<LibraryView setups={[setup]} onOpen={onOpen} onAdd={() => undefined} />);
  await waitFor(() => expect(screen.getByText("review")).toBeTruthy());
  expect(screen.getByText("On its way")).toBeTruthy();
  expect(screen.getByText("Update available")).toBeTruthy();
  expect(screen.getAllByText("My setup").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText("review"));
  expect(onOpen).toHaveBeenCalledWith("managed:review");
});

test("where available: each gap explains itself, and a shared directory is never called isolated", async () => {
  render(
    <PackageDetail
      packageId="managed:review"
      machines={[]}
      setups={[setup]}
      onBack={() => undefined}
      onShowActivity={() => undefined}
      onShowInstalled={() => undefined}
    />,
  );
  await waitFor(() => expect(screen.getByTestId("capability-availability")).toBeTruthy());
  expect(screen.getAllByText("Next session").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Waiting for machine").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: /Claude Code on bk_self/ }));
  expect(screen.getByText(/Exclusion cannot be enforced/)).toBeTruthy();
  // A copy is reported as present, never as loaded.
  expect(screen.getByText("Files present")).toBeTruthy();
});

test("a plan with approval reasons cannot be applied until reviewed, and applies its exact digest", async () => {
  const operation: CapabilityOperationSnapshot = {
    id: "capop_1",
    kind: "add-to-setup",
    state: "awaiting-approval",
    planDigest: "sha256:plan",
    packageIds: ["managed:guard"],
    targets: [
      {
        key: "bk|claude-user-skills|x",
        target: { nodeId: "bk_self", provider: "claude" },
        componentId: "managed:guard#skill:",
        packageId: "managed:guard",
        action: "install",
        toDigest: `sha256:${"b".repeat(64)}`,
        status: "pending",
        alsoVisibleTo: ["cursor"],
        liveSemantics: "new-session-required",
      },
      {
        key: "bk|claude|hook",
        target: { nodeId: "bk_self", provider: "claude" },
        componentId: "managed:guard#hook:PreToolUse",
        packageId: "managed:guard",
        action: "skip",
        status: "unsupported",
        reason: "Standalone hooks are not installed.",
      },
    ],
    requiresApproval: true,
    approvalReasons: ["guard is a hook that runs ./guard.sh on PreToolUse."],
    summary: { total: 2, byStatus: { pending: 1, unsupported: 1 } },
    correlationId: "cap_1",
    createdAt: "t",
    updatedAt: "t",
  };
  const apply = spyOn(capabilitiesApi, "applyCapabilityChange").mockResolvedValue({
    operation: { ...operation, state: "applying" },
    replayed: false,
  });
  const onApplied = mock(() => undefined);
  render(
    <ChangePreview
      operation={operation}
      machineNames={{ bk_self: "Desk" }}
      componentNames={{}}
      onApplied={onApplied}
      onCancel={() => undefined}
    />,
  );
  expect(screen.getByText(/runs \.\/guard\.sh on PreToolUse/)).toBeTruthy();
  expect(screen.getByText("Standalone hooks are not installed.")).toBeTruthy();
  expect(screen.getByText(/Also visible to Cursor Agent/)).toBeTruthy();
  const approve = screen.getByTestId("capability-approve") as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("I reviewed what this package runs"));
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(onApplied).toHaveBeenCalled());
  expect(apply.mock.calls[0]?.[0]).toBe("capop_1");
  expect(apply.mock.calls[0]?.[1]).toBe("sha256:plan");
});
