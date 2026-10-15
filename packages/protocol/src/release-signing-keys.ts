/**
 * Ed25519 public keys (raw 32 bytes, base64) trusted to sign
 * `release-requirements.json`. Every target manifest must carry a valid
 * signature from one of them (an empty list would mean checksum-only mode).
 * There is deliberately no "verify if present" mode, because stripping the
 * signature would bypass it.
 *
 * Listing keys is a one-way door for the installs that ship them; see
 * "Integrity" in docs/architecture/release-channels-and-updates.md. List the
 * active key (the CI secret) first, then the offline standby key, so a
 * rotation never strands an install. Generating, rotating and replacing them:
 * docs/development/releasing.md, "Manifest signing keys".
 */
export const RELEASE_SIGNING_PUBLIC_KEYS: readonly string[] = [
  // Active: the ORKESTRATOR_RELEASE_SIGNING_KEY secret signs every release.
  "uWyXurl0pyuP2SEQT55uY0uRlh5hVmulESzffUBja7w=",
  // Standby: kept offline; signs nothing until a rotation.
  "ejdkFGfN/zPjLwjYK2GHA1/6ncXTREEKit+2KUNKC2A=",
];
