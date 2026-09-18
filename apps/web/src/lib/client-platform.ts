type ClientPlatform = NonNullable<Window["__orkestratorClientPlatform"]>;

export function isWkWebViewClient(
  platform: ClientPlatform | undefined = window.__orkestratorClientPlatform,
): boolean {
  return platform?.endsWith("-wkwebview") ?? false;
}

export function reloadAfterConnectionChange(): void {
  if (isWkWebViewClient()) {
    // The native connection bridge reauthenticates and navigates its WKWebView.
    // Reloading the old page races that navigation and can route it to Safari.
    return;
  }
  window.location.reload();
}
