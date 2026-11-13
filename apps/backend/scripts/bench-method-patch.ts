/**
 * Replaces `target[key]` for a bench measurement and returns the function that
 * puts back exactly what was there: the original own property when the
 * target had one, otherwise nothing, so the prototype's method shows through
 * again. Call the restore from a `finally`, so a measurement that throws
 * does not leave the patch installed.
 */
export function patchMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  target[key] = replacement;
  return () => {
    if (own) Object.defineProperty(target, key, own);
    else Reflect.deleteProperty(target, key);
  };
}
