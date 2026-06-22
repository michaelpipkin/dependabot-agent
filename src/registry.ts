/**
 * Fetch the latest published version of a package from the npm registry and
 * return the version range it declares for targetPackage.
 *
 * Uses the public npm registry API: https://registry.npmjs.org/<name>/latest
 * This gives us the upstream author's declared dependency — completely
 * unaffected by local overrides. Package-manager independent.
 */
export async function fetchRegistrySpecifier(dependentName: string, targetPackage: string): Promise<string | null> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(dependentName)}/latest`;
    const response: Response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const pkg = (await response.json()) as Record<string, unknown>;
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
      ...(pkg.peerDependencies as Record<string, string>),
      ...(pkg.optionalDependencies as Record<string, string>),
    };
    return allDeps[targetPackage] ?? null;
  } catch {
    return null;
  }
}
