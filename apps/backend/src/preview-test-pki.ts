/** Test-only PKI: a throwaway CA and a leaf for private preview hosts. */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TEST_PREVIEW_DOMAIN = "preview.test";

export interface CertificateOptions {
  /** Validity of the CA and the leaf; a different value yields a different `validTo`. */
  days?: number;
}

// RSA-2048 key generation dominates the cost of issuing a throwaway PKI, and a
// key pair says nothing about what a test checks, so each process makes one CA
// and one leaf key and reuses them for every issuance.
let sharedKeys: { ca: string; leaf: string } | undefined;

function rsaKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

export function certificates(
  dir: string,
  names = [`*.${TEST_PREVIEW_DOMAIN}`, `bootstrap.${TEST_PREVIEW_DOMAIN}`],
  options: CertificateOptions = {},
) {
  const days = String(options.days ?? 2);
  sharedKeys ??= { ca: rsaKeyPem(), leaf: rsaKeyPem() };
  // A key file a watcher may be reading is left alone rather than truncated and rewritten.
  if (!existsSync(join(dir, "ca.key"))) writeFileSync(join(dir, "ca.key"), sharedKeys.ca);
  if (!existsSync(join(dir, "leaf.key"))) writeFileSync(join(dir, "leaf.key"), sharedKeys.leaf);
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run(
    "req",
    "-x509",
    "-key",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    days,
    "-subj",
    "/CN=Orkestrator Test CA",
  );
  run("req", "-new", "-key", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${names[0]}`);
  const ext = join(dir, "leaf.ext");
  execFileSync("sh", [
    "-c",
    `printf 'subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}\\n' > ${ext}`,
  ]);
  run(
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "leaf.pem",
    "-days",
    days,
    "-extfile",
    "leaf.ext",
  );
}
