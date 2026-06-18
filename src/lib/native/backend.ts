export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!window.orkestrator) {
    throw new Error("Orkestrator native backend is not available");
  }
  return window.orkestrator.invoke<T>(command, args);
}
