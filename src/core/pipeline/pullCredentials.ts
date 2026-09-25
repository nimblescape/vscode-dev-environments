// Credentials for the host `docker pull` of the pipeline (concept 7.7 "Registry requires a sign-in", concept section 12
// phase 2 "private images on ghcr.io with the GitHub session"). The image check can use the GitHub session for ghcr.io
// (withGitHubPackagesFallback); the pull must get the same credentials, or a private image passes the check but never
// downloads. The credentials are used for one pull only and never stored (concept section 9).
import { parseImageReference } from '../imageCheck/reference';
import type { CredentialsProvider } from '../imageCheck/registryClient';
import type { Credentials, GitHubAuth } from '../ports';

/** Registry credentials for one `docker pull`. */
export interface PullCredentials extends Credentials {
  /** Registry host, for example `ghcr.io`. */
  registry: string;
}

/** Credentials for the pull of `reference`, or `undefined`: Docker pulls with its own credentials. */
export type PullCredentialsProvider = (reference: string, signal?: AbortSignal) => Promise<PullCredentials | undefined>;

/** The only registry for which the GitHub session can provide credentials (scope `read:packages`). */
const GITHUB_PACKAGES_REGISTRY = 'ghcr.io';

/**
 * The GitHub session (scope `read:packages`, requested without a dialog) for an image on ghcr.io, when Docker has no
 * credentials of its own for ghcr.io. `docker` is the Docker credential store (DockerCredentialStore.provider()).
 */
export function githubPackagesPullCredentials(
  docker: CredentialsProvider,
  github: Pick<GitHubAuth, 'getPackagesCredentials'>,
): PullCredentialsProvider {
  return async (reference, signal) => {
    const registry = parseImageReference(reference)?.registry.toLowerCase();
    if (registry !== GITHUB_PACKAGES_REGISTRY || signal?.aborted) return undefined;
    try {
      if (await docker(GITHUB_PACKAGES_REGISTRY, signal)) return undefined;
      if (signal?.aborted) return undefined;
      const session = await github.getPackagesCredentials({ interactive: false });
      return session ? { registry: GITHUB_PACKAGES_REGISTRY, username: session.username, password: session.password } : undefined;
    } catch {
      return undefined;
    }
  };
}
