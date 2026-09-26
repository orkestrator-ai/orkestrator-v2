/**
 * Attachment-type eligibility, free of UI imports.
 *
 * `workspace-attachments.ts` builds attachments through the attachment menu
 * component, so a persistence-layer validator importing it would pull React UI
 * into a pure module. The type rule lives here and is re-exported there, so
 * the composer, the send path and draft restoration share one implementation.
 */

/** The per-type half of `NativeAgentCapabilities.attachments`. */
export interface AttachmentTypeCapabilities {
  files: boolean;
  images: boolean;
}

/**
 * Keep only the attachments the target agent can actually receive.
 *
 * Capability is per type, not all-or-nothing: Codex takes images but refuses
 * files, and its bridge rejects the whole prompt rather than dropping the
 * offending entry. A draft that changes provider — or that is restored under
 * one — must therefore be reconciled against the new capabilities before it can
 * be submitted, or the send fails with an error naming an attachment the
 * composer never offered.
 *
 * Order and object identity are preserved; only ineligible entries are removed.
 */
export function retainSupportedAttachments<T extends { type: "file" | "image" }>(
  attachments: readonly T[],
  capabilities: AttachmentTypeCapabilities | undefined,
): T[] {
  if (!capabilities) return [];
  return attachments.filter((attachment) =>
    attachment.type === "image" ? capabilities.images : capabilities.files,
  );
}
