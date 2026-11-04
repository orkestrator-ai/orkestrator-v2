export function isTrustedRendererUrl(candidateUrl: string, trustedRendererUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const trusted = new URL(trustedRendererUrl);

    if (trusted.protocol === "http:" || trusted.protocol === "https:") {
      return candidate.origin === trusted.origin;
    }

    if (trusted.protocol === "file:") {
      return (
        candidate.protocol === "file:" &&
        candidate.host === trusted.host &&
        candidate.pathname === trusted.pathname
      );
    }

    return candidate.href === trusted.href;
  } catch {
    return false;
  }
}
