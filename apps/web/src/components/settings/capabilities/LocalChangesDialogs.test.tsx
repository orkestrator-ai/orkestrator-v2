import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  CapabilityDriftEntry,
  CapabilityOperationSnapshot,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityDriftMerge } from "@orkestrator/protocol/capability-resources-api";

import { capabilitiesApi } from "@/lib/backend/capabilities";

import { MergeLocalChangesDialog } from "./LocalChangesDialogs";

const entry: CapabilityDriftEntry = {
  id: "drift:bk_leaf|claude-user-skills|managed:style#skill:",
  nodeId: "bk_leaf",
  provider: "claude",
  locationId: "claude-user-skills",
  componentId: "managed:style#skill:",
  packageId: "managed:style",
  name: "style",
  kind: "modified",
  observedDigest: "sha256:local",
  detectedAt: "2026-11-19T00:00:00.000Z",
  state: "open",
};

const marked =
  "title\n<<<<<<< local\nLocal two.\n||||||| base\nLine two.\n=======\nUpstream two.\n>>>>>>> configured\nend\n";

const conflicted: CapabilityDriftMerge = {
  driftId: entry.id,
  nodeId: "bk_leaf",
  packageId: "managed:style",
  displayName: "style",
  baseRevision: "aaaaaaaaaaaa",
  configuredRevision: "bbbbbbbbbbbb",
  basis: "sha256:basis",
  conflicts: 1,
  unmergeable: [],
  files: [
    {
      path: "SKILL.md",
      componentId: "managed:style#skill:",
      outcome: "conflict",
      conflict: {
        kind: "text",
        base: "title\nLine two.\nend\n",
        local: "title\nLocal two.\nend\n",
        configured: "title\nUpstream two.\nend\n",
        merged: marked,
        hunks: [
          { line: 2, base: "Line two.\n", local: "Local two.\n", configured: "Upstream two.\n" },
        ],
      },
    },
  ],
};

const operation: CapabilityOperationSnapshot = {
  id: "capop_merge",
  kind: "add-to-setup",
  state: "awaiting-approval",
  planDigest: "sha256:plan",
  packageIds: ["managed:style"],
  targets: [],
  requiresApproval: true,
  approvalReasons: [
    "Publish the merge of the local changes and the configured revision as the package's new revision.",
  ],
  summary: { total: 0, byStatus: {} },
  correlationId: "cap_1",
  createdAt: "2026-11-19T00:00:00.000Z",
  updatedAt: "2026-11-19T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  mock.restore();
});

test("conflicts are edited per file and the resolved text is sent back with the merge basis", async () => {
  const merge = spyOn(capabilitiesApi, "mergeCapabilityDrift")
    .mockResolvedValueOnce(conflicted)
    .mockResolvedValueOnce({
      ...conflicted,
      conflicts: 0,
      files: [{ path: "SKILL.md", componentId: "managed:style#skill:", outcome: "merged" }],
      operation,
    });
  render(
    <MergeLocalChangesDialog
      entry={entry}
      machineNames={{ bk_leaf: "Laptop" }}
      onClose={() => undefined}
      onApplied={() => undefined}
      onFallback={() => undefined}
    />,
  );
  const editor = (await screen.findByLabelText(
    "Resolved text for SKILL.md",
  )) as HTMLTextAreaElement;
  expect(editor.value).toBe(marked);
  expect(
    screen.getByRole("region", { name: "This machine's version of SKILL.md" }).textContent,
  ).toContain("Local two.");
  expect(
    screen.getByRole("region", { name: "Configured revision of SKILL.md" }).textContent,
  ).toContain("Upstream two.");
  expect(screen.getByText(/line 2/)).toBeTruthy();
  // Markers left in: the merge cannot be checked yet.
  const check = screen.getByTestId("capability-merge-check") as HTMLButtonElement;
  expect(check.disabled).toBe(true);
  expect(screen.getByText(/Conflict markers remain in SKILL.md/)).toBeTruthy();

  fireEvent.change(editor, { target: { value: "title\nBoth two.\nend\n" } });
  expect(check.disabled).toBe(false);
  fireEvent.click(check);
  await waitFor(() => expect(screen.getByTestId("capability-change-preview")).toBeTruthy());
  expect(merge).toHaveBeenLastCalledWith(entry.id, {
    basis: "sha256:basis",
    resolutions: [{ path: "SKILL.md", content: "title\nBoth two.\nend\n" }],
  });
  expect(screen.getByText(/Publish the merge of the local changes/)).toBeTruthy();
});

test("binary conflicts are refused and offer keep, adopt or replace", async () => {
  spyOn(capabilitiesApi, "mergeCapabilityDrift").mockResolvedValue({
    ...conflicted,
    conflicts: 0,
    unmergeable: ["logo.png"],
    files: [
      {
        path: "logo.png",
        componentId: "managed:style#skill:",
        outcome: "conflict",
        conflict: { kind: "binary" },
      },
    ],
  });
  const onFallback = mock(() => undefined);
  render(
    <MergeLocalChangesDialog
      entry={entry}
      machineNames={{}}
      onClose={() => undefined}
      onApplied={() => undefined}
      onFallback={onFallback}
    />,
  );
  await waitFor(() => expect(screen.getByText("These files cannot be merged")).toBeTruthy());
  expect(screen.getByText(/logo.png changed on this machine/)).toBeTruthy();
  expect(screen.queryByTestId("capability-merge-check") === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Adopt local" }));
  expect(onFallback).toHaveBeenCalledWith(entry, "adopt");
});
