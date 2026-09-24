/** Test-only PKI: a throwaway CA and a leaf for private preview hosts. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const TEST_PREVIEW_DOMAIN = "preview.test";

export function certificates(
  dir: string,
  names = [`*.${TEST_PREVIEW_DOMAIN}`, `bootstrap.${TEST_PREVIEW_DOMAIN}`],
) {
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=Orkestrator Test CA",
  );
  run(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
    "-subj",
    `/CN=${names[0]}`,
  );
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
    "2",
    "-extfile",
    "leaf.ext",
  );
}
