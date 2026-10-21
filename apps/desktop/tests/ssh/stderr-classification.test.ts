import { describe, expect, test } from "bun:test";
import {
  classifySshStderr,
  redactSshDiagnostic,
} from "@orkestrator/protocol/node/ssh/stderr-classification";
import {
  SSH_TUNNEL_FAILURE_CODES,
  SshTunnelError,
  isRetryableTunnelFailure,
  tunnelFailure,
} from "@orkestrator/protocol/node/ssh/tunnel-failures";

const CHANGED = `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
Offending ED25519 key in /Users/alice/Library/Application Support/o/ssh/known_hosts:1
Host key for [127.0.0.1]:42231 has changed and you have requested strict checking.
Host key verification failed.`;

describe("classifySshStderr", () => {
  const table: Array<[string, string, boolean, string]> = [
    ["host-key-changed", CHANGED, false, "host-key-changed"],
    [
      "host-key-unknown",
      "No ED25519 host key is known for [127.0.0.1]:42231 and you have requested strict checking.\nHost key verification failed.",
      false,
      "host-key-unknown",
    ],
    ["bare verification failure", "Host key verification failed.", false, "host-key-unknown"],
    [
      "forwarding-denied",
      "channel 1: open failed: administratively prohibited: open failed",
      false,
      "forwarding-denied",
    ],
    [
      "port collision",
      "bind [127.0.0.1]:42240: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 42240\nCould not request local forwarding.",
      false,
      "port-collision",
    ],
    [
      "unattended permission denied",
      "alice@10.0.0.2: Permission denied (publickey).",
      false,
      "authentication-required",
    ],
    [
      "interactive permission denied",
      "alice@10.0.0.2: Permission denied (publickey,password).",
      true,
      "authentication-failed",
    ],
    [
      "too many failures",
      "Received disconnect from 10.0.0.2 port 22:2: Too many authentication failures",
      true,
      "authentication-failed",
    ],
    [
      "DNS",
      "ssh: Could not resolve hostname nowhere.invalid: nodename nor servname provided, or not known",
      false,
      "connect-failed",
    ],
    [
      "refused",
      "ssh: connect to host 10.0.0.2 port 22: Connection refused",
      false,
      "connect-failed",
    ],
    [
      "timeout",
      "ssh: connect to host 10.0.0.2 port 22: Operation timed out",
      false,
      "connect-failed",
    ],
    ["keepalive", "Timeout, server 10.0.0.2 not responding.", false, "connect-failed"],
    ["remote closed", "Connection to 10.0.0.2 closed by remote host.", false, "connect-failed"],
  ];
  for (const [name, stderr, interactive, code] of table) {
    test(name, () => {
      expect(classifySshStderr(stderr, { interactive })?.code).toBe(code as never);
    });
  }

  test("a cancelled prompt maps denial to authentication-required", () => {
    expect(
      classifySshStderr("Permission denied (publickey).", {
        interactive: true,
        promptCancelled: true,
      })?.code,
    ).toBe("authentication-required");
  });

  test("a closed remote gateway port on a channel is not a tunnel failure (SH-06)", () => {
    expect(
      classifySshStderr(
        'Authenticated to h ([127.0.0.1]:22) using "publickey".\nchannel 2: open failed: connect failed: Connection refused',
        { interactive: false },
      ),
    ).toBeNull();
  });

  test("trust outranks transport noise", () => {
    expect(
      classifySshStderr(`Connection closed by 10.0.0.2 port 22\n${CHANGED}`, {
        interactive: false,
      })?.code,
    ).toBe("host-key-changed");
  });
});

describe("redactSshDiagnostic", () => {
  test("removes usernames, paths and quoted values", () => {
    const text = redactSshDiagnostic(
      "Offending key in /Users/alice/.ssh/known_hosts:3 for alice@build ('~/.ssh/id_x')",
      ["alice"],
    );
    expect(text).not.toContain("alice");
    expect(text).not.toContain("/Users");
    expect(text).not.toContain(".ssh");
    expect(text).toContain("<path>");
  });

  test("bounds the result", () => {
    expect(redactSshDiagnostic("x".repeat(5_000)).length).toBeLessThanOrEqual(240);
  });
});

describe("failure retryability", () => {
  test("only transport failures are retryable", () => {
    const retryable = SSH_TUNNEL_FAILURE_CODES.filter(isRetryableTunnelFailure);
    expect([...retryable].sort()).toEqual([
      "connect-failed",
      "port-collision-exhausted",
      "tunnel-exited",
    ]);
  });

  test("an exit caused by a trust or auth problem is not retryable", () => {
    expect(tunnelFailure("tunnel-exited", { cause: "connect-failed" }).retryable).toBe(true);
    expect(tunnelFailure("tunnel-exited", { cause: "host-key-changed" }).retryable).toBe(false);
  });

  test("SshTunnelError carries code, retryability and detail", () => {
    const error = SshTunnelError.of("connect-failed", { detail: "ssh: connect: refused" });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("connect-failed");
    expect(error.retryable).toBe(true);
    expect(error.detail).toBe("ssh: connect: refused");
  });
});
