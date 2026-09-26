import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BACKEND_INSTANCE_DESCRIPTOR_FILE,
  BACKEND_INSTANCE_DESCRIPTOR_TYPE,
  parseBackendInstanceDescriptor,
  type BackendInstanceDescriptor,
} from "@orkestrator/protocol/backend-instance";

export function instanceDescriptorPath(dataDir: string): string {
  return path.join(dataDir, BACKEND_INSTANCE_DESCRIPTOR_FILE);
}

/**
 * Publish the running backend's instance descriptor: mode 0600, written to a
 * temporary file and renamed into place so a reader never sees a partial
 * document. It names the endpoint and the credential *file*, never the
 * credential. Returns a remover that deletes the descriptor only while it
 * still describes this generation, so a newer backend's descriptor survives
 * an older process's late shutdown.
 */
export async function publishInstanceDescriptor(
  descriptor: Omit<BackendInstanceDescriptor, "version" | "type">,
): Promise<() => Promise<void>> {
  const value: BackendInstanceDescriptor = {
    version: 1,
    type: BACKEND_INSTANCE_DESCRIPTOR_TYPE,
    ...descriptor,
  };
  // Validate what we publish with the same parser clients use.
  parseBackendInstanceDescriptor(value);
  const file = instanceDescriptorPath(descriptor.dataDir);
  const temporary = path.join(
    descriptor.dataDir,
    `.${BACKEND_INSTANCE_DESCRIPTOR_FILE}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return async () => {
    try {
      const current = parseBackendInstanceDescriptor(JSON.parse(await fs.readFile(file, "utf8")));
      if (current.generation !== value.generation) return;
      await fs.rm(file, { force: true });
    } catch {
      // Absent or replaced: nothing of ours to remove.
    }
  };
}
