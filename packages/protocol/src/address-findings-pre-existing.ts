/**
 * What Address Findings does with a recorded validation failure that already
 * fails on the base branch (the validation report labels it `pre-existing`).
 *
 * - `excuse` (the default): it leaves the failure, citing its evidence, as it
 *   always has.
 * - `repair`: it repairs the failure too, in its own commit, apart from the
 *   branch's own fixes.
 *
 * The user chooses with the global `addressFindingsRepairsPreExisting` switch
 * (Settings → Review), off by default. Each Address Findings run records the
 * choice in force when it started (a pipeline's Address session, a Multi
 * Review workflow, a graph activation), so its prompt can be reproduced and a
 * setting changed mid-review does not change a run already under way. A
 * record without the field is `excuse`.
 *
 * Browser-safe. See `docs/architecture/review-preparation.md`.
 */

export const ADDRESS_FINDINGS_PRE_EXISTING_FAILURE_POLICIES = ["excuse", "repair"] as const;

export type AddressFindingsPreExistingFailurePolicy =
  (typeof ADDRESS_FINDINGS_PRE_EXISTING_FAILURE_POLICIES)[number];

export const DEFAULT_ADDRESS_FINDINGS_PRE_EXISTING_FAILURE_POLICY: AddressFindingsPreExistingFailurePolicy =
  "excuse";

export function isAddressFindingsPreExistingFailurePolicy(
  value: unknown,
): value is AddressFindingsPreExistingFailurePolicy {
  return value === "excuse" || value === "repair";
}

/**
 * The policy a new Address Findings run takes from the global settings. Only
 * an explicit `true` repairs: a missing field (an older config or peer) and
 * anything malformed is the default.
 */
export function addressFindingsPreExistingFailurePolicy(
  global: { addressFindingsRepairsPreExisting?: unknown } | null | undefined,
): AddressFindingsPreExistingFailurePolicy {
  return global?.addressFindingsRepairsPreExisting === true ? "repair" : "excuse";
}

/** A recorded policy, with a missing or unreadable one read as the default. */
export function recordedAddressFindingsPreExistingFailurePolicy(
  value: unknown,
): AddressFindingsPreExistingFailurePolicy {
  return isAddressFindingsPreExistingFailurePolicy(value)
    ? value
    : DEFAULT_ADDRESS_FINDINGS_PRE_EXISTING_FAILURE_POLICY;
}
