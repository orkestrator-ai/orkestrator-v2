import type { NativeComposeDraft } from "@/stores/nativeComposeStore";

export type ComposerContent = Pick<
  NativeComposeDraft,
  "text" | "mentions" | "attachments" | "annotations"
>;

const EMPTY_COMPOSER_CONTENT: ComposerContent = {
  text: "",
  mentions: [],
  attachments: [],
  annotations: [],
};

/**
 * What the composer shows of `draft`.
 *
 * A prompt the transcript already shows as sent is not unsent text, so the
 * composer looks empty. The draft itself stays in the store until the dispatch
 * settles: a stopped send, a remount and a reload all find it whole.
 */
export function composerContent(
  draft: NativeComposeDraft,
  shownInTranscript: boolean,
): ComposerContent {
  return shownInTranscript ? EMPTY_COMPOSER_CONTENT : draft;
}
