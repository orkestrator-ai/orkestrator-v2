import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

import * as backend from "@/lib/backend";
import type { EnvironmentDiskUsage } from "@/lib/backend";
import { EnvironmentDiskUsageView, useEnvironmentDiskUsage } from "./EnvironmentDiskUsageBreakdown";

afterEach(() => {
  cleanup();
  mock.restore();
});

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("disk usage hook reconciliation", () => {
  test("incoming overview settles loading and prevents a pending older result from replacing it", async () => {
    const pending = deferred<EnvironmentDiskUsage>();
    const get = spyOn(backend, "getEnvironmentDiskUsage").mockImplementation(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ initial }: { initial?: EnvironmentDiskUsage }) =>
        useEnvironmentDiskUsage("e1", { initial }),
      { initialProps: { initial: undefined } as { initial?: EnvironmentDiskUsage } },
    );
    expect(result.current.loading).toBe(true);
    const overview = usage({ measuredAt: "2026-10-12T02:00:00Z", totalBytes: 7 * GB });
    rerender({ initial: overview });
    expect(result.current.usage).toBe(overview);
    expect(result.current.loading).toBe(false);
    await act(async () => pending.resolve(usage({ totalBytes: GB })));
    expect(result.current.usage).toBe(overview);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("initial skips loading and replacement snapshots update expanded rows", () => {
    const get = spyOn(backend, "getEnvironmentDiskUsage").mockResolvedValue(usage());
    const first = usage();
    const { result, rerender } = renderHook(
      ({ initial }) => useEnvironmentDiskUsage("e1", { initial }),
      { initialProps: { initial: first } },
    );
    expect(result.current.usage).toBe(first);
    expect(result.current.loading).toBe(false);
    const next = usage({ totalBytes: 8 * GB, measuredAt: "2027-01-01T00:00:00Z" });
    rerender({ initial: next });
    expect(result.current.usage).toBe(next);
    expect(get).not.toHaveBeenCalled();
  });

  test("environment changes and newer refresh requests reject stale completion", async () => {
    const old = deferred<EnvironmentDiskUsage>();
    const fresh = deferred<EnvironmentDiskUsage>();
    const get = spyOn(backend, "getEnvironmentDiskUsage").mockImplementation((id) =>
      id === "e1" ? old.promise : fresh.promise,
    );
    const { result, rerender } = renderHook(({ id }) => useEnvironmentDiskUsage(id), {
      initialProps: { id: "e1" },
    });
    rerender({ id: "e2" });
    await act(async () => old.resolve(usage()));
    expect(result.current.usage).toBeNull();
    expect(result.current.loading).toBe(true);
    const next = usage({ environmentId: "e2" });
    await act(async () => fresh.resolve(next));
    expect(result.current.usage).toBe(next);
    expect(result.current.loading).toBe(false);
    const earlier = deferred<EnvironmentDiskUsage>();
    const later = deferred<EnvironmentDiskUsage>();
    get.mockImplementationOnce(() => earlier.promise).mockImplementationOnce(() => later.promise);
    let earlyRefresh!: Promise<EnvironmentDiskUsage | null>;
    let lateRefresh!: Promise<EnvironmentDiskUsage | null>;
    act(() => {
      earlyRefresh = result.current.refresh();
      lateRefresh = result.current.refresh();
    });
    const updated = usage({ environmentId: "e2", totalBytes: 9 * GB });
    await act(async () => {
      later.resolve(updated);
      await lateRefresh;
    });
    await act(async () => {
      earlier.resolve(next);
      expect(await earlyRefresh).toBeNull();
    });
    expect(result.current.usage).toBe(updated);
    expect(result.current.loading).toBe(false);
  });

  test("disabled hooks load when enabled and recover after refresh errors", async () => {
    const get = spyOn(backend, "getEnvironmentDiskUsage").mockResolvedValue(usage());
    const { result, rerender } = renderHook(
      ({ enabled }) => useEnvironmentDiskUsage("e1", { enabled }),
      { initialProps: { enabled: false } },
    );
    expect(result.current.loading).toBe(false);
    expect(get).not.toHaveBeenCalled();
    await act(async () => rerender({ enabled: true }));
    expect(result.current.usage?.environmentId).toBe("e1");
    get.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("offline");
    expect(result.current.loading).toBe(false);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(get).toHaveBeenLastCalledWith("e1", true, undefined);
  });
});

test("older or identical incoming measurement identities do not overwrite refreshed usage", async () => {
  const first = usage({ measuredAt: "2026-10-12T01:00:00Z" });
  const newer = usage({ measuredAt: "2026-10-12T03:00:00Z", totalBytes: 9 * GB });
  spyOn(backend, "getEnvironmentDiskUsage").mockResolvedValue(newer);
  const { result, rerender } = renderHook(
    ({ initial }) => useEnvironmentDiskUsage("e1", { initial }),
    { initialProps: { initial: first } },
  );
  await act(async () => {
    await result.current.refresh();
  });
  rerender({ initial: { ...first } });
  expect(result.current.usage).toBe(newer);
  rerender({ initial: usage({ measuredAt: "2026-10-12T02:00:00Z" }) });
  expect(result.current.usage).toBe(newer);
  expect(result.current.loading).toBe(false);
});
