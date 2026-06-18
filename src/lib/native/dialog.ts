export async function open(options?: {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
}): Promise<string | string[] | null> {
  if (!window.orkestrator) return null;
  return window.orkestrator.dialog.open(options);
}
