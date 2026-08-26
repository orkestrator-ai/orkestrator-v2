/**
 * The pane layout compare-and-swap contract, shared by the backend that raises
 * a conflict and the renderer that has to recognise one.
 *
 * The renderer's whole rebase-and-retry path hangs off recognising this single
 * failure, and the error crosses a process boundary that only preserves
 * `Error.message`: Electron prefixes it with "Error invoking remote method
 * ...", and the gateway reduces it to `{ error: message }` over HTTP. Owning
 * the marker here means a reword cannot silently downgrade every conflict into
 * a hard save failure with the merge code still present but unreachable.
 */
export const PANE_LAYOUT_REVISION_CONFLICT_MARKER = "Pane layout revision conflict:";

/**
 * Shared wire-format versions. Keeping these beside the CAS contract prevents
 * the renderer and backend from accepting different pane-layout schemas.
 */
export const LEGACY_PANE_LAYOUT_VERSION = 1;
/** Last provider-specific native-tab schema, retained as a one-release read path. */
export const PROVIDER_NATIVE_PANE_LAYOUT_VERSION = 2;
export const PANE_LAYOUT_VERSION = 3;

/** Matches the nine direct tab-selection shortcuts exposed by the renderer. */
export const MAX_TABS_PER_ENVIRONMENT = 9;

export const PANE_LAYOUT_UNSUPPORTED_VERSION_MARKER = "Unsupported pane layout version:";

export function paneLayoutUnsupportedVersionMessage(version: number): string {
  return `${PANE_LAYOUT_UNSUPPORTED_VERSION_MARKER} ${version}`;
}

export function isPaneLayoutUnsupportedVersion(error: unknown): boolean {
  return error instanceof Error && error.message.includes(PANE_LAYOUT_UNSUPPORTED_VERSION_MARKER);
}

export function paneLayoutRevisionConflictMessage(
  expectedRevision: number,
  currentRevision: number,
): string {
  return `${PANE_LAYOUT_REVISION_CONFLICT_MARKER} expected ${expectedRevision}, current ${currentRevision}`;
}

/**
 * Recognises a conflict on the renderer side.
 *
 * Uses `includes` rather than `startsWith` because the transport is allowed to
 * prepend its own framing, and matches on the marker alone so the revision
 * numbers stay free to change.
 */
export function isPaneLayoutRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes(PANE_LAYOUT_REVISION_CONFLICT_MARKER);
}
