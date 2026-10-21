import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  parseFingerprintOutput,
  parseKnownHostsLines,
  trustHostKey,
} from "@orkestrator/protocol/node/ssh/host-trust";
import { SshTunnelError } from "@orkestrator/protocol/node/ssh/tunnel-failures";
import { SshTunnelSupervisor } from "@orkestrator/protocol/node/ssh/tunnel-supervisor";
import { createFakeHarness, FAST_TIMINGS, ROUTE, type FakeChild, type FakeHarness } from "./fakes";

const KEY_LINE = "[10.0.0.2]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKtxW6examplekeymaterial0";
const harnesses: FakeHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function probeTarget(child: FakeChild): string {
  const value = child.args.find((arg) => arg.startsWith("UserKnownHostsFile="))!;
  return value.slice('UserKnownHostsFile="'.length, -1);
}

function setup(options: { writesKey?: boolean; stderr?: string } = {}) {
  const harness = createFakeHarness({
    onOther: (child) => {
      setImmediate(() => {
        if (child.command.endsWith("ssh-keygen")) {
          child.writeStdout("256 SHA256:AbCdEf0123456789+/xyz [10.0.0.2]:2222 (ED25519)\n");
          child.exit(0);
          return;
        }
        if (options.writesKey !== false) writeFileSync(probeTarget(child), `${KEY_LINE}\n`);
        child.writeStderr(options.stderr ?? "alice@10.0.0.2: Permission denied (publickey).\n");
        child.exit(255);
      });
    },
  });
  harnesses.push(harness);
  const supervisor = new SshTunnelSupervisor({ context: harness.context, timings: FAST_TIMINGS });
  return { harness, supervisor };
}

describe("host-key probe and trust (SH-02)", () => {
  test("captures the key without credentials and returns its fingerprint", async () => {
    const { harness, supervisor } = setup();
    const result = await supervisor.probeHostKey(ROUTE);
    expect(result.knownHostsLines).toEqual([KEY_LINE]);
    expect(result.hostPatterns).toEqual(["[10.0.0.2]:2222"]);
    expect(result.fingerprints).toEqual([
      { bits: 256, fingerprint: "SHA256:AbCdEf0123456789+/xyz", keyType: "ED25519" },
    ]);
    const [probe] = harness.children;
    expect(probe!.args).toContain("PreferredAuthentications=none");
    expect(probe!.env.SSH_ASKPASS).toBeUndefined();
    // The private probe directory is removed afterwards.
    expect(readdirSync(harness.tmpdir).filter((name) => name.startsWith("ork-ssh-probe-"))).toEqual(
      [],
    );
  });

  test("appends exactly the probed lines to the owned known_hosts with private modes", async () => {
    const { harness, supervisor } = setup();
    const result = await supervisor.probeHostKey(ROUTE);
    expect(await supervisor.trustHostKey(result)).toEqual({ added: 1 });
    expect(readFileSync(harness.knownHostsFile, "utf8")).toBe(`${KEY_LINE}\n`);
    expect(statSync(harness.knownHostsFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(harness.knownHostsFile)).mode & 0o777).toBe(0o700);

    // A second approval of the same key does not duplicate it.
    const again = await supervisor.probeHostKey(ROUTE);
    expect(await supervisor.trustHostKey(again)).toEqual({ added: 0 });
    expect(readFileSync(harness.knownHostsFile, "utf8")).toBe(`${KEY_LINE}\n`);
  });

  test("only probes the supervisor issued can be trusted, once", async () => {
    const { supervisor } = setup();
    const forged = supervisor.trustHostKey({ probeId: "forged" });
    await expect(forged).rejects.toBeInstanceOf(SshTunnelError);
    const result = await supervisor.probeHostKey(ROUTE);
    await supervisor.trustHostKey(result);
    await expect(supervisor.trustHostKey(result)).rejects.toBeInstanceOf(SshTunnelError);
  });

  test("an unreachable host reports connect-failed, not a trust prompt", async () => {
    const { supervisor } = setup({
      writesKey: false,
      stderr: "ssh: connect to host 10.0.0.2 port 2222: Connection refused\n",
    });
    const error = await supervisor.probeHostKey(ROUTE).catch((caught: unknown) => caught);
    expect((error as SshTunnelError).code).toBe("connect-failed");
  });

  test("known_hosts parsing refuses markers, comments and malformed lines", () => {
    expect(
      parseKnownHostsLines(
        [
          "# comment",
          "@cert-authority * ssh-ed25519 AAAA",
          "@revoked host ssh-ed25519 AAAA",
          "host ssh-ed25519 AAAA trailing-comment",
          "host ssh-ed25519 not base64!",
          KEY_LINE,
          KEY_LINE,
        ].join("\n"),
      ),
    ).toEqual([KEY_LINE]);
  });

  test("fingerprint parsing", () => {
    expect(parseFingerprintOutput("3072 SHA256:abc/+= h (RSA)\njunk\n")).toEqual([
      { bits: 3072, fingerprint: "SHA256:abc/+=", keyType: "RSA" },
    ]);
  });
});

test("a caught known_hosts write rejection releases the queue without a discarded rejection", async () => {
  const { harness } = setup();
  const original = harness.context.fs.writeFile;
  let fail = true;
  harness.context.fs.writeFile = async (...args) => {
    if (fail) throw Object.assign(new Error("write failed"), { code: "EIO" });
    return original(...args);
  };
  await expect(trustHostKey(harness.context, { knownHostsLines: [KEY_LINE] })).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fail = false;
  expect(await trustHostKey(harness.context, { knownHostsLines: [KEY_LINE] })).toEqual({
    added: 1,
  });
});
