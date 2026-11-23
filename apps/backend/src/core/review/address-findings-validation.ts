import type {
  PersistedReviewPackage,
  ReviewPackage,
  ReviewPackageReference,
} from "@orkestrator/protocol/review-workflow";
import type { ReviewPackageVerification } from "../commands-review.js";

export type AddressFindingsValidationCheck = Pick<
  ReviewPackage["validation"][number],
  "command" | "status"
>;

export type AddressFindingsPackageVerifier = (
  environmentId: string,
  reference: ReviewPackageReference,
  onVerifiedPackage: (pkg: ReviewPackage) => void,
) => Promise<ReviewPackageVerification>;

export class StaleAddressFindingsEvidenceError extends Error {
  constructor() {
    super(
      "Multi Review validation evidence could not be verified. Retry the review to prepare a new package.",
    );
    this.name = "StaleAddressFindingsEvidenceError";
  }
}

export function addressFindingsValidationChecks(
  validation: readonly AddressFindingsValidationCheck[],
): AddressFindingsValidationCheck[] {
  return validation
    .filter(({ status }) => status === "failed" || status === "incomplete")
    .map(({ command, status }) => ({ command, status }));
}

export async function verifyAddressFindingsValidation(
  environmentId: string,
  reference: PersistedReviewPackage | undefined,
  verify: AddressFindingsPackageVerifier | undefined,
): Promise<AddressFindingsValidationCheck[]> {
  if (!reference) return [];
  if (!("kind" in reference)) return addressFindingsValidationChecks(reference.validation);
  let checks: AddressFindingsValidationCheck[] | undefined;
  const result = await verify?.(environmentId, reference, (pkg) => {
    checks = addressFindingsValidationChecks(pkg.validation);
  });
  if (!result?.valid || !checks) throw new StaleAddressFindingsEvidenceError();
  return checks;
}
