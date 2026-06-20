export function isDefaultTimestampEnvironmentName(name: string): boolean {
  return /^\d{15}$/.test(name) || /^\d{8}-\d{6}$/.test(name);
}
