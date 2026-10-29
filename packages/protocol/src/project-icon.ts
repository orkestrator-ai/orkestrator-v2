/**
 * A project's sidebar icon.
 *
 * The icon is a small raster image stored inline on the project record as a
 * base64 data URL, so it rides `projects.json`, the `project` resource kind
 * and the node summaries without a second store or a file route. The client
 * scales a chosen image down to `PROJECT_ICON_SIZE` before saving; the bound
 * here keeps a hand-written record from bloating every project read.
 *
 * Only raster types are accepted. An icon from another machine is rendered as
 * an `<img>` source, and SVG is excluded so a remote record can never carry
 * markup.
 */

/** Edge length, in pixels, the client scales a chosen image to. */
export const PROJECT_ICON_SIZE = 64;

/** Longest stored data URL; a 64×64 PNG is normally well under a quarter of this. */
export const MAX_PROJECT_ICON_LENGTH = 48 * 1024;

const PROJECT_ICON_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The stored icon, or null when the value is not an acceptable icon. */
export function normalizeProjectIcon(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_PROJECT_ICON_LENGTH) return null;
  return PROJECT_ICON_PATTERN.test(value) ? value : null;
}
