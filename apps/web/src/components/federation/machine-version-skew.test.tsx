import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { unknownCommand } from "@orkestrator/protocol/contract/errors";
import { portalStore } from "@/lib/portal/portal-store";
import { OutcomeUnknownError } from "@/lib/portal/portal-store";
import { GLOBAL_SETTINGS_REQUEST_EVENT, takeMachineUpdateRequest } from "@/lib/settings-navigation";
import { mockToastError, resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { MachineSectionHeader } from "./FederatedSidebarSections";
import { machineView } from "./federation-ui-test-fixture";
import { reportFederatedActionError } from "./useFederatedEnvironmentActions";
import { viewFromNodeSummary } from "./useMachineViews";

/**
 * Plan item 5006: the machine header shows a node's version when it differs
 * from the command node's, with the domains it lacks, and leads to its
 * update; a typed incompatibility error leads there too.
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

function header(
  release: { version: string | null; domains: Record<string, never> | null } | object,
) {
  render(<MachineSectionHeader machine={machineView({ release: release as never })} />);
  return screen.getByTestId("machine-section-header");
}

describe("the machine header", () => {
  test("shows nothing for a machine on the command node's version", () => {
    const element = header(COMMAND_RELEASE);
    expectDomAbsent(within(element).queryByTestId("machine-version-skew"));
  });

  test("shows nothing while the version is unknown, or from a command node without one", () => {
    expectDomAbsent(
      within(header({ version: null, domains: null })).queryByTestId("machine-version-skew"),
    );
    cleanup();
    portalStore.store.setState({ commandRelease: null });
    expectDomAbsent(
      within(header({ version: "2.38.0", domains: {} })).queryByTestId("machine-version-skew"),
    );
  });

  test("an older machine shows its version and the domains it lacks, and opens its update", () => {
    const element = header({ version: "2.38.0", domains: { git: { min: 1, max: 1 } } });
    const skew = within(element).getByRole("button", { name: /^Update Machine A\./ });
    expect(skew.getAttribute("data-relation")).toBe("older");
    expect(skew.textContent).toBe("2.38.0· lacks nodes, terminals");
    expect(skew.getAttribute("aria-label")).toBe(
      "Update Machine A. Machine A runs Orkestrator 2.38.0, older than the command node's 2.40.0. It lacks nodes, terminals.",
    );
    fireEvent.click(skew);
    expect(takeMachineUpdateRequest()).toBe("bk_a");
    expect(settingsRequests).toEqual(["machines"]);
  });

  test("a pre-contract machine says it predates contracts", () => {
    const skew = within(header({ version: "2.30.0", domains: null })).getByTestId(
      "machine-version-skew",
    );
    expect(skew.textContent).toBe("2.30.0· predates contracts");
    expect(skew.getAttribute("title")).toContain("It predates domain contracts.");
  });

  test("a newer machine shows its version without offering an update", () => {
    const element = header({ version: "2.41.0", domains: COMMAND_RELEASE.domains });
    const skew = within(element).getByTestId("machine-version-skew");
    expect(skew.tagName).toBe("SPAN");
    expect(skew.getAttribute("data-relation")).toBe("newer");
    expectDomAbsent(within(element).queryByRole("button", { name: /^Update/ }));
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
