/**
 * The version of `@devcontainers/cli` in the devDependencies of package.json. Throws if it is missing or not an exact
 * `x.y.z` version. Default path: package.json of this repository.
 */
export function devcontainerCliVersion(packageJsonPath?: string): string;
