import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  decodeGraphBase64Url,
  encodeGraphBase64Url,
  graphSharingKeyId,
  graphSharingPublicKeyBytes,
} from "@orkestrator/protocol/graphs/sharing";

/**
 * Ed25519 signing for share bundles (item 405). Keys are kept as raw
 * base64url strings (the JWK `x` and `d` members). Nothing here logs a key, a
 * payload or a signature.
 */

export interface GraphSharingKeyPair {
  publicKey: string;
  privateKey: string;
  keyId: string;
  createdAt: string;
}

/** A fresh installation key. */
export function generateGraphSharingKeyPair(now: Date): GraphSharingKeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("The platform did not export an Ed25519 key");
  }
  return {
    publicKey: jwk.x,
    privateKey: jwk.d,
    keyId: graphSharingKeyId(jwk.x),
    createdAt: now.toISOString(),
  };
}

/** The base64url Ed25519 signature of `payload` (UTF-8). */
export function signGraphBundlePayload(
  key: Pick<GraphSharingKeyPair, "publicKey" | "privateKey">,
  payload: string,
): string {
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: key.publicKey, d: key.privateKey },
    format: "jwk",
  });
  return encodeGraphBase64Url(new Uint8Array(sign(null, Buffer.from(payload, "utf8"), privateKey)));
}

/** Whether `signature` is `publicKey`'s Ed25519 signature of `payload`. Never throws. */
export function verifyGraphBundleSignature(
  publicKey: string,
  payload: string,
  signature: string,
): boolean {
  const signatureBytes = decodeGraphBase64Url(signature);
  if (!graphSharingPublicKeyBytes(publicKey) || !signatureBytes || signatureBytes.length !== 64) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk",
    });
    return verify(null, Buffer.from(payload, "utf8"), key, signatureBytes);
  } catch {
    return false;
  }
}
