// Environments belong to the GitHub account that created them (concept 7.5, section 9 "Accounts"). An account never
// sees, starts, or connects to an environment of another account. Entries of an older version have no owner: an account
// takes one over only when it can belong to nobody else, or when the user confirms it.
import { GitHubApiError, GitHubTimeoutError } from './discovery/githubApi';
import { errorMessage } from './errors';
import type { Logger } from './ports';
import type { EnvironmentRegistry } from './storage/registry';
import type { Environment, GitHubAccount, RepositoryInfo } from './types';

/**
 * True if the signed-in `account` may use the environment: the environment has an owner, and it is this account.
 * Without an account (not signed in), no environment is available; an entry without owner only after a claim.
 */
export function isAvailableTo(environment: Pick<Environment, 'owner'>, account: GitHubAccount | undefined): boolean {
  return account !== undefined && environment.owner !== undefined && environment.owner.id === account.id;
}

/** The environments that `account` may use, in their order. */
export function availableEnvironments<T extends Pick<Environment, 'owner'>>(
  environments: readonly T[],
  account: GitHubAccount | undefined,
): T[] {
  return environments.filter((environment) => isAvailableTo(environment, account));
}

/** The entries of an older version: they have no owner, and no account can use them until one takes them over. */
export function unownedEnvironments<T extends Pick<Environment, 'owner'>>(environments: readonly T[]): T[] {
  return environments.filter((environment) => environment.owner === undefined);
}

/** The owner entry of an environment that `account` creates or claims. */
export function ownerOf(account: GitHubAccount): GitHubAccount {
  return { id: account.id, login: account.login };
}

/** Permissions of GitHub (`viewerPermission`) that allow a push. */
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/**
 * True if an entry of the repository `info` can only belong to `account`, so a claim needs no question: a private
 * repository of the account itself (its owner is the login of the account) that the account can push to. Read access
 * alone never decides: GitHub returns a public repository to every account, and a repository of an organization to all
 * its members, and several of them can push to it.
 */
export function isUnambiguousClaim(info: RepositoryInfo, account: GitHubAccount): boolean {
  return (
    info.isPrivate &&
    info.viewerPermission !== undefined &&
    WRITE_PERMISSIONS.has(info.viewerPermission) &&
    account.login !== '' &&
    info.owner.toLowerCase() === account.login.toLowerCase()
  );
}

/**
 * How a claim decides (concept 7.5). `auto` (the check after a refresh, a restored window) claims only entries for
 * which isUnambiguousClaim holds, and never asks. `interactive` (a command of the user, for example Start) also asks
 * `ClaimDeps.confirm` for an entry whose repository GitHub returns to the account.
 */
export type ClaimMode = 'auto' | 'interactive';

export interface ClaimDeps {
  registry: Pick<EnvironmentRegistry, 'list' | 'updateEnvironment'>;
  /**
   * DiscoveryService.getRepository with the token of the account, in its quiet mode: the repository, or `undefined` when
   * GitHub does not return it (not found, or no access). Throws when the answer is unknown (for example without
   * network). It must not log the repository name or put it into an error message: an entry that stays hidden may
   * belong to another account, and its name is not shown, not even in the log.
   */
  getRepository(repository: string, token: string, signal?: AbortSignal): Promise<RepositoryInfo | undefined>;
  /**
   * Asks the user whether `account` takes over the entry of an older version (Messages.assignOlderEnvironment); true
   * for yes. Only the `interactive` mode asks. Without it, only unambiguous entries are claimed.
   */
  confirm?(environment: Environment, account: GitHubAccount): Promise<boolean>;
  logger: Logger;
}

export interface ClaimOptions {
  /** Default: `auto`. */
  mode?: ClaimMode;
  /** Only these entries; default: every entry without owner. */
  environmentIds?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Claims of environments without owner (concept 7.5). One claim runs at a time; the registry change checks again under
 * its lock that the entry has no owner, so two windows never give one entry to two accounts.
 */
export class EnvironmentClaims {
  private queue: Promise<unknown> = Promise.resolve();
  /** `<account ID>/<environment ID>` that the user declined in this session: not asked again. */
  private readonly declined = new Set<string>();

  constructor(private readonly deps: ClaimDeps) {}

  /**
   * Gives each environment without owner (only those of `environmentIds`, when given) to `account`, when GitHub returns
   * its repository for the token of the account and either the claim is unambiguous (isUnambiguousClaim) or, in the
   * `interactive` mode, the user confirms it. A failed question leaves the entry without owner, so it stays hidden.
   * Returns the IDs of the claimed environments. Never throws.
   */
  claim(account: GitHubAccount, token: string, options: ClaimOptions = {}): Promise<string[]> {
    return this.enqueue(() => this.claimNow(account, token, options));
  }

  /**
   * Gives the entries `environmentIds` that have no owner to `account` without asking GitHub. Only for a command in which
   * the user chose the entries and confirmed it, for example for an entry whose repository GitHub does not return
   * anymore (deleted, or access lost), which no claim can take over. An entry that got an owner meanwhile is not changed.
   * Returns the IDs of the entries that now belong to `account`. Never throws.
   */
  adopt(account: GitHubAccount, environmentIds: readonly string[]): Promise<string[]> {
    return this.enqueue(async () => {
      const adopted: string[] = [];
      for (const id of environmentIds) {
        if (await this.setOwner(id, account)) adopted.push(id);
      }
      return adopted;
    });
  }

  private enqueue(task: () => Promise<string[]>): Promise<string[]> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async claimNow(account: GitHubAccount, token: string, options: ClaimOptions): Promise<string[]> {
    const { registry, logger } = this.deps;
    const mode = options.mode ?? 'auto';
    let candidates: Environment[];
    try {
      candidates = unownedEnvironments(await registry.list());
    } catch (error) {
      logger.warn(`The environments without owner could not be read: ${errorMessage(error)}`);
      return [];
    }
    if (options.environmentIds) {
      const wanted = new Set(options.environmentIds);
      candidates = candidates.filter((environment) => wanted.has(environment.id));
    }
    const claimed: string[] = [];
    for (const environment of candidates) {
      if (options.signal?.aborted) break;
      // The repository name of an entry that stays hidden is not shown, not even in the log.
      let info: RepositoryInfo | undefined;
      try {
        info = await this.deps.getRepository(environment.repository, token, options.signal);
      } catch (error) {
        logger.info(`The environment ${environment.id} stays hidden: GitHub could not be asked (${failureReason(error)}).`);
        continue;
      }
      if (!info) {
        logger.info(`The environment ${environment.id} stays hidden: the signed-in account cannot access its repository.`);
        continue;
      }
      const allowed =
        isUnambiguousClaim(info, account) || (mode === 'interactive' && (await this.confirmed(environment, account)));
      if (!allowed) {
        logger.info(`The environment ${environment.id} stays hidden: it is assigned to an account only after a confirmation.`);
        continue;
      }
      if (await this.setOwner(environment.id, account)) claimed.push(environment.id);
    }
    return claimed;
  }

  /** Asks ClaimDeps.confirm once per account and entry in this session. False without it, and when it fails. */
  private async confirmed(environment: Environment, account: GitHubAccount): Promise<boolean> {
    const key = `${account.id}/${environment.id}`;
    if (!this.deps.confirm || this.declined.has(key)) return false;
    let answer: boolean;
    try {
      answer = await this.deps.confirm(environment, account);
    } catch (error) {
      this.deps.logger.warn(`The question for the environment ${environment.id} failed: ${failureReason(error)}.`);
      return false;
    }
    if (!answer) this.declined.add(key);
    return answer;
  }

  /** Writes `account` as the owner while the entry has none (checked under the registry lock). True if it is the owner. */
  private async setOwner(id: string, account: GitHubAccount): Promise<boolean> {
    try {
      let changed = false;
      const updated = await this.deps.registry.updateEnvironment(id, (entry) => {
        if (entry.owner !== undefined) return;
        entry.owner = ownerOf(account);
        changed = true;
      });
      if (updated?.owner?.id !== account.id) return false;
      if (changed) {
        this.deps.logger.info(`The environment of ${updated.repository} now belongs to the GitHub account ${account.login}.`);
      }
      return true;
    } catch (error) {
      this.deps.logger.warn(`The owner of the environment ${id} could not be written: ${errorMessage(error)}`);
      return false;
    }
  }
}

/** A reason for a failed question that cannot contain a repository name (no message text of GitHub or of an error). */
function failureReason(error: unknown): string {
  if (error instanceof GitHubApiError) return `HTTP ${error.status}`;
  if (error instanceof GitHubTimeoutError) return 'timeout';
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return error instanceof Error ? error.name : 'unknown error';
}
