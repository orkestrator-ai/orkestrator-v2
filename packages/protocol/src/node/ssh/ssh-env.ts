import path from "node:path";
import type { SshAdapterContext } from "./context.js";

/** Non-interactive environment: no askpass, so ssh can never prompt (SH-03). */
export function nonInteractiveSshEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, SSH_ASKPASS_REQUIRE: "never" };
  delete next.SSH_ASKPASS;
  delete next.ORKESTRATOR_ASKPASS_SOCKET;
  delete next.ORKESTRATOR_ASKPASS_NONCE;
  return next;
}

/** A fresh 0700 directory under the context's temp root. */
export async function createPrivateTempDir(
  context: SshAdapterContext,
  prefix: string,
): Promise<string> {
  const dir = await context.fs.mkdtemp(path.join(context.tmpdir, prefix));
  await context.fs.chmod(dir, 0o700);
  return dir;
}
