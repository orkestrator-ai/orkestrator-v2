/**
 * Signed team manifests (docs/architecture/agent-capabilities-management.md,
 * "Portable manifests").
 *
 * An export may be signed with this installation's graph-sharing Ed25519 key
 * (`graph-template-signing.ts`, item 405), and an import checks the signature
 * against the same trusted-key list graph bundles use, so one trust model
 * covers both. The signature covers the lockfile as written (format 2) and
 * the digest of the validated intent, so neither file can be edited without
 * invalidating it. Signature data is public: the key, its id, the intent
 * digest and the signature; never a private key, a secret or a host path.
 */
import { createHash } from "node:crypto";

import {
  capabilityLockSigningPayload,
  capabilityLockfileDocument,
  type CapabilityIntent,
  type CapabilityLockfile,
  type CapabilityManifestIssue,
} from "@orkestrator/protocol/capability-resources-manifest";
import { canonicalCapabilityJson } from "@orkestrator/protocol/capability-resources-resolve";
import {
  graphSharingFingerprint,
  graphSharingKeyId,
  graphSharingPublicKeyBytes,
} from "@orkestrator/protocol/graphs/sharing";

import { signGraphBundlePayload, verifyGraphBundleSignature } from "../graph-template-signing.js";

/** This installation's sharing keys, as the capability service sees them. */
export interface ManifestSigningKeys {
  /** The installation key; created on first use when `create` is set. */
  installationKey(create: boolean): { publicKey: string; privateKey: string; keyId: string } | null;
  /** Keys this installation trusts (the graph-sharing trusted keys). */
  trusted(): Array<{ keyId: string; publicKey: string; label: string }>;
}

export type ManifestSignatureStatus = "unsigned" | "trusted" | "untrusted" | "invalid";

export interface ManifestSignatureCheck {
  status: ManifestSignatureStatus;
  keyId?: string;
  /** The signer's public key, so the preview can offer to trust it. */
  publicKey?: string;
  fingerprint?: string;
  /** The trusted key's label, or "This installation". */
  label?: string;
  own?: boolean;
  reason?: string;
}

/** `sha256:<hex>` of the validated intent's canonical JSON. */
export function capabilityIntentDigest(intent: CapabilityIntent): string {
  return `sha256:${createHash("sha256").update(canonicalCapabilityJson(intent)).digest("hex")}`;
}

/** Returns `lock` signed with `key` (format 2 is implied by the signature). */
export function signCapabilityLockfile(
  lock: CapabilityLockfile,
  intent: CapabilityIntent,
  key: { publicKey: string; privateKey: string; keyId: string },
): CapabilityLockfile {
  const unsigned: CapabilityLockfile = {
    ...lock,
    formatVersion: 2,
    signature: {
      algorithm: "ed25519",
      keyId: key.keyId,
      publicKey: key.publicKey,
      intentDigest: capabilityIntentDigest(intent),
      value: "",
    },
  };
  const payload = capabilityLockSigningPayload(capabilityLockfileDocument(unsigned));
  return {
    ...unsigned,
    signature: { ...unsigned.signature!, value: signGraphBundlePayload(key, payload) },
  };
}

/**
 * Checks a parsed lockfile's signature. `signedPayload` is what the
 * validator computed from the lockfile as read; `intent` is the validated
 * intent read beside it.
 */
export function verifyCapabilityLockSignature(
  lock: CapabilityLockfile,
  signedPayload: string | undefined,
  intent: CapabilityIntent,
  keys: ManifestSigningKeys | undefined,
): ManifestSignatureCheck {
  const signature = lock.signature;
  if (!signature || !signedPayload) return { status: "unsigned" };
  const identity = {
    keyId: signature.keyId,
    publicKey: signature.publicKey,
    fingerprint: graphSharingFingerprint(signature.keyId),
  };
  if (
    !graphSharingPublicKeyBytes(signature.publicKey) ||
    graphSharingKeyId(signature.publicKey) !== signature.keyId
  ) {
    return { status: "invalid", ...identity, reason: "The key id does not match the key." };
  }
  if (signature.intentDigest !== capabilityIntentDigest(intent)) {
    return {
      status: "invalid",
      ...identity,
      reason: "The manifest was changed after it was signed.",
    };
  }
  if (!verifyGraphBundleSignature(signature.publicKey, signedPayload, signature.value)) {
    return {
      status: "invalid",
      ...identity,
      reason: "The lockfile was changed after it was signed.",
    };
  }
  const own = keys?.installationKey(false)?.publicKey === signature.publicKey;
  if (own) return { status: "trusted", ...identity, label: "This installation", own: true };
  const trusted = keys
    ?.trusted()
    .find((entry) => entry.keyId === signature.keyId && entry.publicKey === signature.publicKey);
  if (trusted) return { status: "trusted", ...identity, label: trusted.label };
  return {
    status: "untrusted",
    ...identity,
    reason: "Signed by a key this installation does not trust.",
  };
}

/**
 * What a signature check means for an import: an invalid signature always
 * blocks it; an unsigned or untrusted one blocks it only when the policy
 * requires signed manifests.
 */
export function manifestSignatureIssues(
  check: ManifestSignatureCheck,
  requireSigned: boolean,
): CapabilityManifestIssue[] {
  if (check.status === "invalid") {
    return [
      {
        path: "$.signature",
        message: `The signature is invalid: ${check.reason ?? "it does not verify"}. Nothing was imported.`,
      },
    ];
  }
  if (requireSigned && check.status === "unsigned") {
    return [
      {
        path: "$.signature",
        message:
          "This installation requires manifests signed by a trusted key; the lockfile is not signed.",
      },
    ];
  }
  if (requireSigned && check.status === "untrusted") {
    return [
      {
        path: "$.signature",
        message: `This installation requires manifests signed by a trusted key; key ${check.fingerprint ?? check.keyId ?? ""} is not trusted. Check its fingerprint with the sender, then trust the key.`,
      },
    ];
  }
  return [];
}
