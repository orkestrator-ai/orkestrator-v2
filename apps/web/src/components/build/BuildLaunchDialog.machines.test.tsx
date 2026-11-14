import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
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

function machineGroup() {
  return screen.getByRole("radiogroup", { name: "Machine" });
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
    expect(screen.queryByRole("radiogroup", { name: "Machine" }) === null).toBe(true);
    renderDialog();
    expect(screen.queryByRole("radiogroup", { name: "Machine" }) === null).toBe(true);
  });

  test("opens on this machine and launches without a machine choice", () => {
    const onConfirm = renderDialog({ machines: [own, builder] });
    const radios = within(machineGroup()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);

    start();
    expect(onConfirm.mock.calls[0]![0].machine).toBeUndefined();
  });

  test("reports the picked machine with its own project", () => {
    remoteDocker = true;
    const onConfirm = renderDialog({ machines: [own, builder] });
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));

    start();
    expect(onConfirm.mock.calls[0]![0].machine).toEqual({
      machine: "builder",
      nodeId: "builder",
      projectId: "project-builder",
      name: "Builder",
    });
  });

  test("picking this machine again drops the choice", () => {
    const onConfirm = renderDialog({ machines: [own, builder] });
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Studio Mac/ }));

    start();
    expect(onConfirm.mock.calls[0]![0].machine).toBeUndefined();
  });

  test("disables a machine the command node cannot reach", () => {
    renderDialog({ machines: [own, builder, asleep] });
    const radio = within(machineGroup()).getByRole("radio", { name: /Laptop/ });
    expect((radio as HTMLInputElement).disabled).toBe(true);
    expect(within(machineGroup()).getByText("Not connected")).toBeTruthy();
  });

  test("asks about Docker only for another machine", () => {
    renderDialog({ machines: [own, builder] });
    expect(dockerAsks.every((ask) => !ask.enabled)).toBe(true);

    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));
    expect(dockerAsks.at(-1)).toEqual({ machine: "builder", enabled: true });
  });

  test("judges Container by the picked machine's Docker, not this one's", () => {
    // This machine has no Docker; the builder does.
    const onConfirm = renderDialog({ machines: [own, builder] }, false);
    const container = () =>
      within(environmentGroup()).getByRole("radio", { name: /^Container/ }) as HTMLInputElement;
    expect(container().disabled).toBe(true);

    remoteDocker = true;
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));
    expect(container().disabled).toBe(false);
    fireEvent.click(container());

    start();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("containerized");
    expect(onConfirm.mock.calls[0]![0].machine?.machine).toBe("builder");
  });

  test("falls back to local when the picked machine has no Docker", () => {
    const onConfirm = renderDialog({ machines: [own, builder] });
    remoteDocker = false;
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));

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

  test("ignores this machine's missing checkout for another machine", () => {
    const onConfirm = renderDialog({
      machines: [own, builder],
      localEnvironmentAvailable: false,
      defaultEnvironmentType: "local",
    });
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));
    expect(
      (within(environmentGroup()).getByRole("radio", { name: /^Local/ }) as HTMLInputElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(within(environmentGroup()).getByRole("radio", { name: /^Local/ }));
    start();
    expect(onConfirm.mock.calls[0]![0].environmentType).toBe("local");
    expect(onConfirm.mock.calls[0]![0].machine?.machine).toBe("builder");
  });

  test("a pick that left the offered machines falls back to this machine", () => {
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
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));
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
    const radios = within(machineGroup()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
  });

  test("holds Container while the picked machine's Docker check is pending", () => {
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
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));
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

  test("a pending check that answers no switches to Local", () => {
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
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));
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

  test("offers no Local build when the picked machine's project has no checkout", () => {
    const remoteOnly = { ...builder, hasCheckout: false };
    remoteDocker = false;
    const onConfirm = renderDialog({
      machines: [own, remoteOnly],
      defaultEnvironmentType: "local",
    });
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));

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

  test("a remote-only project with Docker builds in a container, never locally", () => {
    const remoteOnly = { ...builder, hasCheckout: false };
    remoteDocker = true;
    const onConfirm = renderDialog({
      machines: [own, remoteOnly],
      defaultEnvironmentType: "local",
    });
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));

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

  test("a picked machine that goes offline falls back to this machine", () => {
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
    fireEvent.click(within(machineGroup()).getByRole("radio", { name: /Builder/ }));
    view.rerender(dialog([own, { ...builder, available: false }]));

    const radios = within(machineGroup()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(radios[1]!.disabled).toBe(true);
    start();
    expect(onConfirm.mock.calls[0]![0].machine).toBeUndefined();
  });
});
