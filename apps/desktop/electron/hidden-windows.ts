import type { BrowserWindowConstructorOptions } from "electron";

/**
 * A window's options with it kept off the desktop: never shown on creation,
 * and still painting and running timers, since a hidden window is otherwise
 * throttled like a background tab.
 */
export function hiddenWindowOptions(
  options: BrowserWindowConstructorOptions = {},
): BrowserWindowConstructorOptions {
  return {
    ...options,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { ...options.webPreferences, backgroundThrottling: false },
  };
}

/**
 * `BrowserWindow` with every window it constructs hidden. A proxy rather than a
 * subclass, so the statics (`getAllWindows`, `fromWebContents`) and the
 * instances stay Electron's own. Every window factory in main takes its
 * constructor as a parameter, so passing this one covers each window,
 * including any added later.
 */
export function hiddenWindowConstructor<
  Ctor extends new (options?: BrowserWindowConstructorOptions) => object,
>(BrowserWindowCtor: Ctor): Ctor {
  return new Proxy(BrowserWindowCtor, {
    construct(target, args: [BrowserWindowConstructorOptions?]) {
      return new target(hiddenWindowOptions(args[0]));
    },
  });
}
