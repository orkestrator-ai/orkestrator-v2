import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as realPreference from "./useBuildNetworkPreference";
const realPreferenceSnapshot = { ...realPreference };
mock.module("./useBuildNetworkPreference", () => ({
  useBuildNetworkPreference: () => ({ mode: "full", pending: false, error: false }),
}));
import * as realDialog from "@/components/ui/dialog";
import type { AgentModelCatalog } from "@/lib/agent-launch";

const realDialogSnapshot = { ...realDialog };

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

// The other machine's Docker answer, which needs a connected node to ask.
let remoteDocker: boolean | null = null;
const dockerAsks: Array<{ machine: unknown; enabled: boolean }> = [];
mock.module("./useMachineDockerAvailability", () => ({
  useMachineDockerAvailability: (machine: unknown, enabled: boolean) => {
    dockerAsks.push({ machine, enabled });
    return enabled ? remoteDocker : null;
  },
}));

import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { BuildLaunchDialog, type BuildLaunchSelection } from "./BuildLaunchDialog";
import type { BuildLaunchMachine } from "./build-machines";

const catalog: AgentModelCatalog = {
  claude: [{ id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] }],
  codex: [],
  opencode: [],
  cursor: [],
  grok: [],
  pi: [],
};

const own: BuildLaunchMachine = {
  key: "node:own",
  name: "Studio Mac",
  machine: undefined,
  nodeId: "own",
  projectId: "project-own",
  current: true,
  available: true,
  hasCheckout: true,
};
const builder: BuildLaunchMachine = {
  key: "node:builder",
  name: "Builder",
  machine: "builder",
  nodeId: "builder",
  projectId: "project-builder",
  current: false,
  available: true,
  hasCheckout: true,
};
const asleep: BuildLaunchMachine = {
  key: "node:asleep",
  name: "Laptop",
  machine: "asleep",
  nodeId: "asleep",
  projectId: "project-asleep",
  current: false,
  available: false,
  hasCheckout: true,
};

afterEach(cleanup);
beforeEach(() => {
  remoteDocker = null;
  dockerAsks.length = 0;
});
afterAll(() => {
  mock.module("./useBuildNetworkPreference", () => realPreferenceSnapshot);
  mock.module("@/components/ui/dialog", () => realDialogSnapshot);
});

function renderDialog(
  props: Partial<Parameters<typeof BuildLaunchDialog>[0]> = {},
  dockerAvailable = true,
) {
  const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
  renderInAppCommandScope(
    <DockerAvailabilityProvider available={dockerAvailable}>
      <BuildLaunchDialog
        open
        onOpenChange={() => undefined}
        catalog={catalog}
        defaultAgent="claude"
        defaultEnvironmentType="containerized"
        onConfirm={onConfirm}
        {...props}
      />
    </DockerAvailabilityProvider>,
  );
  return onConfirm;
}

function machineSelect() {
  return screen.getByRole("combobox", { name: "Machine" });
}

async function machineOptions() {
  fireEvent.click(machineSelect());
  return screen.findAllByRole("option");
}

async function pickMachine(name: RegExp) {
  fireEvent.click(machineSelect());
  fireEvent.click(await screen.findByRole("option", { name }));
}

function environmentGroup() {
  return screen.getByRole("radiogroup", { name: "Where it runs" });
}

function start() {
  fireEvent.click(screen.getByRole("button", { name: "Start build" }));
}

describe("BuildLaunchDialog machine choice", () => {
  test("offers no machine choice without another machine", () => {
    renderDialog({ machines: [own] });
    expect(screen.queryByRole("combobox", { name: "Machine" }) === null).toBe(true);
    renderDialog();
    expect(screen.queryByRole("combobox", { name: "Machine" }) === null).toBe(true);
  });

  test("opens on this machine and launches without a machine choice", () => {
    const onConfirm = renderDialog({ machines: [own, builder] });
    expect(machineSelect().textContent).toContain("Studio Mac");
    expect(machineSelect().textContent).not.toContain("Builder");

    start();
    expect(onConfirm.mock.calls[0]![0].machine).toBeUndefined();
  });

  test("reports the picked machine with its own project", async () => {
    remoteDocker = true;
    const onConfirm = renderDialog({ machines: [own, builder] });
    await pickMachine(/Builder/);

    start();
    expect(onConfirm.mock.calls[0]![0].machine).toEqual({
      machine: "builder",
      nodeId: "builder",
      projectId: "project-builder",
      name: "Builder",
    });
  });

  test("picking this machine again drops the choice", async () => {
    const onConfirm = renderDialog({ machines: [own, builder] });
    await pickMachine(/Builder/);
    await pickMachine(/Studio Mac/);

    start();
    expect(onConfirm.mock.calls[0]![0].machine).toBeUndefined();
  });

  test("lists every machine as a dropdown option, disabling one the command node cannot reach", async () => {
    renderDialog({ machines: [own, builder, asleep] });
    const options = await machineOptions();
    expect(options.map((option) => option.textContent)).toEqual([
      "Studio MacThis machine",
      "Builder",
      "LaptopNot connected",
    ]);
    const laptop = screen.getByRole("option", { name: /Laptop/ });
    expect(laptop.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("option", { name: /Builder/ }).getAttribute("aria-disabled")).not.toBe(
      "true",
    );
  });

  test("shows each machine's colour beside its name", async () => {
    renderDialog({
      machines: [{ ...own, colorToken: "violet" }, { ...builder, colorToken: "teal" }, asleep],
    });
    const triggerDot = within(machineSelect()).getByTestId("machine-color-dot");
    expect(triggerDot.getAttribute("data-machine-color")).toBe("violet");

    const options = await machineOptions();
    const colours = options.map((option) =>
      within(option).getByTestId("machine-color-dot").getAttribute("data-machine-color"),
    );
    // A machine with no colour token draws the labelled neutral fallback.
    expect(colours).toEqual(["violet", "teal", "neutral"]);
  });

  test("names where a build on another machine runs", async () => {
    remoteDocker = true;
    renderDialog({ machines: [own, builder] });
    expect(screen.queryByText(/follow it from that machine/) === null).toBe(true);
    await pickMachine(/Builder/);
    expect(machineSelect().textContent).toContain("Builder");
    expect(screen.getByText("Runs on Builder; follow it from that machine.")).toBeTruthy();
  });

  test("asks about Docker only for another machine", async () => {
    renderDialog({ machines: [own, builder] });
    expect(dockerAsks.every((ask) => !ask.enabled)).toBe(true);

    await pickMachine(/Builder/);
    expect(dockerAsks.at(-1)).toEqual({ machine: "builder", enabled: true });
  });

  test("judges Container by the picked machine's Docker, not this one's", async () => {
    // This machine has no Docker; the builder does.
    const onConfirm = renderDialog({ machines: [own, builder] }, false);
    const container = () =>
      within(environmentGroup()).getByRole("radio", { name: /^Container/ }) as HTMLInputElement;
    expect(container().disabled).toBe(true);

    remoteDocker = true;
    await pickMachine(/Builder/);
    expect(container().disabled).toBe(false);
    fireEvent.click(container());

    start();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("containerized");
    expect(onConfirm.mock.calls[0]![0].machine?.machine).toBe("builder");
  });

  test("falls back to local when the picked machine has no Docker", async () => {
    const onConfirm = renderDialog({ machines: [own, builder] });
    remoteDocker = false;
    await pickMachine(/Builder/);

    const container = within(environmentGroup()).getByRole("radio", {
      name: /^Container/,
    }) as HTMLInputElement;
    expect(container.disabled).toBe(true);
    expect(
      (within(environmentGroup()).getByRole("radio", { name: /^Local/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(within(environmentGroup()).getByText(/Git worktree on Builder/)).toBeTruthy();

    start();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
  });

  test("ignores this machine's missing checkout for another machine", async () => {
    const onConfirm = renderDialog({
      machines: [own, builder],
      localEnvironmentAvailable: false,
      defaultEnvironmentType: "local",
    });
    await pickMachine(/Builder/);
    expect(
      (within(environmentGroup()).getByRole("radio", { name: /^Local/ }) as HTMLInputElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(within(environmentGroup()).getByRole("radio", { name: /^Local/ }));
    start();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
    expect(onConfirm.mock.calls[0]![0].machine?.machine).toBe("builder");
  });

  test("a pick that left the offered machines falls back to this machine", async () => {
    const view = renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <BuildLaunchDialog
          open
          onOpenChange={() => undefined}
          catalog={catalog}
          defaultAgent="claude"
          defaultEnvironmentType="containerized"
          machines={[own, builder]}
          onConfirm={() => undefined}
        />
      </DockerAvailabilityProvider>,
    );
    await pickMachine(/Builder/);
    view.rerender(
      <DockerAvailabilityProvider available>
        <BuildLaunchDialog
          open
          onOpenChange={() => undefined}
          catalog={catalog}
          defaultAgent="claude"
          defaultEnvironmentType="containerized"
          machines={[own, { ...builder, key: "node:other" }]}
          onConfirm={() => undefined}
        />
      </DockerAvailabilityProvider>,
    );
    expect(machineSelect().textContent).toContain("Studio Mac");
    expect(machineSelect().textContent).not.toContain("Builder");
  });

  test("holds Container while the picked machine's Docker check is pending", async () => {
    const props = {
      open: true,
      onOpenChange: () => undefined,
      catalog,
      defaultAgent: "claude" as const,
      defaultEnvironmentType: "containerized" as const,
      machines: [own, builder],
    };
    const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
    const view = renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <BuildLaunchDialog {...props} onConfirm={onConfirm} />
      </DockerAvailabilityProvider>,
    );
    await pickMachine(/Builder/);
    const container = () =>
      within(environmentGroup()).getByRole("radio", { name: /^Container/ }) as HTMLInputElement;

    // Unknown is neither "yes" (offer Container) nor "no" (switch to Local).
    expect(container().disabled).toBe(true);
    expect(container().checked).toBe(true);
    expect(within(environmentGroup()).getByText("Checking Docker on Builder…")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start build" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    start();
    expect(onConfirm).not.toHaveBeenCalled();

    remoteDocker = true;
    view.rerender(
      <DockerAvailabilityProvider available>
        <BuildLaunchDialog {...props} onConfirm={onConfirm} />
      </DockerAvailabilityProvider>,
    );
    expect(container().disabled).toBe(false);
    start();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("containerized");
    expect(onConfirm.mock.calls[0]![0].machine?.machine).toBe("builder");
  });

  test("a pending check that answers no switches to Local", async () => {
    const props = {
      open: true,
      onOpenChange: () => undefined,
      catalog,
      defaultAgent: "claude" as const,
      defaultEnvironmentType: "containerized" as const,
      machines: [own, builder],
      onConfirm: () => undefined,
    };
    const view = renderInAppCommandScope(
      <DockerAvailabilityProvider available>
        <BuildLaunchDialog {...props} />
      </DockerAvailabilityProvider>,
    );
    await pickMachine(/Builder/);
    remoteDocker = false;
    view.rerender(
      <DockerAvailabilityProvider available>
        <BuildLaunchDialog {...props} />
      </DockerAvailabilityProvider>,
    );
    const container = within(environmentGroup()).getByRole("radio", {
      name: /^Container/,
    }) as HTMLInputElement;
    expect(container.disabled).toBe(true);
    expect(
      within(environmentGroup()).getByText("Containers unavailable while Docker stopped"),
    ).toBeTruthy();
    expect(
      (within(environmentGroup()).getByRole("radio", { name: /^Local/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  test("offers no Local build when the picked machine's project has no checkout", async () => {
    const remoteOnly = { ...builder, hasCheckout: false };
    remoteDocker = false;
    const onConfirm = renderDialog({
      machines: [own, remoteOnly],
      defaultEnvironmentType: "local",
    });
    await pickMachine(/Builder/);

    const local = within(environmentGroup()).getByRole("radio", {
      name: /^Local/,
    }) as HTMLInputElement;
    expect(local.disabled).toBe(true);
    expect(within(environmentGroup()).getByText("No project checkout on Builder")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start build" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    start();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a remote-only project with Docker builds in a container, never locally", async () => {
    const remoteOnly = { ...builder, hasCheckout: false };
    remoteDocker = true;
    const onConfirm = renderDialog({
      machines: [own, remoteOnly],
      defaultEnvironmentType: "local",
    });
    await pickMachine(/Builder/);

    const local = within(environmentGroup()).getByRole("radio", {
      name: /^Local/,
    }) as HTMLInputElement;
    expect(local.disabled).toBe(true);
    expect(
      (within(environmentGroup()).getByRole("radio", { name: /^Container/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    start();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("containerized");
    expect(onConfirm.mock.calls[0]![0].machine?.machine).toBe("builder");
  });

  test("a picked machine that goes offline falls back to this machine", async () => {
    remoteDocker = true;
    const onConfirm = mock((_selection: BuildLaunchSelection) => undefined);
    const dialog = (machines: BuildLaunchMachine[]) => (
      <DockerAvailabilityProvider available>
        <BuildLaunchDialog
          open
          onOpenChange={() => undefined}
          catalog={catalog}
          defaultAgent="claude"
          defaultEnvironmentType="containerized"
          machines={machines}
          onConfirm={onConfirm}
        />
      </DockerAvailabilityProvider>
    );
    const view = renderInAppCommandScope(dialog([own, builder]));
    await pickMachine(/Builder/);
    view.rerender(dialog([own, { ...builder, available: false }]));

    expect(machineSelect().textContent).toContain("Studio Mac");
    expect(machineSelect().textContent).not.toContain("Builder");
    start();
    expect(onConfirm.mock.calls[0]![0].machine).toBeUndefined();
    const options = await machineOptions();
    expect(options[1]!.getAttribute("aria-disabled")).toBe("true");
  });
});
