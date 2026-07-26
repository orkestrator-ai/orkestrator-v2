export function setMobileViewport(isMobile: boolean): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: query === "(max-width: 767px)" && isMobile,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  });
}
