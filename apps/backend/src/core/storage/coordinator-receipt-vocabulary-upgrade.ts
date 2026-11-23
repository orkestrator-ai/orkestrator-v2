import type { StorageMigration } from "./database.js";
import { isRecord } from "./shared.js";

/**
 * The one-way rename of stored coordinator action receipts from the former
 * custom Fix action to the custom Address Findings one (to-do 4740, task 3).
 *
 * The coordinator tool `custom_fix_multi_review` became
 * `custom_address_multi_review`, and the receipt it admits is now stored with
 * the action `custom-address` instead of `custom-fix`. The coordinators store
 * keeps only receipts whose action it knows (`isCoordinatorSurfaceAction`), so
 * without this rewrite a receipt an older build wrote would be dropped on the
 * next read, and a retry of that request would run the custom Address Findings
 * again instead of being refused. Its payload hash still covers the former
 * field name (`fixModel`), so such a retry is refused as a different payload,
 * which is the accepted outcome for a request key from before the rename.
 */

const FORMER_ACTION = "custom-fix";
const CURRENT_ACTION = "custom-address";

/** The `coordinators` store with every former custom Fix receipt renamed; the same value when none. */
export function upgradeCoordinatorReceiptVocabulary(stored: unknown): unknown {
  if (!isRecord(stored) || !Array.isArray(stored.actionReceipts)) return stored;
  let changed = false;
  const actionReceipts = stored.actionReceipts.map((receipt: unknown) => {
    if (!isRecord(receipt) || receipt.action !== FORMER_ACTION) return receipt;
    changed = true;
    return { ...receipt, action: CURRENT_ACTION };
  });
  return changed ? { ...stored, actionReceipts } : stored;
}

export const COORDINATOR_RECEIPT_VOCABULARY_UPGRADE_VERSION = 14;

export const coordinatorReceiptVocabularyUpgradeMigration: StorageMigration = {
  version: COORDINATOR_RECEIPT_VOCABULARY_UPGRADE_VERSION,
  name: "rename-coordinator-receipt-vocabulary",
  up({ database }) {
    // Absent or unreadable: nothing an older build wrote is left to upgrade.
    const coordinators = database.readStoreValueInTransaction("coordinators");
    if (!coordinators) return;
    const next = upgradeCoordinatorReceiptVocabulary(coordinators.value);
    if (next !== coordinators.value) database.writeStoreInTransaction("coordinators", next);
  },
};
