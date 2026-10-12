import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { EnvironmentDiskUsage } from "@/lib/backend";
import { EnvironmentDiskUsageView } from "./EnvironmentDiskUsageBreakdown";

afterEach(cleanup);

const GB = 1024 ** 3;

function usage(overrides: Partial<EnvironmentDiskUsage> = {}): EnvironmentDiskUsage {
  return {
    environmentId: "e1",
    environmentType: "local",
    measuredAt: new Date().toISOString(),
    primary: {
      kind: "worktree",
      path: "/w/app-feature",
      bytes: 3 * GB,
      items: [
        { label: "node_modules", path: "/w/app-feature/node_modules", bytes: 2 * GB },
        { label: "src", path: "/w/app-feature/src", bytes: GB },
      ],
    },
    dev: {
      profiles: [
        {
          id: "workspace-1234abcd",
          profileRoot: "/dev/profiles/workspace-1234abcd",
          worktreeDir: "/dev/profiles/workspace-1234abcd/worktrees",
          stateBytes: GB,
          worktrees: [{ label: "app-dev", path: "/dev/trees/app-dev", bytes: 2 * GB }],
          bytes: 3 * GB,
        },
      ],
      worktreeBytes: 2 * GB,
      bytes: 3 * GB,
    },
    totalBytes: 6 * GB,
    ...overrides,
  };
}

describe("EnvironmentDiskUsageView", () => {
  test("itemises the worktree and every dev worktree with totals", () => {
    render(
      <EnvironmentDiskUsageView
        usage={usage()}
        loading={false}
        error={null}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText("6 GB")).toBeTruthy();
    expect(screen.getByText("node_modules")).toBeTruthy();
    expect(screen.getByText("Dev worktrees (1)")).toBeTruthy();
    expect(screen.getByText("workspace-1234abcd")).toBeTruthy();
    expect(screen.getByText("app-dev")).toBeTruthy();
    expect(screen.getByText(/3 GB total · profile data 1 GB/)).toBeTruthy();
  });

  test("explains a container and leaves out dev worktrees", () => {
    const onRefresh = mock(() => {});
    render(
      <EnvironmentDiskUsageView
        usage={usage({
          environmentType: "containerized",
          primary: {
            kind: "container",
            path: null,
            bytes: GB,
            items: [{ label: "Container writable layer", path: null, bytes: GB }],
          },
          dev: { profiles: [], worktreeBytes: 0, bytes: 0 },
          totalBytes: GB,
        })}
        loading={false}
        error={null}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText("Container writable layer")).toBeTruthy();
    expect(screen.queryByText(/Dev worktrees/) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("shows progress before the first measurement", () => {
    render(<EnvironmentDiskUsageView usage={null} loading error={null} onRefresh={() => {}} />);
    expect(screen.getByText("Measuring disk usage…")).toBeTruthy();
  });
});
