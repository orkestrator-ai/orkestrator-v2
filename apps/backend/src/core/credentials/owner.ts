import { isRecordedProcessAlive, processStartIdentity } from "../process-identity.js";

/** A process identity that remains valid if a different backend wins the writer lease. */
export interface CredentialProcessOwner {
  pid: number;
  start: string | null;
}

let processStart: string | null | undefined;

export function currentCredentialOwner(): CredentialProcessOwner {
  if (processStart === undefined) processStart = processStartIdentity(process.pid);
  return { pid: process.pid, start: processStart };
}

/** Pre-owner records are leftovers from a backend that cannot publish liveness. */
export function credentialOwnerAlive(owner: CredentialProcessOwner | undefined): boolean {
  if (!owner) return false;
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return true;
  if (owner.pid === process.pid) {
    const { start } = currentCredentialOwner();
    return !owner.start || !start || owner.start === start;
  }
  return isRecordedProcessAlive(owner.pid, owner.start);
}
