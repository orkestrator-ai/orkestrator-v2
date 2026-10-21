import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BACKEND_PROFILE_CONFLICT_CODE } from "@orkestrator/protocol/backend-profile";
import { FederationProvider } from "@/components/federation/FederationProvider";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
  type InvokeCall,
} from "@/test/federation-desktop-fake";
import {
  mockToastError,
  mockToastSuccess,
  mockToastWarning,
} from "../../../../../../tests/mocks/sonner";
import { portalStore } from "@/lib/portal/portal-store";
import { MachineDetails } from "./MachineDetails";
import { SshRouteDialog } from "./SshRouteDialog";

const MACHINE_A = remoteConnection("a", "Machine A", "teal");
const MACHINE_B = remoteConnection("b", "Machine B", "rose");

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
});

async function renderMachineDetails(respond?: (call: InvokeCall) => unknown) {
  const fake = installDesktopFake({
    list: connectionList([MACHINE_A, MACHINE_B]),
    datasets: { a: sharedIdDataset("idle"), b: sharedIdDataset("idle") },
    ...(respond ? { respond } : {}),
  });
  render(
    <FederationProvider>
      <MachineDetails connection={MACHINE_A} duplicateColorWith={[]} />
    </FederationProvider>,
  );
  // Machine A is a registered node once the portal has loaded.
  await waitFor(() => expect(portalStore.getState().nodes).toHaveLength(2));
  return fake;
}

describe("CL-04: shared machine profile edits", () => {
  test("CL-04: a colour change is a compare-and-swap on the current profile revision, sent to that machine", async () => {
    const fake = await renderMachineDetails();
    const colours = screen.getByRole("radiogroup", { name: "Machine colour (shared)" });
    expect(within(colours).getByRole("radio", { name: "Teal" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(within(colours).getByRole("radio", { name: "Blue" }));

    await waitFor(() => expect(fake.callsTo("a", "update_backend_profile")).toHaveLength(1));
    expect(fake.callsTo("a", "update_backend_profile")[0]!.args).toEqual({
      expectedRevision: 3,
      colorToken: "blue",
    });
    expect(fake.callsTo("b", "update_backend_profile")).toHaveLength(0);
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
  });

  test("CL-04: a profile conflict warns and is never retried", async () => {
    const fake = await renderMachineDetails(({ command }) =>
      command === "update_backend_profile"
        ? Promise.reject(
            new Error(`[${BACKEND_PROFILE_CONFLICT_CODE}] The profile changed (revision 4).`),
          )
        : undefined,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Green" }));

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
    expect(String(mockToastWarning.mock.calls[0]![0])).toMatch(/changed on another client/);
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    // Let any stray follow-up settle before asserting nothing was resent.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fake.callsTo("a", "update_backend_profile")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.command === "update_backend_profile")).toHaveLength(1);
    // The controls are usable again (not stuck saving).
    await waitFor(() =>
      expect((screen.getByRole("radio", { name: "Green" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });
});

describe("SH-02: first-use SSH host key", () => {
  const PROBE = {
    probeId: "probe-1",
    destination: "build-machine",
    fingerprints: [{ type: "ED25519", fingerprint: "SHA256:abcDEF123fingerprint" }],
  };

  function installSsh() {
    const fake = installDesktopFake({ list: connectionList([MACHINE_A]), datasets: {} });
    const list = connectionList([MACHINE_A]);
    const connectSsh = mock(async (_input: Record<string, unknown>) => list);
    connectSsh.mockImplementationOnce(async () => {
      throw new Error(
        "Error invoking remote method 'connections:connect-ssh': Error: [host-key-unknown] The host key of build-machine is not trusted yet.",
      );
    });
    const probeSshHostKey = mock(
      async (_input: { destination: string; sshPort?: number }) => PROBE,
    );
    const trustSshHostKey = mock(async (_probeId: string) => ({ added: 1 }));
    Object.assign(window.orkestrator!.connections!, {
      connectSsh,
      probeSshHostKey,
      trustSshHostKey,
    });
    const onOpenChange = mock((_open: boolean) => undefined);
    render(<SshRouteDialog open onOpenChange={onOpenChange} />);
    return { fake, connectSsh, probeSshHostKey, trustSshHostKey, onOpenChange };
  }

  async function submitForm() {
    fireEvent.change(screen.getByLabelText("SSH destination or alias"), {
      target: { value: "build-machine" },
    });
    fireEvent.change(screen.getByLabelText("Gateway token"), { target: { value: "tok-123" } });
    fireEvent.submit(screen.getByLabelText("SSH destination or alias").closest("form")!);
    return screen.findByText("Verify the SSH host key");
  }

  test("SH-02: an unknown host key is probed and shown, and trusted only on explicit approval", async () => {
    const { connectSsh, probeSshHostKey, trustSshHostKey, onOpenChange } = installSsh();
    await submitForm();

    expect(connectSsh).toHaveBeenCalledTimes(1);
    expect(connectSsh.mock.calls[0]![0]).toMatchObject({
      destination: "build-machine",
      remoteGatewayPort: 34125,
      token: "tok-123",
    });
    expect(probeSshHostKey).toHaveBeenCalledWith({ destination: "build-machine" });
    expect(screen.getByText("ED25519 SHA256:abcDEF123fingerprint")).toBeTruthy();
    expect(trustSshHostKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Trust and connect" }));

    await waitFor(() => expect(connectSsh).toHaveBeenCalledTimes(2));
    expect(trustSshHostKey).toHaveBeenCalledTimes(1);
    expect(trustSshHostKey).toHaveBeenCalledWith("probe-1");
    expect(trustSshHostKey.mock.invocationCallOrder[0]!).toBeLessThan(
      connectSsh.mock.invocationCallOrder[1]!,
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test("SH-02: declining the host key never trusts it or reconnects", async () => {
    const { connectSsh, trustSshHostKey, onOpenChange } = installSsh();
    await submitForm();

    fireEvent.click(screen.getByRole("button", { name: "Don’t trust" }));

    await waitFor(() => expect(screen.queryByText("Verify the SSH host key") === null).toBe(true));
    expect(screen.getByLabelText("SSH destination or alias")).toBeTruthy();
    expect(trustSshHostKey).not.toHaveBeenCalled();
    expect(connectSsh).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
