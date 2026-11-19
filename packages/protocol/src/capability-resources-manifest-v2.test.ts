/**
 * Lockfile format 2: one entry per package revision, setups naming the exact
 * entry, an optional signature, and format 1 still read and still written
 * whenever it suffices.
 */
import { describe, expect, test } from "bun:test";

import {
  capabilityLockSigningPayload,
  capabilityLockfileDocument,
  validateCapabilityIntent,
  validateCapabilityLockfile,
} from "./capability-resources-manifest.js";
import { capabilityPackageId } from "./capability-resources.js";

const source = { kind: "git" as const, repo: "https://github.com/team/tools", subpath: "review" };
const id = capabilityPackageId(source);
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const components = [{ id: `${id}#skill:review`, kind: "skill", pathOrKey: "review" }];

const intent = validateCapabilityIntent({
  version: 1,
  setups: {
    stable: { packages: [{ source, revision: "1111111" }] },
    edge: { packages: [{ source, revision: "2222222" }] },
  },
}).intent!;

const v2 = () => ({
  formatVersion: 2,
  generatedBy: "Orkestrator",
  packages: [
    { id, source, revision: "2222222", artifactDigest: digestB, components },
    { id, source, revision: "1111111", artifactDigest: digestA, components },
  ],
  setups: {
    stable: { packages: [{ id, artifactDigest: digestA }] },
    edge: { packages: [{ id, artifactDigest: digestB }] },
  },
});

describe("lockfile format 2", () => {
  test("two setups pin two revisions of one package", () => {
    const { lock, issues } = validateCapabilityLockfile(v2(), intent);
    expect(issues).toEqual([]);
    expect(lock?.formatVersion).toBe(2);
    expect(lock?.setups.stable?.packages).toEqual([{ packageId: id, artifactDigest: digestA }]);
    expect(lock?.setups.edge?.packages).toEqual([{ packageId: id, artifactDigest: digestB }]);
    // Written back, it is format 2 again and validates to the same value.
    const document = capabilityLockfileDocument(lock!);
    expect(document.formatVersion).toBe(2);
    expect(validateCapabilityLockfile(document, intent).lock).toEqual(lock);
  });

  test("a setup that pins a revision the lockfile does not hold is refused", () => {
    const value = v2();
    value.setups.stable.packages[0]!.artifactDigest = `sha256:${"c".repeat(64)}`;
    const text = validateCapabilityLockfile(value, intent)
      .issues.map((issue) => issue.message)
      .join("\n");
    expect(text).toContain("is not in the lockfile");
  });

  test("a setup selects one revision of each package, and an intent revision must match", () => {
    const value = v2();
    value.setups.stable.packages.push({ id, artifactDigest: digestB });
    expect(
      validateCapabilityLockfile(value, intent).issues.map((issue) => issue.message),
    ).toContain("A setup selects one revision of each package.");
    const swapped = v2();
    swapped.setups.stable.packages[0]!.artifactDigest = digestB;
    expect(
      validateCapabilityLockfile(swapped, intent).issues.map((issue) => issue.message),
    ).toContain("The selected revision differs from the lockfile.");
  });

  test("an exact duplicate entry is refused", () => {
    const value = v2();
    value.packages.push({ ...value.packages[0]! });
    expect(
      validateCapabilityLockfile(value, intent).issues.map((issue) => issue.message),
    ).toContain("The lockfile repeats a package revision.");
  });

  test("secrets and host paths are still refused", () => {
    const value = v2() as Record<string, unknown>;
    value.generatedBy = "token ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    (value.packages as Array<Record<string, unknown>>)[0]!.revision = "/home/me/checkout";
    const text = validateCapabilityLockfile(value, intent)
      .issues.map((issue) => issue.message)
      .join("\n");
    expect(text).toContain("GitHub token");
    expect(text).toContain("host path");
  });
});

describe("format 1 compatibility", () => {
  const v1 = {
    formatVersion: 1,
    generatedBy: "Orkestrator",
    packages: [{ id, source, revision: "1111111", artifactDigest: digestA, components }],
    setups: { stable: { packageIds: [id] } },
  };
  const oneSetup = validateCapabilityIntent({
    version: 1,
    setups: { stable: { packages: [{ source, revision: "1111111" }] } },
  }).intent!;

  test("format 1 is read into the per-setup references", () => {
    const { lock, issues } = validateCapabilityLockfile(v1, oneSetup);
    expect(issues).toEqual([]);
    expect(lock?.setups.stable).toEqual({
      packageIds: [id],
      packages: [{ packageId: id, artifactDigest: digestA }],
    });
  });

  test("format 1 is written whenever it suffices", () => {
    const { lock } = validateCapabilityLockfile(v1, oneSetup);
    expect(capabilityLockfileDocument(lock!)).toEqual(v1);
  });

  test("format 1 cannot repeat a package or carry a signature", () => {
    const repeated = {
      ...v1,
      packages: [...v1.packages, { ...v1.packages[0]!, artifactDigest: digestB }],
    };
    expect(
      validateCapabilityLockfile(repeated)
        .issues.map((issue) => issue.message)
        .join("\n"),
    ).toContain("format version 1 holds one revision per package");
    const signed = {
      ...v1,
      signature: {
        algorithm: "ed25519",
        keyId: "0".repeat(32),
        publicKey: "A".repeat(43),
        intentDigest: digestA,
        value: "B".repeat(86),
      },
    };
    expect(validateCapabilityLockfile(signed).issues.map((issue) => issue.message)).toContain(
      "Signed lockfiles use format version 2.",
    );
  });
});

describe("signature block", () => {
  const signature = {
    algorithm: "ed25519",
    keyId: "0".repeat(32),
    publicKey: "A".repeat(43),
    intentDigest: digestA,
    value: "B".repeat(86),
  };

  test("a well-formed signature is kept and its payload leaves out only the value", () => {
    const { lock, issues, signedPayload } = validateCapabilityLockfile(
      { ...v2(), signature },
      intent,
    );
    expect(issues).toEqual([]);
    expect(lock?.signature).toEqual(signature as never);
    expect(signedPayload).toContain(signature.publicKey);
    expect(signedPayload).toContain(signature.intentDigest);
    expect(signedPayload).not.toContain(signature.value);
    expect(signedPayload).toBe(capabilityLockSigningPayload({ ...v2(), signature }));
  });

  test("a malformed signature is reported", () => {
    const { issues } = validateCapabilityLockfile(
      { ...v2(), signature: { ...signature, publicKey: "/home/me/key" } },
      intent,
    );
    expect(issues.map((issue) => issue.message)).toContain("The signature is malformed.");
  });
});
