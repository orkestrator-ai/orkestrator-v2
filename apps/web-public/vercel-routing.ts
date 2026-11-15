/**
 * How Vercel applies `vercel.json`'s `headers` and `rewrites` to a request
 * path, for the configuration test (`src/config.test.ts`) and the public-site
 * browser suite's server (`e2e/public-site/vercel-static-server.ts`), which
 * serves the built client with these rules so the browser sees the policies a
 * deployment sends.
 *
 * Vercel compiles `source` with path-to-regexp 6 under `strict: true` and
 * `sensitive: true` (`sourceToRegex` in `@vercel/routing-utils`,
 * `packages/routing-utils/src/superstatic.ts`): matching is case-sensitive, a
 * trailing slash is not optional, and a parenthesised group is taken as a raw
 * regular expression. So `/static-html-frame.html` names exactly that path, and
 * `/static-html-frame.html/` or `/STATIC-HTML-FRAME.HTML` is a different path
 * that only the general rule matches. The repository has no path-to-regexp 6
 * to call, so this is the subset these rules use; whether a real deployment
 * applies them as matched here is the manual-test checklist's check (7568,
 * 4650 task 1).
 */

export type VercelHeader = { key: string; value: string };

export type VercelConfig = {
  outputDirectory: string;
  rewrites: Array<{ source: string; destination: string }>;
  headers: Array<{ source: string; headers: VercelHeader[] }>;
};

export function vercelSourcePattern(source: string): RegExp {
  let pattern = "";
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === "\\" && depth > 0) {
      pattern += character + source[++index];
      continue;
    }
    if (character === "(") depth++;
    if (depth > 0) pattern += character;
    else pattern += character.replace(/[.*+?^${}|[\]\\/]/g, "\\$&");
    if (character === ")") depth--;
  }
  if (depth !== 0) throw new Error(`Unbalanced source ${source}`);
  return new RegExp(`^${pattern}$`);
}

/** Every header of every rule whose source matches, in rule order (Vercel applies them all). */
export function vercelHeadersFor(config: VercelConfig, pathname: string): VercelHeader[] {
  return config.headers
    .filter((rule) => vercelSourcePattern(rule.source).test(pathname))
    .flatMap((rule) => rule.headers);
}

/**
 * The path a request is served from when no file matches it: the first
 * matching rewrite's destination, or null. Vercel checks the filesystem before
 * rewrites, so a caller tries the file first.
 */
export function vercelRewriteFor(config: VercelConfig, pathname: string): string | null {
  const rule = config.rewrites.find((rewrite) =>
    vercelSourcePattern(rewrite.source).test(pathname),
  );
  return rule?.destination ?? null;
}
