import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";
import type { CapabilityLibrary } from "@orkestrator/protocol/capability-resources-api";

export function cursorSkillNames(reply: string, prefix: string): string[] | null {
  const text = reply.trim();
  if (text === "NONE") return [];
  const names = text.split(/\r?\n/);
  return names.every((name) => name.startsWith(prefix) && /^[a-z0-9-]+$/.test(name)) ? names : null;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** After partial completion the setup may already be updated; retry delivery via reconcile. */
export async function retryCursorSkillRemoval(
  call: Invoke,
  apply: (change: Record<string, unknown>) => Promise<{ state: string }>,
  packageId: string,
  skillExists: () => boolean,
): Promise<{ state: string; assigned: boolean | null; copyRemaining: boolean }> {
  const assigned = async () =>
    (await call<CapabilityLibrary>("list_capability_packages")).packages.some(
      (pkg) => pkg.id === packageId && pkg.assignedSetupIds.includes(MY_SETUP_ID),
    );
  let state = "failed";
  try {
    state = (
      await apply(
        (await assigned()) ? { kind: "remove-from-setup", packageId } : { kind: "reconcile" },
      )
    ).state;
  } catch {
    // Report what is still present, even if the retry itself failed.
  }
  return { state, assigned: await assigned().catch(() => null), copyRemaining: skillExists() };
}
