import path from "node:path";
import { createProcessOwnerLock } from "@orkestrator/protocol/node/process-owner-lock";

// The desktop gives up its Electron instance lock when it exits. Its backend
// can still be draining, so the backend owns this separate lock until exit.
export async function acquireDesktopBackendOwnership(dataDir: string): Promise<void> {
  const tryLock = createProcessOwnerLock(path.join(dataDir, "desktop-backend"), "owner");
  const deadline = performance.now() + 20_000;
  do {
    const release = tryLock();
    if (release) {
      process.once("exit", release);
      return;
    }
    await Bun.sleep(100);
  } while (performance.now() < deadline);
  throw new Error("The previous desktop backend still owns this data directory");
}
