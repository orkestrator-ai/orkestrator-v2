export async function exit(code = 0): Promise<void> {
  if (window.orkestrator) {
    await window.orkestrator.process.exit(code);
    return;
  }
  window.close();
}

export async function restart(): Promise<void> {
  const restartApplication = window.orkestrator?.process.restart;
  if (!restartApplication) {
    window.location.reload();
    return;
  }
  await restartApplication();
}
