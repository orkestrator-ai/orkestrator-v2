import { toast } from "sonner";
import type { AutoMergeHold } from "@/lib/pr-merge-readiness";

/** `useAutoMergeToggle().set`: resolves to whether auto-merge is on, or null when not saved. */
type SetAutoMerge = (next: boolean, cleanupAfterMerge?: boolean) => Promise<boolean | null>;

/**
 * The Merge PR dialog's Auto-merge & Cleanup, shared by the action bar and the
 * ticket view: arms the backend's auto-merge with cleanup and says what it
 * will wait for when that needs someone to act (a non-transient hold). A save
 * that fails, is refused, or does not persist the cleanup choice has already
 * been reported by `set`, so it gets no success toast. Resolves to whether
 * Auto-merge & Cleanup is on afterwards.
 */
export async function armAutoMergeCleanup(
  environmentId: string,
  set: SetAutoMerge,
  hold: AutoMergeHold | null,
): Promise<boolean> {
  const on = await set(true, true);
  if (on !== true) return false;
  if (hold && !hold.transient) {
    toast.warning("Auto-merge & Cleanup is on", {
      description: `Waiting: ${hold.message}`,
      id: `auto-merge-cleanup-${environmentId}`,
    });
  } else {
    toast.success("Auto-merge & Cleanup is on", {
      description: "Merges when ready and resolves conflicts, then deletes this environment.",
      id: `auto-merge-cleanup-${environmentId}`,
    });
  }
  return true;
}
