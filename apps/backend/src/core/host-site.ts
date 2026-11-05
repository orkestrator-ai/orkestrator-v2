/**
 * Approximate "site" (registrable domain) comparison without a public suffix
 * list. Shared by the artifact content origin, which refuses a content origin
 * that shares a site with the application, and preview publication, which
 * warns when its preview domain does.
 */

export interface SiteOptions {
  /**
   * Extra suffixes to treat as public, so the label below them is a site of
   * its own (`ts.net`: every tailnet name is a separate registrable domain on
   * the Public Suffix List). Without it the approximation errs towards "same
   * site".
   */
  publicSuffixes?: readonly string[];
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function normalize(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/**
 * Approximate registrable domain ("site") of a host name without a public
 * suffix list: IP literals and one/two-label names are their own site;
 * otherwise the last two labels, or three when the second-level label is a
 * common public-suffix pattern (`co.uk`, `com.au`, …) or the name ends in one
 * of `options.publicSuffixes`. The approximation errs towards "same site",
 * which only ever refuses a configuration or adds a warning.
 */
export function approximateSite(hostname: string, options: SiteOptions = {}): string {
  const host = normalize(hostname);
  if (isIpLiteral(host)) return host;
  const labels = host.split(".");
  for (const suffix of options.publicSuffixes ?? []) {
    const normalized = normalize(suffix);
    if (host.endsWith(`.${normalized}`)) {
      const take = normalized.split(".").length + 1;
      return labels.slice(-take).join(".");
    }
  }
  if (labels.length <= 2) return host;
  const second = labels.at(-2)!;
  const take =
    labels.at(-1)!.length === 2 && ["co", "com", "net", "org", "gov", "ac", "edu"].includes(second)
      ? 3
      : 2;
  return labels.slice(-take).join(".");
}

/** Whether two host names could share cookies (same site, or one a domain of the other). */
export function hostsShareSite(left: string, right: string, options: SiteOptions = {}): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return true;
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  return approximateSite(a, options) === approximateSite(b, options);
}
