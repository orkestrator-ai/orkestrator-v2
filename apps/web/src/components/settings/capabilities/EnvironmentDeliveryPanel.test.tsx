import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type { CapabilityEnvironmentDelivery } from "@orkestrator/protocol/capability-resources-api";

import { capabilitiesApi } from "@/lib/backend/capabilities";

import { EnvironmentDeliveryPanel } from "./EnvironmentDeliveryPanel";

afterEach(() => {
  cleanup();
  mock.restore();
});

const DIGEST = `sha256:${"a".repeat(64)}`;
const CURRENT = `sha256:${"b".repeat(64)}`;

test("asks the command scope and shows a leaf container that was not staged", async () => {
  const read = spyOn(capabilitiesApi, "getCapabilityEnvironmentDelivery").mockResolvedValue({
    environmentId: "env-d",
    kind: "container",
    installedDigest: DIGEST,
    currentDigest: CURRENT,
    stale: true,
    notStagedReason: "Capabilities not staged: command node unreachable",
    nodeId: "bk_gram",
    items: [
      {
        componentId: "managed:docs#skill:docs",
        name: "docs",
        kind: "skill",
        packageId: "managed:docs",
        providers: ["claude"],
        locationId: "claude-user-skills",
        locationLabel: "~/.claude/skills",
        status: "restart-required",
        currentDigest: CURRENT,
        reason:
          "Capabilities not staged: command node unreachable when this container was created.",
      },
    ],
  } satisfies CapabilityEnvironmentDelivery);
  render(<EnvironmentDeliveryPanel environmentId="env-d" onRebuild={() => undefined} />);
  expect((await screen.findByTestId("capability-container-not-staged")).textContent).toContain(
    "Capabilities not staged: command node unreachable",
  );
  expect(screen.getByText("Not staged")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Rebuild container/ })).toBeTruthy();
  expect(read).toHaveBeenCalledWith("env-d");
});

test("says when what it shows may not be current", async () => {
  spyOn(capabilitiesApi, "getCapabilityEnvironmentDelivery").mockResolvedValue({
    environmentId: "env-c",
    kind: "container",
    installedDigest: DIGEST,
    stale: false,
    stagedFromCacheAt: "2026-11-19T10:00:00.000Z",
    notice:
      "The command node is unreachable, so this shows only what this machine holds, not whether it is current.",
    items: [],
  } satisfies CapabilityEnvironmentDelivery);
  render(<EnvironmentDeliveryPanel environmentId="env-c" />);
  expect((await screen.findByRole("status")).textContent).toContain(
    "The command node is unreachable",
  );
  expect(screen.getByText(/Staged from the command node's last answer/)).toBeTruthy();
  expect(screen.queryByText("Up to date") === null).toBe(true);
});
