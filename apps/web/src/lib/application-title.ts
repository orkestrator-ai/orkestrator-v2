/**
 * Splits a title that ends with the environment name into the part before it
 * and the name, so the name alone can be styled. Null when the title does not
 * show that environment (the desktop title names only the project).
 */
export function splitTitleEnvironmentName(
  title: string,
  environmentName: string | null,
): { prefix: string; environmentName: string } | null {
  if (!environmentName) return null;
  const suffix = ` - ${environmentName}`;
  if (!title.endsWith(suffix)) return null;
  return { prefix: title.slice(0, title.length - environmentName.length), environmentName };
}

export function getApplicationTitle(
  activeProjectName: string | null,
  isMobile: boolean,
  activeEnvironmentName: string | null = null,
  runtimeProfile: string | null = null,
): string {
  const productName = runtimeProfile
    ? `Orkestrator AI — DEV [${runtimeProfile}]`
    : "Orkestrator AI";
  if (!activeProjectName) return productName;
  if (runtimeProfile || !isMobile) {
    return activeEnvironmentName && isMobile
      ? `${productName} - ${activeProjectName} - ${activeEnvironmentName}`
      : `${productName} - ${activeProjectName}`;
  }
  return activeEnvironmentName
    ? `${activeProjectName} - ${activeEnvironmentName}`
    : activeProjectName;
}
