/**
 * Signed team manifests: a lockfile signed with the installation's sharing
 * key verifies as trusted (own or trusted key), untrusted (valid, unknown
 * key) or invalid (any edit to either file, or a swapped key).
 */
import { describe, expect, test } from "bun:test";

import {
  capabilityLockfileDocument,
  validateCapabilityIntent,
  validateCapabilityLockfile,
  type CapabilityLockfile,
} from "@orkestrator/protocol/capability-resources-manifest";
import { capabilityPackageId } from "@orkestrator/protocol/capability-resources";

import {
  manifestSignatureIssues,
  signCapabilityLockfile,
  verifyCapabilityLockSignature,
  type ManifestSigningKeys,
} from "./manifest-signing.js";
import { registryKey } from "./registry-test-support.js";

const source = { kind: "registry" as const, registryId: "team", qualifiedId: "team/review" };
const id = capabilityPackageId(source);
const intent = validateCapabilityIntent({
  version: 1,
  setups: { review: { packages: [{ source, revision: "1.0.0" }] } },
}).intent!;
const lock: CapabilityLockfile = {
  formatVersion: 1,
  generatedBy: "Orkestrator",
  packages: [
    {
      id,
      source,
      revision: "1.0.0",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      components: [{ id: `${id}#skill:review`, kind: "skill", pathOrKey: "review" }],
    },
  ],
  setups: {
    review: {
      packageIds: [id],
      packages: [{ packageId: id, artifactDigest: `sha256:${"a".repeat(64)}` }],
    },
  },
};

const keysOf = (
  own: ReturnType<typeof registryKey> | null,
  trusted: ReturnType<typeof registryKey>[] = [],
): ManifestSigningKeys => ({
  installationKey: () => own,
  trusted: () =>
    trusted.map((key) => ({ keyId: key.keyId, publicKey: key.publicKey, label: "Alice" })),
});

/** Signs, writes the text and reads it back as an import would. */
function roundTrip(edit: (document: Record<string, unknown>) => void = () => undefined) {
  const signer = registryKey();
  const signed = signCapabilityLockfile(lock, intent, signer);
  const document = JSON.parse(JSON.stringify(capabilityLockfileDocument(signed)));
  edit(document);
  const parsed = validateCapabilityLockfile(document, intent);
  return { signer, parsed, document };
}

describe("signed lockfiles", () => {
  test("a signature makes the lockfile format 2 and carries only public data", () => {
    const { parsed, document, signer } = roundTrip();
    expect(document.formatVersion).toBe(2);
    expect(parsed.issues).toEqual([]);
    const text = JSON.stringify(document);
    expect(text).not.toContain(signer.privateKey);
    expect(Object.keys(document.signature as object).sort()).toEqual([
      "algorithm",
      "intentDigest",
      "keyId",
      "publicKey",
      "value",
    ]);
  });

  test("own and trusted keys verify as trusted; an unknown key as untrusted", () => {
    const { parsed, signer } = roundTrip();
    const check = (keys: ManifestSigningKeys) =>
      verifyCapabilityLockSignature(parsed.lock!, parsed.signedPayload, intent, keys);
    expect(check(keysOf(signer))).toMatchObject({ status: "trusted", own: true });
    expect(check(keysOf(null, [signer]))).toMatchObject({ status: "trusted", label: "Alice" });
    const untrusted = check(keysOf(registryKey()));
    expect(untrusted.status).toBe("untrusted");
    expect(untrusted.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
  });

  test("an edited lockfile, an edited intent or a swapped key is invalid", () => {
    const tampered = roundTrip((document) => {
      (document.packages as Array<Record<string, unknown>>)[0]!.revision = "1.0.1";
    });
    expect(
      verifyCapabilityLockSignature(
        tampered.parsed.lock!,
        tampered.parsed.signedPayload,
        intent,
        keysOf(tampered.signer),
      ),
    ).toMatchObject({ status: "invalid", reason: "The lockfile was changed after it was signed." });

    const { parsed, signer } = roundTrip();
    const editedIntent = validateCapabilityIntent({
      version: 1,
      setups: { review: { packages: [{ source, revision: "1.0.0" }], providers: ["claude"] } },
    }).intent!;
    expect(
      verifyCapabilityLockSignature(
        parsed.lock!,
        parsed.signedPayload,
        editedIntent,
        keysOf(signer),
      ).status,
    ).toBe("invalid");

    const other = registryKey();
    const swapped = roundTrip((document) => {
      const signature = document.signature as Record<string, unknown>;
      signature.publicKey = other.publicKey;
      signature.keyId = other.keyId;
    });
    expect(
      verifyCapabilityLockSignature(
        swapped.parsed.lock!,
        swapped.parsed.signedPayload,
        intent,
        keysOf(null, [other]),
      ).status,
    ).toBe("invalid");
  });

  test("an unsigned lockfile is unsigned", () => {
    const parsed = validateCapabilityLockfile(capabilityLockfileDocument(lock), intent);
    expect(
      verifyCapabilityLockSignature(parsed.lock!, parsed.signedPayload, intent, keysOf(null))
        .status,
    ).toBe("unsigned");
  });

  test("the policy blocks unsigned and untrusted; an invalid signature always blocks", () => {
    expect(manifestSignatureIssues({ status: "invalid", reason: "x" }, false)).toHaveLength(1);
    expect(manifestSignatureIssues({ status: "unsigned" }, false)).toEqual([]);
    expect(manifestSignatureIssues({ status: "untrusted" }, false)).toEqual([]);
    expect(manifestSignatureIssues({ status: "unsigned" }, true)[0]?.message).toContain(
      "not signed",
    );
    expect(
      manifestSignatureIssues({ status: "untrusted", fingerprint: "ab12" }, true)[0]?.message,
    ).toContain("ab12 is not trusted");
    expect(manifestSignatureIssues({ status: "trusted" }, true)).toEqual([]);
  });
});
