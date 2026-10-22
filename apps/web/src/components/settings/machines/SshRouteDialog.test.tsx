import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { SshRouteDialog } from "./SshRouteDialog";

const MACHINE_A = remoteConnection("a", "Machine A", "teal");

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
});

describe("SH-02: first-use SSH host key", () => {
  const PROBE = {
    probeId: "probe-1",
    destination: "build-machine",
    fingerprints: [{ type: "ED25519", fingerprint: "SHA256:abcDEF123fingerprint" }],
  };

  function installSsh() {
    installDesktopFake({ list: connectionList([MACHINE_A]), datasets: {} });
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
    return { connectSsh, probeSshHostKey, trustSshHostKey, onOpenChange };
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
