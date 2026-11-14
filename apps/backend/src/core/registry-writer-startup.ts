import type { RegistryWriter, RegistryWriterLeaseOptions } from "./registry-writer-lease.js";

export interface RegistryWriterStartupHooks {
  /**
   * Writer-only startup work (settling operations a previous process left
   * unresolved, sweeping leftovers), done with `writer`, the lease to write with.
   */
  runWriterStartupWork: (writer: RegistryWriter) => Promise<void>;
  /** Lets the schedules settings reread whether this backend is the writer. */
  announceSchedulerStatus: () => void;
}

export interface RegistryWriterStartup {
  /** Options for `openRegistryWriter`. */
  leaseOptions: RegistryWriterLeaseOptions;
  /**
   * The startup path: runs the writer-only work when `writer` is held, unless
   * a lease won late already ran it or is running it now.
   */
  runIfHeld: (writer: RegistryWriter) => Promise<void>;
}

/**
 * How one backend start wires the registry writer lease. The writer-only
 * startup work runs exactly once per start, whichever path gets there first:
 * the startup path, when the lease was won at startup, or the late path, with
 * the won lease, when a backend that found it busy wins it later
 * (`ReclaimingRegistryWriter`). A late win can settle between opening the
 * writer and the startup path's held check, and must not run the work twice.
 * Schedules are announced on a loss and once a late-won lease is exposed.
 */
export function registryWriterStartup(hooks: RegistryWriterStartupHooks): RegistryWriterStartup {
  let started = false;
  const runOnce = async (writer: RegistryWriter): Promise<void> => {
    if (started) return;
    started = true;
    await hooks.runWriterStartupWork(writer);
  };
  return {
    leaseOptions: {
      onLost: () => hooks.announceSchedulerStatus(),
      recoverLate: (lease) => runOnce(lease),
      onAcquired: () => hooks.announceSchedulerStatus(),
    },
    runIfHeld: async (writer) => {
      if (writer.isHeld()) await runOnce(writer);
    },
  };
}
