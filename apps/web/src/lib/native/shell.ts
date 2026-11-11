/**
 * The desktop shell's external opener: a URL in the user's own browser on
 * this computer, exactly as given. Absent outside the desktop app (a browser
 * gateway client, or an Electron preload too old to have it), where the
 * caller chooses its own fallback.
 */
export function shellOpenExternal(): ((url: string) => Promise<void>) | undefined {
  if (typeof window === "undefined") return undefined;
  const shell = window.orkestrator?.shell;
  if (!shell?.openExternal) return undefined;
  return (url) => shell.openExternal(url);
}
