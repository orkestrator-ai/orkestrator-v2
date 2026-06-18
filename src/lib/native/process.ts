export async function exit(code = 0): Promise<void> {
  if (window.orkestrator) {
    await window.orkestrator.process.exit(code);
    return;
  }
  window.close();
}
