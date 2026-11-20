import type {
  CapabilityTargetStatus,
  CapabilityVerificationLevel,
} from "@orkestrator/protocol/capability-resources";

import type { InstallationReceipt } from "./types.js";

/** A receipt proves placement. A name in a session catalogue cannot prove the loaded bytes. */
export function effectiveReceiptStatus(receipt: InstallationReceipt): {
  status: CapabilityTargetStatus;
  verification: CapabilityVerificationLevel | "unverified";
  lastVerifiedAt?: string;
} {
  return {
    status: receipt.status,
    verification: receipt.verification,
    ...(receipt.verifiedAt ? { lastVerifiedAt: receipt.verifiedAt } : {}),
  };
}
