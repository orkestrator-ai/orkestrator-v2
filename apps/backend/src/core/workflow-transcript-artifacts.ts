/**
 * Published transcript artifacts on the workflow transcripts that read their
 * providers directly instead of through the native projection: Multi Review
 * reviewer tabs and build-pipeline stage transcripts.
 *
 * The rules are the native projection's (`native-agent-service-projection-artifacts.ts`):
 * the publication ledger is authoritative, read per conversation (the
 * workflow session's own key, in the workflow's environment; publications of
 * any other conversation or environment are refused even if a ledger
 * returned them), and each publication is appended as a `type: "artifact"`
 * part to the end of the row holding the call that published it. Rows are
 * never inserted, so windows, cursors and patch indexes do not move; a
 * publication whose call is not among the rows read is left to the
 * renderer's own merge, which also de-duplicates by publication id.
 */
import {
  ArtifactOverlayIndex,
  overlayArtifactParts,
  type ArtifactLedgerReader,
} from "./native-agent-service-projection-artifacts.js";

export type ArtifactLedgerSource = () => ArtifactLedgerReader | null | undefined;

export class WorkflowTranscriptArtifacts {
  private readonly overlays: ArtifactOverlayIndex;

  constructor(ledger: ArtifactLedgerSource | undefined) {
    this.overlays = new ArtifactOverlayIndex(() => ledger?.() ?? null);
  }

  /**
   * The conversation's ledger revision, 0 when it has no publications or no
   * ledger is available. Mixed into conditional-read tokens so a provider
   * "unchanged" can never hide a new publication.
   */
  revision(environmentId: string, conversationKey: string): number {
    return this.overlays.overlay(environmentId, conversationKey)?.revision ?? 0;
  }

  /**
   * `rows` with each of the conversation's publications placed beside its
   * call. Returns the input array itself when nothing was added; never
   * mutates a row.
   */
  place<T>(environmentId: string, conversationKey: string, rows: readonly T[]): T[] {
    if (rows.length === 0) return rows as T[];
    return overlayArtifactParts(rows, this.overlays.overlay(environmentId, conversationKey));
  }

  clear(): void {
    this.overlays.clear();
  }
}
