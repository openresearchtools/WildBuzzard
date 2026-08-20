export const piWebPluginIdPattern = /^[a-z][a-z0-9.-]*$/u;

export function isPiWebPluginId(value: string): boolean {
  return piWebPluginIdPattern.test(value);
}
