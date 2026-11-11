import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as realBackend from "@/lib/backend";
import { mockToastSuccess as toastSuccessMock } from "../../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";
import { portalStore } from "@/lib/portal/portal-store";
import { projectStore } from "@/stores/projectStore";
import type { Project } from "@/types";
import type { LinearConnectionStatus, LinearNodeConnection } from "@/types/linear";
import { linearKeyFingerprint } from "./linear-machines";

const realBackendSnapshot = { ...realBackend };
const PASTED_KEY = "lin_api_test_value";
const PASTED_FINGERPRINT = linearKeyFingerprint(PASTED_KEY);

const connectLinearMock = mock(
  async (_apiKey: string, machine?: unknown): Promise<LinearConnectionStatus> => {
    if (machine === "node-ci") throw new Error("node-unavailable: CI box is unavailable");
    if (machine === "node-rejecting") throw new Error("Authentication required, not authenticated");
    return {
      connected: true,
      hasToken: true,
      viewer: { id: "viewer-1", name: "Ada" },
      keyFingerprint: PASTED_FINGERPRINT,
    };
  },
);
const getLinearConnectionMock = mock(async (machine?: unknown): Promise<LinearConnectionStatus> => {
  if (machine === "node-laptop") {
    return {
      connected: true,
      hasToken: true,
      viewer: { id: "viewer-2", name: "Bob" },
      keyFingerprint: "ffffffffffffffff",
    };
  }
  return { connected: false, hasToken: false };
});
const getLinearNodeConnectionsMock = mock(
  async (_machine?: unknown): Promise<LinearNodeConnection[]> => [],
);
const getLinearBoardLinkMock = mock(async (_projectId: string, _machine?: unknown) => null);
const setLinearBoardLinkMock = mock(async () => ({ key: "repo:x", updatedAt: "now" }));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  connectLinear: connectLinearMock,
  getLinearConnection: getLinearConnectionMock,
  getLinearNodeConnections: getLinearNodeConnectionsMock,
  getLinearBoardLink: getLinearBoardLinkMock,
  setLinearBoardLink: setLinearBoardLinkMock,
}));

const { LinearConnectDialog } = await import("./LinearConnectDialog");

function summary(
  nodeId: string,
  displayName: string,
  projectId: string,
  hint: string,
  available = true,
): NodeSummary {
  return {
    nodeId,
    available,
    view: { displayName },
    projects: [
      {
        ref: { backendId: nodeId, projectId },
        key: `${nodeId}:${projectId}`,
        name: projectId,
        order: 0,
        repositoryHint: hint,
      },
    ],
    environments: [],
  } as unknown as NodeSummary;
}

const originalPortal = portalStore.store.getState();

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("LinearConnectDialog", () => {
  beforeEach(() => {
    cleanup();
    connectLinearMock.mockClear();
    getLinearConnectionMock.mockClear();
    getLinearNodeConnectionsMock.mockClear();
    getLinearBoardLinkMock.mockClear();
    setLinearBoardLinkMock.mockClear();
    toastSuccessMock.mockClear();
    appCommandStore(projectStore).setState({
      projects: [
        { id: "project-1", name: "Web", gitUrl: "git@github.com:acme/web.git" } as Project,
      ],
    });
    portalStore.store.setState({
      selfId: "node-home" as never,
      nodes: [
        summary("node-laptop", "Laptop", "laptop-web", "github.com/acme/web"),
        summary("node-ci", "CI box", "ci-web", "github.com/acme/web"),
        summary("node-offline", "Old Mac", "mac-web", "github.com/acme/web", false),
        summary("node-other", "Other repo box", "other-api", "github.com/acme/api"),
      ],
    });
  });

  afterEach(() => {
    portalStore.store.setState(originalPortal, true);
  });

  function renderDialog(onConnected = mock((_status: LinearConnectionStatus) => undefined)) {
    renderInAppCommandScope(
      <LinearConnectDialog
        open
        onOpenChange={() => undefined}
        projectId="project-1"
        currentConnection={{ connected: false, hasToken: false }}
        boardLink={{
          key: "repo:github.com/acme/web",
          teamId: "team-eng",
          linearProjectId: "lp-web",
          updatedAt: "2026-11-11T10:00:00.000Z",
        }}
        onConnected={onConnected}
      />,
    );
    return onConnected;
  }

  const row = (name: string) => screen.getByText(name).closest("label")!.parentElement!;

  test("lists the machines with the same repository once a key is pasted", async () => {
    renderDialog();
    expect(screen.queryByText("Connect on these machines") === null).toBe(true);

    fireEvent.change(screen.getByLabelText("Linear API key"), { target: { value: PASTED_KEY } });

    expect(await screen.findByText("Connect on these machines")).toBeTruthy();
    expect(screen.getByText("This machine")).toBeTruthy();
    expect(screen.getByText("Laptop")).toBeTruthy();
    expect(screen.getByText("CI box")).toBeTruthy();
    expect(screen.getByText("Old Mac")).toBeTruthy();
    expect(screen.queryByText("Other repo box") === null).toBe(true);

    // A machine signed in with another key is flagged and left unticked.
    expect(
      await within(row("Laptop")).findByText(
        "Uses a different key as Bob. Connecting replaces it.",
      ),
    ).toBeTruthy();
    expect(within(row("Laptop")).getByRole("checkbox").getAttribute("data-state")).toBe(
      "unchecked",
    );
    expect(within(row("CI box")).getByRole("checkbox").getAttribute("data-state")).toBe("checked");
    expect(within(row("Old Mac")).getByRole("checkbox").hasAttribute("disabled")).toBe(true);
    // This machine is always included.
    const current = row("This machine");
    expect(within(current).getByRole("checkbox").getAttribute("data-state")).toBe("checked");
    expect(within(current).getByRole("checkbox").hasAttribute("disabled")).toBe(true);

    expect(getLinearConnectionMock).toHaveBeenCalledWith("node-laptop");
    expect(getLinearConnectionMock).not.toHaveBeenCalledWith("node-offline");
    expect(document.body.textContent).not.toContain(PASTED_KEY);
  });

  test("sends the key to each ticked machine and reports each answer", async () => {
    const onConnected = renderDialog();
    fireEvent.change(screen.getByLabelText("Linear API key"), { target: { value: PASTED_KEY } });
    await within(row("Laptop")).findByText(/different key/);

    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(connectLinearMock).toHaveBeenCalledWith(PASTED_KEY);
    expect(connectLinearMock).toHaveBeenCalledWith(PASTED_KEY, "node-ci");
    expect(connectLinearMock).not.toHaveBeenCalledWith(PASTED_KEY, "node-laptop");
    expect(connectLinearMock).toHaveBeenCalledTimes(2);

    // The failure keeps the dialog open on the per-machine report.
    expect(await within(row("CI box")).findByText(/^Unreachable:/)).toBeTruthy();
    const current = row("This machine");
    expect(within(current).getByText("Connected as Ada")).toBeTruthy();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(PASTED_KEY);
  });

  test("a machine the user ticks is connected even with a different key there", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Linear API key"), { target: { value: PASTED_KEY } });
    await within(row("Laptop")).findByText(/different key/);
    fireEvent.click(within(row("Laptop")).getByRole("checkbox"));
    fireEvent.click(within(row("CI box")).getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith("Linear connected on 2 machines"),
    );
    expect(connectLinearMock).toHaveBeenCalledWith(PASTED_KEY, "node-laptop");
    expect(connectLinearMock).not.toHaveBeenCalledWith(PASTED_KEY, "node-ci");
    // The board link reaches the newly connected machine's project at once.
    await waitFor(() =>
      expect(setLinearBoardLinkMock).toHaveBeenCalledWith(
        "laptop-web",
        "team-eng",
        "lp-web",
        "node-laptop",
      ),
    );
  });
});
