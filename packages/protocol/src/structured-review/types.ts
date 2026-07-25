export const REVIEW_SEVERITIES = ["P0", "P1", "P2"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_ISSUE_CATEGORIES = [
  "correctness",
  "security",
  "privacy",
  "supply-chain",
  "error-handling",
  "testing",
  "performance",
  "maintainability",
  "architecture",
  "deployment",
  "observability",
  "llm-safety",
] as const;
export type ReviewIssueCategory = (typeof REVIEW_ISSUE_CATEGORIES)[number];

export const REVIEW_CHANGE_TYPES = [
  "feature",
  "bugfix",
  "refactor",
  "test",
  "dependency",
  "migration",
  "infra",
  "ui",
  "docs",
  "security",
  "performance",
] as const;
export type ReviewChangeType = (typeof REVIEW_CHANGE_TYPES)[number];

export const REVIEW_OVERALL_RISKS = ["low", "medium", "high"] as const;
export type ReviewOverallRisk = (typeof REVIEW_OVERALL_RISKS)[number];

export const REVIEW_VERDICTS = ["yes", "with-fixes", "no"] as const;
export type ReviewVerdictReady = (typeof REVIEW_VERDICTS)[number];

export interface ReviewCommit {
  sha: string;
  subject: string;
}

export interface ReviewScopedFile {
  file: string;
  reason: string;
}

export interface ReviewCommandResult {
  command: string;
  result: "passed" | "failed";
  summary: string;
}

export interface ReviewSkippedCommand {
  command: string;
  reason: string;
}

export interface ReviewScope {
  targetBranch: string;
  baseRef: string;
  commit: ReviewCommit | null;
  filesReviewed: string[];
  filesSkipped: ReviewScopedFile[];
  filesLeftUncommitted: ReviewScopedFile[];
  commandsRun: ReviewCommandResult[];
  commandsNotRun: ReviewSkippedCommand[];
  limitations: string[];
}

export interface ReviewCodeChange {
  file: string;
  line: number | null;
  description: string;
}

export interface ReviewWhatChanged {
  overview: string;
  before: string;
  after: string;
  keyCodeChanges: ReviewCodeChange[];
  userImpact: string;
}

export interface ReviewRiskProfile {
  changeTypes: ReviewChangeType[];
  /**
   * Known risk labels and project-specific labels share this field. Keeping the
   * value open is intentional: the fixed prompt recommends common labels but
   * permits a more accurate project-specific one.
   */
  riskAreas: string[];
  overallRisk: ReviewOverallRisk;
  reasoning: string;
}

export interface ReviewTestFailure {
  testName: string;
  file: string;
  errorMessage: string;
}

export interface ReviewTestResults {
  total: number;
  passed: number;
  failed: number;
  failures: ReviewTestFailure[];
}

export interface ReviewStrength {
  description: string;
  file: string;
  line: number | null;
}

export interface ReviewIssue {
  severity: ReviewSeverity;
  confidence: number;
  category: ReviewIssueCategory;
  title: string;
  file: string;
  line: number | null;
  symbol: string;
  description: string;
  evidence: string;
  suggestion: string;
  verification: string;
  alternativeFixes?: string[];
}

export interface ReviewCoverageGap {
  file: string;
  untestedBehavior: string;
}

export interface ReviewVerdict {
  ready: ReviewVerdictReady;
  reasoning: string;
}

/**
 * The complete, provider-independent result of a native code review.
 *
 * Property order mirrors the established report UI and Markdown format. JSON
 * object order is not semantically significant, but keeping the declaration in
 * display order makes fixtures and raw inspection easier to follow.
 */
export interface StructuredReviewReport {
  reviewScope: ReviewScope;
  whatChanged: ReviewWhatChanged;
  riskProfile: ReviewRiskProfile;
  testResults: ReviewTestResults;
  strengths: ReviewStrength[];
  issues: ReviewIssue[];
  testCoverageGaps: ReviewCoverageGap[];
  verdict: ReviewVerdict;
  summaryOfChange: string;
  reviewSummary: string;
}

export type ReviewPoolId = string;

export interface PooledReviewIssue extends ReviewIssue {
  poolId: ReviewPoolId;
}

export interface PooledReviewCoverageGap extends ReviewCoverageGap {
  poolId: ReviewPoolId;
}

/**
 * Active or archived findings. Orkestrator, not the reviewing provider, assigns
 * `poolId` when accepting a new reconciliation operation.
 */
export interface ReviewFindingPool {
  issues: PooledReviewIssue[];
  coverageGaps: PooledReviewCoverageGap[];
}

export interface ReviewIssueUpdate {
  poolId: ReviewPoolId;
  finding: ReviewIssue;
}

export interface ReviewCoverageGapUpdate {
  poolId: ReviewPoolId;
  finding: ReviewCoverageGap;
}

/**
 * A provider proposes operations; the workflow applies them. New findings have
 * no ID yet, while updates must name an existing stable pool ID.
 */
export interface ReviewReconciliation {
  newIssues: ReviewIssue[];
  issueUpdates: ReviewIssueUpdate[];
  newCoverageGaps: ReviewCoverageGap[];
  coverageGapUpdates: ReviewCoverageGapUpdate[];
}

export type ReviewContractName =
  | "structured-review-report"
  | "review-finding-pool"
  | "review-reconciliation";
