import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { unknownCommand } from "@orkestrator/protocol/contract/errors";
import { portalStore } from "@/lib/portal/portal-store";
import { OutcomeUnknownError } from "@/lib/portal/portal-store";
import { GLOBAL_SETTINGS_REQUEST_EVENT, takeMachineUpdateRequest } from "@/lib/settings-navigation";
import { mockToastError, resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { machineView } from "./federation-ui-test-fixture";
import { MachineTiles } from "./MachineTiles";
import { reportFederatedActionError } from "./useFederatedEnvironmentActions";
import { viewFromNodeSummary } from "./useMachineViews";

/**
 * Plan item 5006: a machine's tile names its version in its tooltip when it
 * differs from the command node's, with the domains it lacks, and marks a
 * machine whose update is offered with an amber dot; a typed incompatibility
 * error leads to the update.
 */

const INITIAL_PORTAL_STATE = portalStore.getState();
const COMMAND_RELEASE = {
  version: "2.40.0",
  domains: { git: { min: 1, max: 2 }, nodes: { min: 1, max: 1 }, terminals: { min: 1, max: 1 } },
};

let settingsRequests: string[] = [];
const recordSettings = (event: Event) =>
  settingsRequests.push(String((event as CustomEvent<unknown>).detail));

beforeEach(() => {
  portalStore.store.setState({ commandRelease: COMMAND_RELEASE });
  settingsRequests = [];
  window.addEventListener(GLOBAL_SETTINGS_REQUEST_EVENT, recordSettings);
});

afterEach(() => {
  cleanup();
  window.removeEventListener(GLOBAL_SETTINGS_REQUEST_EVENT, recordSettings);
  portalStore.store.setState(INITIAL_PORTAL_STATE, true);
  takeMachineUpdateRequest();
  resetSonnerMocks();
});

function tile(release: { version: string | null; domains: Record<string, never> | null } | object) {
  renderInAppCommandScope(<MachineTiles machines={[machineView({ release: release as never })]} />);
  return screen.getByTestId("machine-tile");
}

/** The tooltip's lines between the machine's CPU and whether it is shown. */
function versionLines(element: HTMLElement): string[] {
  return (element.getAttribute("title") ?? "").split("\n").slice(2, -1);
}

describe("the machine tile", () => {
  test("shows nothing for a machine on the command node's version", () => {
    const element = tile(COMMAND_RELEASE);
    expectDomAbsent(screen.queryByTestId("machine-tile-update"));
    expect(versionLines(element)).toEqual([]);
  });

  test("shows nothing while the version is unknown, or from a command node without one", () => {
    expect(versionLines(tile({ version: null, domains: null }))).toEqual([]);
    expectDomAbsent(screen.queryByTestId("machine-tile-update"));
    cleanup();
    portalStore.store.setState({ commandRelease: null });
    expect(versionLines(tile({ version: "2.38.0", domains: {} }))).toEqual([]);
    expectDomAbsent(screen.queryByTestId("machine-tile-update"));
  });

  test("an older machine names its version and the domains it lacks, and is marked for update", () => {
    const element = tile({ version: "2.38.0", domains: { git: { min: 1, max: 1 } } });
    expect(versionLines(element)).toEqual([
      "Machine A runs Orkestrator 2.38.0, older than the command node's 2.40.0. It lacks nodes, terminals.",
    ]);
    expect(screen.getByTestId("machine-tile-update")).toBeTruthy();
  });

  test("a pre-contract machine says it predates contracts", () => {
    const element = tile({ version: "2.30.0", domains: null });
    expect(element.getAttribute("title")).toContain("It predates domain contracts.");
    expect(screen.getByTestId("machine-tile-update")).toBeTruthy();
  });

  test("a newer machine names its version without offering an update", () => {
    const element = tile({ version: "2.41.0", domains: COMMAND_RELEASE.domains });
    expect(versionLines(element)).toHaveLength(1);
    expect(versionLines(element)[0]).toContain("2.41.0");
    expectDomAbsent(screen.queryByTestId("machine-tile-update"));
  });

  test("a node summary supplies the release; a disconnected one has none to compare", () => {
    const summary = {
      nodeId: "bk_n" as never,
      view: {
        displayName: "N",
        connection: { state: "connected", epoch: 1 },
      } as never,
      available: true,
      version: "2.38.0",
      domains: null,
      freshness: "current" as const,
      loadedAt: 1,
      truncated: false,
      lastError: null,
      projects: [],
      environments: [],
    };
    expect(viewFromNodeSummary(summary).release).toEqual({ version: "2.38.0", domains: null });
    // A command node that predates the version field gives no release at all.
    const { version: _version, ...older } = summary;
    expect(viewFromNodeSummary(older).release).toBeUndefined();
  });
});

describe("typed incompatibility errors", () => {
  const machine = machineView({ release: { version: "2.38.0", domains: null } });

  test("lead to the machine's update", () => {
    reportFederatedActionError("Stop", machine, unknownCommand("stop_environment"));
    const [title, options] = mockToastError.mock.calls[0]! as [
      string,
      { description: string; action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Stop failed on Machine A");
    expect(options.description).toBe("Not available on Machine A (version 2.38.0). Update it.");
    expect(options.action.label).toBe("Update");
    options.action.onClick();
    expect(takeMachineUpdateRequest()).toBe("bk_a");
    expect(settingsRequests).toEqual(["machines"]);
  });

  test("other failures keep their message and offer no update", () => {
    reportFederatedActionError("Stop", machine, new Error("Container is busy"));
    const [, options] = mockToastError.mock.calls[0]! as [string, Record<string, unknown>];
    expect(options).toEqual({ description: "Container is busy" });
    reportFederatedActionError("Stop", machine, new OutcomeUnknownError("bk_a" as never, "x", "k"));
    expect(mockToastError.mock.calls).toHaveLength(1);
  });
});
