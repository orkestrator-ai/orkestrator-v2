/**
 * Ed25519 public keys (raw 32 bytes, base64) trusted to sign
 * `release-requirements.json`. While this list is empty, updates run in
 * checksum-only mode: the manifest is verified against the SHA-256 published
 * in the channel index. Once a key is listed here, every target manifest must
 * carry a valid signature from one of them; there is deliberately no
 * "verify if present" mode, because stripping the signature would bypass it.
 *
 * Adding the first key is a one-way door for the installs that ship it; see
 * "Integrity" in docs/architecture/release-channels-and-updates.md. List the
 * active and a standby key so a rotation never strands an install.
 */
export const RELEASE_SIGNING_PUBLIC_KEYS: readonly string[] = [];
