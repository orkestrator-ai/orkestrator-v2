import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReleaseRequirementItem } from "@orkestrator/protocol/release-requirements";
import type { UpdateJob, UpdateOffer, UpdateStatusSnapshot } from "@orkestrator/protocol/updates";
import type { UpdatesApi } from "@/lib/updates/update-client";
import { UpdateDetails } from "./UpdateDetails";
import { indicatorState } from "./update-text";
import type { UpdateTargetHandle } from "./useUpdateTarget";

afterEach(cleanup);

function item(overrides: Partial<ReleaseRequirementItem>): ReleaseRequirementItem {
  return {
    id: "network-egress:api.example.com",
    category: "network-egress",
    change: "added",
    title: "New network host: api.example.com",
    detail: "Used for toolchain.",
    consent: true,
    actionOnHost: false,
    blocking: false,
    ...overrides,
  };
}

function offer(items: ReleaseRequirementItem[], overrides: Partial<UpdateOffer> = {}): UpdateOffer {
  return {
    version: "2.22.0",
    tag: "v2.22.0",
    channel: "stable",
    requirementsSha256: "a".repeat(64),
    publishedAt: "2026-10-15T00:00:00Z",
    diff: { fromVersion: "2.21.0", toVersion: "2.22.0", baseline: "manifest", items },
    compatibility: { minClientVersion: "2.20.0", minBackendVersion: "2.20.0" },
    downgrade: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<UpdateStatusSnapshot> = {}): UpdateStatusSnapshot {
  return {
    generation: "backend-1",
    revision: 1,
    updateProtocol: 1,
    currentVersion: "2.21.0",
    currentChannel: "stable",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    host: {
      kind: "desktop",
      installKind: "mac-app",
      canInstall: true,
      unavailableReason: null,
      hostVersion: "2.21.0",
      protocolVersion: 1,
    },
    automaticChecks: true,
    check: { status: "ok", checkedAt: "2026-10-15T00:00:00Z", error: null, resolution: "update" },
    available: null,
    downgradeOption: null,
    job: null,
    notices: [],
    ...overrides,
  };
}

function job(overrides: Partial<UpdateJob> = {}): UpdateJob {
  return {
    id: "job-1",
    fromVersion: "2.21.0",
    target: {
      version: "2.22.0",
      tag: "v2.22.0",
      channel: "stable",
      requirementsSha256: "a".repeat(64),
    },
    approvedConsentIds: [],
    restartPolicy: "manual",
    downgrade: false,
    phase: "downloading",
    createdAt: "x",
    updatedAt: "x",
    requester: {
      listener: "control",
      remoteAddress: null,
      tailscaleUser: null,
      identitySource: "local",
      client: null,
    },
    progress: { step: "download", percent: 42, message: "Downloading the app" },
    error: null,
    rollbackFailed: false,
    actionsOnHost: [],
    storageSchemaVersion: 3,
    installWhen: null,
    dependencies: null,
    ...overrides,
  };
}

function target(state: UpdateStatusSnapshot) {
  const calls: string[] = [];
  const api = {
    start: mock(async (...args: unknown[]) => {
      calls.push(`start:${JSON.stringify(args.slice(1))}`);
      return state;
    }),
    installNow: mock(async () => state),
    installOnQuit: mock(async () => state),
    cancel: mock(async () => state),
    acknowledge: mock(async () => state),
    check: mock(async () => state),
  } as unknown as UpdatesApi;
  const handle: UpdateTargetHandle = {
    snapshot: state,
    error: null,
    busy: false,
    api,
    refresh: async () => true,
    run: async (action) => {
      await action(api);
      return true;
    },
  };
  return { handle, api, calls };
}

describe("reviewing an update", () => {
  test("asks for approval of every consent item before updating", () => {
    const consent = item({});
    const info = item({
      id: "provider-binary:claude",
      consent: false,
      title: "claude 2.1.296 → 2.1.300",
    });
    const { handle, calls } = target(snapshot({ available: offer([consent, info]) }));
    render(<UpdateDetails target={handle} scope="local" canInstallOnQuit />);
    expect(screen.getByText("New network host: api.example.com")).toBeTruthy();
    expect(screen.getByText("Also changes (1)")).toBeTruthy();
    const update = screen.getByRole("button", { name: /Approve, update and restart/ });
    expect((update as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Approve these changes" }));
    expect((update as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(update);
    expect(calls).toEqual([
      `start:${JSON.stringify([["network-egress:api.example.com"], "immediate"])}`,
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Download now, restart later" }));
    expect(calls.at(-1)).toContain('"manual"');
  });

  test("an approval does not carry over to a changed offer", () => {
    const first = target(snapshot({ available: offer([item({})]) }));
    const { rerender } = render(
      <UpdateDetails target={first.handle} scope="local" canInstallOnQuit />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Approve these changes" }));
    const changed = offer([item({})], { requirementsSha256: "b".repeat(64) });
    const second = target(snapshot({ available: changed }));
    rerender(<UpdateDetails target={second.handle} scope="local" canInstallOnQuit />);
    const update = screen.getByRole("button", { name: /Approve, update and restart/ });
    expect((update as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByRole("checkbox", { name: "Approve these changes" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("an update with nothing to approve is one click", () => {
    const { handle, calls } = target(snapshot({ available: offer([]) }));
    render(<UpdateDetails target={handle} scope="local" />);
    fireEvent.click(screen.getByRole("button", { name: /Update and restart/ }));
    expect(calls).toHaveLength(1);
  });

  test("a blocker and a missing installer disable the update, with their reasons", () => {
    const blocker = item({
      id: "storage-migration:floor-3",
      category: "storage-migration",
      title: "2.22.0 cannot open this machine's data",
      consent: false,
      blocking: true,
    });
    const { handle } = target(snapshot({ available: offer([blocker]) }));
    render(<UpdateDetails target={handle} scope="local" />);
    expect(screen.getByText("2.22.0 cannot open this machine's data")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Update and restart/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    const noHost = snapshot({
      available: offer([]),
      host: {
        ...snapshot().host,
        kind: "none",
        canInstall: false,
        unavailableReason: "Restart it with orkestrator serve --supervised",
      },
    });
    render(<UpdateDetails target={target(noHost).handle} scope="remote" machineName="build-box" />);
    expect(screen.getByTestId("update-unavailable-reason").textContent).toContain("--supervised");
    expect(
      (screen.getByRole("button", { name: /Update remote/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("a remote that needs a newer client asks to update this app first", () => {
    const remote = snapshot({
      available: offer([], {
        compatibility: { minClientVersion: "2.22.0", minBackendVersion: "2.21.0" },
      }),
    });
    render(
      <UpdateDetails
        target={target(remote).handle}
        scope="remote"
        machineName="build-box"
        clientVersion="2.21.0"
      />,
    );
    expect(screen.getByText(/Update this app first/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Update remote/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("consent on a remote names the machine and flags what needs someone there", () => {
    const permission = item({
      id: "macos-permission:downloads",
      category: "macos-permission",
      title: "New: Downloads folder access (required)",
      actionOnHost: true,
    });
    render(
      <UpdateDetails
        target={target(snapshot({ available: offer([permission]) })).handle}
        scope="remote"
        machineName="studio-mac"
      />,
    );
    expect(screen.getByText("Needs your approval on studio-mac")).toBeTruthy();
    expect(screen.getByText(/Needs someone at the updated machine/)).toBeTruthy();
    expect(screen.getByText(/interrupts agents running there/)).toBeTruthy();
  });

  test("installing an older release needs its own confirmation", () => {
    const waiting = snapshot({
      currentVersion: "2.22.0-beta.2",
      check: { status: "ok", checkedAt: null, error: null, resolution: "waiting-for-channel" },
      downgradeOption: offer([], { version: "2.21.0", downgrade: true }),
    });
    const { handle, calls } = target(waiting);
    render(<UpdateDetails target={handle} scope="local" />);
    expect(screen.getByTestId("update-status-line").textContent).toContain(
      "newer than anything on Stable",
    );
    const install = screen.getByRole("button", { name: /Update and restart/ }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Confirm installing an older version" }));
    fireEvent.click(install);
    expect(calls).toHaveLength(1);
  });
});

describe("a running update", () => {
  test("shows progress and can be cancelled before installing", () => {
    const { handle, api } = target(snapshot({ job: job() }));
    render(<UpdateDetails target={handle} scope="local" />);
    expect(screen.getByTestId("update-job").textContent).toContain("Downloading the update 2.22.0");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancel).toHaveBeenCalledWith("job-1");
  });

  test("a ready update restarts now or installs on quit", () => {
    const { handle, api } = target(snapshot({ job: job({ phase: "ready", progress: null }) }));
    render(<UpdateDetails target={handle} scope="local" canInstallOnQuit />);
    fireEvent.click(screen.getByRole("button", { name: "Install when I quit" }));
    expect(api.installOnQuit).toHaveBeenCalledWith("job-1");
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(api.installNow).toHaveBeenCalledWith("job-1");
  });

  test("notices can be dismissed", () => {
    const { handle, api } = target(
      snapshot({
        notices: [
          {
            id: "n-1",
            kind: "action-needed-on-host",
            jobId: "job-1",
            version: "2.22.0",
            createdAt: "x",
            message: "2.22.0 needs someone at this machine to finish setting it up.",
            items: [
              item({
                id: "macos-permission:downloads",
                title: "Downloads folder",
                detail: "Grant it.",
              }),
            ],
          },
        ],
      }),
    );
    render(<UpdateDetails target={handle} scope="local" />);
    expect(screen.getByText("Downloads folder: Grant it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(api.acknowledge).toHaveBeenCalledWith("n-1");
  });
});

describe("indicator state", () => {
  test("shows only when there is something to do", () => {
    expect(indicatorState(null)).toEqual({ kind: "none" });
    expect(indicatorState(snapshot())).toEqual({ kind: "none" });
    expect(indicatorState(snapshot({ available: offer([]) }))).toEqual({
      kind: "available",
      version: "2.22.0",
    });
    expect(
      indicatorState(
        snapshot({ available: offer([]), host: { ...snapshot().host, canInstall: false } }),
      ),
    ).toEqual({ kind: "none" });
    expect(indicatorState(snapshot({ job: job() }))).toEqual({
      kind: "working",
      label: "Downloading the update",
      percent: 42,
    });
    expect(indicatorState(snapshot({ job: job({ phase: "ready" }) }))).toEqual({
      kind: "ready",
      version: "2.22.0",
    });
    expect(
      indicatorState(
        snapshot({
          notices: [
            {
              id: "n",
              kind: "update-rolled-back",
              jobId: "j",
              version: "2.22.0",
              createdAt: "x",
              message: "m",
              items: [],
            },
          ],
        }),
      ).kind,
    ).toBe("attention");
  });
});
