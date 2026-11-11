import {
  isRendererErrorClientId,
  type RendererErrorEntry,
} from "@orkestrator/protocol/renderer-errors";

/** Session-storage key of this tab's or window's upload id. */
export const RENDERER_ERROR_CLIENT_KEY = "orkestrator:renderer-error-client";

type ClientStorage = Pick<Storage, "getItem" | "setItem">;

function randomClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid && isRendererErrorClientId(uuid)) return uuid;
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  let id = "";
  for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
  // Without any crypto source the bytes stay zero; mix in time and Math.random.
  return `${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * How this document was loaded (Navigation Timing's `type`): `reload`,
 * `navigate`, `back_forward` or `prerender`; undefined when the browser does
 * not say.
 */
export function documentNavigationType(
  performance: Pick<Performance, "getEntriesByType"> | undefined = globalThis.performance,
): string | undefined {
  try {
    const entry = performance?.getEntriesByType?.("navigation")[0] as
      { type?: unknown } | undefined;
    return typeof entry?.type === "string" ? entry.type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This renderer's upload id (`client` on `record_renderer_errors`), so the
 * backend can give it its own share of the per-minute bound. Random, kept in
 * this tab's or window's session storage so a reload keeps the same share
 * rather than taking a fresh one, and never shown or logged. Storage that is
 * blocked gives an id for this load only.
 *
 * The stored id is reused only when this document is a reload. A tab opened
 * from another one (`window.open`, "Duplicate tab") starts with a copy of its
 * opener's session storage, and so of its id; it loads as a `navigate` or a
 * `back_forward`, not a `reload`, and takes a fresh id, so two live tabs never
 * share one allowance. A same-tab navigation takes a fresh id too, which costs
 * nothing: the page it replaced no longer writes.
 */
export function rendererErrorClientId(
  storage: ClientStorage | null | undefined = undefined,
  random: () => string = randomClientId,
  navigationType: () => string | undefined = documentNavigationType,
): string {
  try {
    if (storage === undefined) storage = globalThis.sessionStorage;
    const stored = storage?.getItem(RENDERER_ERROR_CLIENT_KEY);
    if (isRendererErrorClientId(stored) && navigationType() === "reload") return stored;
  } catch {
    /* Storage may be blocked; an id for this load still works. */
  }
  const id = random();
  try {
    storage?.setItem(RENDERER_ERROR_CLIENT_KEY, id);
  } catch {
    /* As above. */
  }
  return id;
}

/** v2.36.5-beta and v2.36.6-beta refuse any argument but `entries` with this text. */
function refusedClientArgument(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes("Unexpected arguments field: client");
}

/**
 * The uploader's `send`: the entries with this renderer's `client` id. A
 * backend whose handler refused unknown arguments (the two releases before
 * the command took a tolerant schema) answers with an error naming `client`;
 * the batch is then sent again without it, and the id is left out for the rest
 * of this load. Such a backend applies only its shared bound.
 */
export function rendererErrorSender(
  invoke: (args: { entries: RendererErrorEntry[]; client?: string }) => Promise<unknown>,
  client: string,
): (entries: RendererErrorEntry[]) => Promise<unknown> {
  let withClient = true;
  return async (entries) => {
    if (!withClient) return invoke({ entries });
    try {
      return await invoke({ entries, client });
    } catch (error) {
      if (!refusedClientArgument(error)) throw error;
      withClient = false;
      return invoke({ entries });
    }
  };
}
