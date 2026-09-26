// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Concept D-3: one environment per repository and GitHub account. The environment service with two accounts that open
// the same repository, with the claims of entries of an older version, and with the names of a new environment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, environmentImageName, resourceName } from '../names';
import { EnvironmentClaims, availableEnvironments } from '../ownership';
import { silentLogger } from '../ports';
import type { Environment, GitHubAccount, RepositoryInfo } from '../types';
import type { EnvironmentServiceDeps, RepositoryTarget } from './environmentService';
import {
  ACCOUNT,
  BASE_IMAGE,
  ENV_ID,
  OTHER_ACCOUNT,
  OTHER_ID,
  REPO,
  TOKEN,
  additionalVolumeLabels,
  createHarness,
  seedEnvironment,
  type Harness,
} from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const OTHER_TOKEN = 'gho_othertoken';
const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

function recreate(overrides: Partial<EnvironmentServiceDeps>): void {
  h.cleanup();
  h = createHarness(overrides);
}

function options(extra: { olderEnvironmentAsked?: boolean } = {}): { progress: typeof h.progress; olderEnvironmentAsked?: boolean } {
  return { progress: h.progress, ...extra };
}

/** A switch of the GitHub account in VS Code: another account, with a token of its own. */
function signIn(account: GitHubAccount, token: string): void {
  h.account = { ...account };
  h.token = token;
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UserFacingError);
    return error as UserFacingError;
  }
  throw new Error('The promise did not reject.');
}

/** A repository of an organization, as GitHub returns it to a member that can push to it: a claim needs a question. */
function repositoryInfo(nameWithOwner: string): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: true,
    viewerPermission: 'WRITE',
    pushedAt: null,
    defaultBranch: 'main',
    configPaths: [DEFAULT_CONFIG_PATH],
  };
}

/**
 * A harness whose service claims with the real EnvironmentClaims: `answer` is the answer of the user to the question
 * before an entry of an older version is assigned, and `lookUp` the answer of GitHub (by default, GitHub returns the
 * repository to every account).
 */
function withClaims(
  answer: (account: GitHubAccount) => boolean,
  lookUp: (repository: string) => Promise<RepositoryInfo | undefined> = async (repository) => repositoryInfo(repository),
): {
  getRepository: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
} {
  const getRepository = vi.fn(lookUp);
  const confirm = vi.fn(async (_environment: Environment, account: GitHubAccount) => answer(account));
  const claims = new EnvironmentClaims({
    // The registry of the harness that recreate makes next.
    get registry() {
      return h.registry;
    },
    getRepository,
    confirm,
    logger: silentLogger,
  });
  recreate({ claims });
  return { getRepository, confirm };
}

describe('two GitHub accounts open the same repository (concept D-3)', () => {
  it('gives each account an environment of its own: clone, volume, container, token, and Git identity', async () => {
    const first = (await h.service.open(TARGET, options())).environment;
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const second = (await h.service.open(TARGET, options())).environment;

    expect(second.id).not.toBe(first.id);
    expect([first.owner, second.owner]).toEqual([ACCOUNT, OTHER_ACCOUNT]);
    expect(second.volumeName).toBe(resourceName(REPO, second.id));
    expect(second.volumeName).not.toBe(first.volumeName);
    expect(second.containerName).not.toBe(first.containerName);
    expect(h.docker.volumes.get(second.volumeName)).toEqual({
      [LABEL_ENVIRONMENT_ID]: second.id,
      [LABEL_REPOSITORY]: REPO,
      [LABEL_OWNER_ID]: OTHER_ACCOUNT.id,
    });
    expect(h.helper.clones.map((clone) => [clone.volumeName, clone.token])).toEqual([
      [first.volumeName, TOKEN],
      [second.volumeName, OTHER_TOKEN],
    ]);
    expect(h.helper.gitPreparations.map((call) => [call.volumeName, call.token, call.identity.email])).toEqual([
      [first.volumeName, TOKEN, '1001+octo@users.noreply.github.com'],
      [second.volumeName, OTHER_TOKEN, '2002+someone@users.noreply.github.com'],
    ]);
    // Concept section 9: the GitHub CLI of each environment is signed in as the account that owns it, with its token.
    expect(h.helper.gitPreparations.map((call) => call.login)).toEqual(['octo', 'someone']);
    expect(h.docker.containersOf(first.id)).toHaveLength(1);
    expect(h.docker.containersOf(second.id)).toHaveLength(1);
    expect([...h.ui.infos, ...h.ui.warnings]).toEqual([]);
  });

  it('lets each account see and open only its own environment of the repository', async () => {
    const first = (await h.service.open(TARGET, options())).environment;
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const second = (await h.service.open(TARGET, options())).environment;

    const entries = await h.registry.list();
    expect(availableEnvironments(entries, ACCOUNT).map((entry) => entry.id)).toEqual([first.id]);
    expect(availableEnvironments(entries, OTHER_ACCOUNT).map((entry) => entry.id)).toEqual([second.id]);
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id))?.id).toBe(first.id);
    expect((await h.registry.findForAccount(REPO, OTHER_ACCOUNT.id))?.id).toBe(second.id);

    // Back to the first account: Start opens its environment again, without a clone, with its own token.
    signIn(ACCOUNT, TOKEN);
    const again = await h.service.open(TARGET, options());
    expect(again.environment.id).toBe(first.id);
    expect(h.helper.clones).toHaveLength(2);
    expect(h.helper.gitPreparations.at(-1)).toMatchObject({ volumeName: first.volumeName, token: TOKEN });
    // Only an explicit reference to the environment of the other account is refused.
    expect((await rejection(h.service.openEnvironment(second.id, options()))).code).toBe('otherAccount');
    expect((await rejection(h.service.stop(second.id))).code).toBe('otherAccount');
  });

  it('creates an environment of the account when another window created one of another account in the meantime', async () => {
    const original = h.registry.add.bind(h.registry);
    let raced = false;
    h.registry.add = async (environment: Environment) => {
      if (!raced) {
        raced = true;
        await seedEnvironment(h, { owner: OTHER_ACCOUNT, container: 'stopped' });
      }
      return original(environment);
    };
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).not.toBe(ENV_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toHaveLength(1);
    expect((await h.registry.list()).map((entry) => entry.id).sort()).toEqual([ENV_ID, result.environment.id].sort());
  });

  it('uses the environment of the account that another window created in the meantime, never the one of another account', async () => {
    const original = h.registry.add.bind(h.registry);
    let raced = false;
    h.registry.add = async (environment: Environment) => {
      if (!raced) {
        raced = true;
        await seedEnvironment(h, { id: OTHER_ID, owner: OTHER_ACCOUNT, container: 'stopped' });
        await seedEnvironment(h, { container: 'stopped' });
      }
      return original(environment);
    };
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).toBe(ENV_ID);
    expect(h.helper.clones).toEqual([]);
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([OTHER_ID, ENV_ID]);
  });

  it('writes the token of the session that found the environment, also when the account changes during the open', async () => {
    let switched = false;
    recreate({
      auth: {
        getToken: async () => (switched ? OTHER_TOKEN : TOKEN),
        getAccount: async () => (switched ? OTHER_ACCOUNT : ACCOUNT),
      },
    });
    await seedEnvironment(h);
    const find = h.registry.findForAccount.bind(h.registry);
    h.registry.findForAccount = async (repository: string, accountId: string) => {
      const found = await find(repository, accountId);
      // Another window signs in with the other account right after the lookup.
      switched = true;
      return found;
    };
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).toBe(ENV_ID);
    expect(h.helper.gitPreparations.map((call) => call.token)).toEqual([TOKEN]);
  });

  it('asks for the sign-in first, because the account decides which environment is used', async () => {
    h.token = undefined;
    const error = await rejection(h.service.open({ ...TARGET, trusted: false }, options()));
    expect(error.code).toBe('signInRequired');
    expect(h.ui.prompts).toEqual([]);
    expect(h.dockerStarts).toBe(0);
    expect(await h.registry.list()).toEqual([]);
  });

  it('asks the second account before its first open of a repository of another owner', async () => {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT });
    h.ui.trust = false;
    expect((await rejection(h.service.open({ ...TARGET, trusted: false }, options()))).code).toBe('cancelled');
    expect(h.ui.prompts).toEqual([`untrusted ${REPO}`]);
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
  });

  it('refuses a named volume of the repository that the environment of another account uses (concept section 9)', async () => {
    const SHARED = 'api-node_modules';
    await seedEnvironment(h, { owner: OTHER_ACCOUNT, container: null, extra: { additionalVolumes: [SHARED] } });
    h.helper.config = { image: BASE_IMAGE, mounts: [`source=${SHARED},target=/workspaces/api/node_modules,type=volume`] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`volume ${SHARED} of another environment`));
    expect(h.helper.builds).toEqual([]);
    // The failed first open leaves nothing behind; the environment of the other account keeps its volume.
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
    expect([...h.docker.volumes.keys()]).toEqual([resourceName(REPO, ENV_ID)]);
  });
});

describe('additional volumes that a Delete kept (concept 7.14 step 4, section 9)', () => {
  const DATA = 'api-data';
  const MOUNT = `source=${DATA},target=/data,type=volume`;

  /** The environment of OTHER_ACCOUNT used `DATA`; its Delete keeps it. */
  async function otherAccountDeletesAndKeeps(): Promise<void> {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT, container: null, extra: { additionalVolumes: [DATA] } });
    h.docker.volumes.set(DATA, {});
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    signIn(ACCOUNT, TOKEN);
  }

  it('keeps the volume for its account: the environment of another account of the repository must not mount it', async () => {
    await otherAccountDeletesAndKeeps();
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.has(DATA)).toBe(true);
    expect(await h.registry.keptVolumes()).toEqual([{ name: DATA, owner: OTHER_ACCOUNT, keptAt: expect.any(String) }]);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`volume ${DATA} of another environment`));
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.volumes.has(DATA)).toBe(true);
  });

  it('lets a new environment of the same account use the volume again, without taking it for its own', async () => {
    await otherAccountDeletesAndKeeps();
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    const result = await h.service.open(TARGET, options());
    expect(result.environment.owner).toEqual(OTHER_ACCOUNT);
    expect(h.helper.ups).toHaveLength(1);
    // Its labels name no environment (a version before the labels created it): never recorded, never removed.
    expect(result.environment.additionalVolumes).toBeUndefined();
  });

  it('lets a new environment of the same account mount a labeled volume that its Delete kept, and refuses it to another account', async () => {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT, container: null, extra: { additionalVolumes: [DATA] } });
    h.docker.volumes.set(DATA, additionalVolumeLabels(ENV_ID, OTHER_ACCOUNT));
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    // Without the record of the Delete, the labels alone decide.
    await h.registry.forgetKeptVolumes([DATA]);
    signIn(ACCOUNT, TOKEN);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess(`volume ${DATA} of another environment`));
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const result = await h.service.open(TARGET, options());
    expect(result.environment.owner).toEqual(OTHER_ACCOUNT);
    // The labels name the deleted environment: the new one does not take it for its own, and its Delete keeps it.
    expect(result.environment.additionalVolumes).toBeUndefined();
    expect(h.docker.volumes.get(DATA)).toEqual(additionalVolumeLabels(ENV_ID, OTHER_ACCOUNT));
  });

  it('records the volumes that the Delete after missing files keeps without asking', async () => {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT, volume: false, container: null, extra: { additionalVolumes: [DATA] } });
    h.docker.volumes.set(DATA, {});
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    h.ui.filesMissingAnswer = 'deleteEnvironment';
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('cancelled');
    expect(await h.registry.list()).toEqual([]);
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner])).toEqual([[DATA, OTHER_ACCOUNT]]);
    signIn(ACCOUNT, TOKEN);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('hostAccess');
  });

  it('no longer refuses the name once the kept volume is gone: a new volume of that name is empty', async () => {
    await otherAccountDeletesAndKeeps();
    h.docker.volumes.delete(DATA);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    const result = await h.service.open(TARGET, options());
    expect(result.environment.owner).toEqual(ACCOUNT);
  });

  it('drops the records of a kept volume that was removed outside the extension, so a new volume of that name is not refused to its account', async () => {
    await otherAccountDeletesAndKeeps();
    // docker volume prune; then an environment of ACCOUNT creates a new volume of that name.
    h.docker.volumes.delete(DATA);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    const first = await h.service.open(TARGET, options());
    expect(await h.registry.keptVolumes()).toEqual([]);
    // The new volume of that name carries the labels of the environment of ACCOUNT, which created it before `up`.
    expect(h.docker.volumes.get(DATA)).toEqual(additionalVolumeLabels(first.environment.id, ACCOUNT));
    expect(first.environment.additionalVolumes).toEqual([DATA]);
    // The Delete of ACCOUNT keeps it; its next environment may use it, but only the Delete of the environment that
    // created it removes it: the next one keeps it, with a line in the log.
    await h.service.delete(first.environment.id, { progress: h.progress, additionalVolumesToRemove: [] });
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner?.id])).toEqual([[DATA, ACCOUNT.id]]);
    const result = await h.service.open(TARGET, options());
    expect(h.helper.ups.length).toBeGreaterThan(1);
    expect(result.environment.additionalVolumes).toBeUndefined();
    await h.registry.updateEnvironment(result.environment.id, (entry) => {
      entry.additionalVolumes = [DATA];
    });
    await h.service.delete(result.environment.id, { progress: h.progress, additionalVolumesToRemove: [DATA] });
    expect(h.docker.volumes.has(DATA)).toBe(true);
    expect(h.logger.infos.some((line) => line.startsWith(`The volume ${DATA} is kept, because another environment created it`))).toBe(true);
  });

  it('records no kept volume that does not exist at the Delete', async () => {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT, container: null, extra: { additionalVolumes: [DATA, 'gone'] } });
    h.docker.volumes.set(DATA, {});
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect((await h.registry.keptVolumes()).map((record) => record.name)).toEqual([DATA]);
  });

  it('keeps the account of the volumes that a failed first open leaves behind', async () => {
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    // `up` creates the volume of the mount, then fails.
    h.helper.upError = () => {
      h.docker.volumes.set(DATA, {});
      return new Error('postCreateCommand failed');
    };
    await rejection(h.service.open(TARGET, options()));
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.has(DATA)).toBe(true);
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner?.id])).toEqual([[DATA, ACCOUNT.id]]);
    h.helper.upError = () => undefined;
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`volume ${DATA} of another environment`));
    // Its own account may use it.
    signIn(ACCOUNT, TOKEN);
    expect((await h.service.open(TARGET, options())).environment.owner).toEqual(ACCOUNT);
  });

  it('forgets the record when a later Delete removes the volume, and never removes a volume that another account kept', async () => {
    await otherAccountDeletesAndKeeps();
    // An entry of one person from before the separation by account recorded the same volume.
    await seedEnvironment(h, { id: OTHER_ID, container: null, extra: { additionalVolumes: [DATA, 'web-cache'] } });
    h.docker.volumes.set('web-cache', additionalVolumeLabels(OTHER_ID));
    await h.service.delete(OTHER_ID, { progress: h.progress, additionalVolumesToRemove: [DATA, 'web-cache'] });
    expect(h.docker.volumes.has(DATA)).toBe(true);
    expect(h.docker.volumes.has('web-cache')).toBe(false);
    // The volume that stays keeps the record of the account that kept it, and gets one of this account too; the environments
    // of both accounts are refused it now (each may hold data of the other).
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner?.id])).toEqual([
      [DATA, OTHER_ACCOUNT.id],
      [DATA, ACCOUNT.id],
    ]);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('hostAccess');
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('hostAccess');
  });
});

describe('a lost registry: the named volumes without labels that the container of an environment mounts (concept 7.5, section 9)', () => {
  const PGDATA = 'pgdata';
  const WORKSPACE = resourceName(REPO, OTHER_ID);

  /** The registry is lost; the volume and the container of OTHER_ACCOUNT's environment are still there. */
  function lostRegistry(mounted: string[]): void {
    h.docker.volumes.set(WORKSPACE, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    const container = h.docker.addContainer({ environmentId: OTHER_ID, name: WORKSPACE, state: 'stopped', image: environmentImageName(OTHER_ID, 1) });
    h.docker.containers.set(container.id, { ...container, volumes: [WORKSPACE, ...mounted] });
  }

  it('records the unlabelled volume again, so that the environment of another account is refused it', async () => {
    h.docker.volumes.set(PGDATA, {});
    lostRegistry([PGDATA]);
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toEqual([PGDATA]);
    // ACCOUNT's first open of the repository mounts the volume of OTHER_ACCOUNT's environment.
    h.helper.config = { image: BASE_IMAGE, mounts: [`source=${PGDATA},target=/var/lib/postgresql/data,type=volume`] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`volume ${PGDATA} of another environment`));
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.volumes.get(PGDATA)).toEqual({});
  });

  it('keeps the unlabelled volume at the Delete of the restored environment: not offered, not removed, kept for its account', async () => {
    h.docker.volumes.set(PGDATA, {});
    lostRegistry([PGDATA]);
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    expect(await h.service.removableAdditionalVolumes(OTHER_ID)).toEqual([]);
    // Even a confirmation of the name does not remove it: its labels do not make it the environment's own.
    await h.service.delete(OTHER_ID, { progress: h.progress, additionalVolumesToRemove: [PGDATA] });
    expect(await h.registry.get(OTHER_ID)).toBeUndefined();
    expect(h.docker.volumes.get(PGDATA)).toEqual({});
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner?.id])).toEqual([[PGDATA, OTHER_ACCOUNT.id]]);
  });

  it('records no anonymous volume, no volume of Docker Compose or of another environment, and no volume that does not exist', async () => {
    const anonymous = 'ef'.repeat(32);
    h.docker.volumes.set(anonymous, { 'com.docker.volume.anonymous': '' });
    h.docker.volumes.set('shop_db', { 'com.docker.compose.project': 'shop', 'com.docker.compose.volume': 'db' });
    h.docker.volumes.set('web-cache', additionalVolumeLabels('f0000001-0000-4000-8000-000000000001', ACCOUNT));
    h.docker.volumes.set('devenv-acme-web-f0000001', { [LABEL_ENVIRONMENT_ID]: 'f0000001-0000-4000-8000-000000000001', [LABEL_REPOSITORY]: 'acme/web' });
    lostRegistry([anonymous, 'shop_db', 'web-cache', 'devenv-acme-web-f0000001', 'gone']);
    expect(await h.service.reconcileFromVolumes()).toBeGreaterThanOrEqual(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toBeUndefined();
  });
});

describe('entries of an older version at Start (concept 7.5, D-3)', () => {
  it('claims the entry of the repository for the account after the question, and uses it', async () => {
    const { confirm } = withClaims(() => true);
    await seedEnvironment(h, { owner: null });
    const result = await h.service.open(TARGET, options());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.environment.id).toBe(ENV_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toEqual([]);
  });

  it('creates an environment of the account when the user declines, and leaves the entry to another account', async () => {
    const { confirm } = withClaims((account) => account.id === OTHER_ACCOUNT.id);
    await seedEnvironment(h, { owner: null });
    const own = (await h.service.open(TARGET, options())).environment;
    expect(own.id).not.toBe(ENV_ID);
    expect(h.helper.clones).toHaveLength(1);
    expect((await h.registry.get(ENV_ID))?.owner).toBeUndefined();

    // The account has an environment of the repository now: the entry is not asked about again.
    await h.service.open(TARGET, options());
    expect(confirm).toHaveBeenCalledTimes(1);

    // An account without an environment of the repository can take the entry over.
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const claimed = await h.service.open(TARGET, options());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(claimed.environment.id).toBe(ENV_ID);
    expect(claimed.environment.owner).toEqual(OTHER_ACCOUNT);
    expect(h.helper.clones).toHaveLength(1);
  });

  it('creates nothing when the user declines an entry that uses named volumes of the repository, and asks again at the next Start', async () => {
    const answers = [false, false, true];
    const { confirm } = withClaims(() => answers.shift() ?? false);
    await seedEnvironment(h, { owner: null, extra: { additionalVolumes: ['api-node_modules'] } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('environmentUnassigned');
      expect(error.message).toBe(Messages.olderEnvironmentUsesVolumes(REPO));
    }
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(h.helper.clones).toEqual([]);
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
    // Assign at the third Start: the entry is used.
    const result = await h.service.open(TARGET, options());
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(result.environment.id).toBe(ENV_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
  });

  it('does not ask again about a declined entry when the command asked already (Switch branch…, Select configuration…)', async () => {
    const { confirm } = withClaims(() => false);
    await seedEnvironment(h, { owner: null, extra: { additionalVolumes: ['api-node_modules'] } });
    await rejection(h.service.open(TARGET, options()));
    expect(confirm).toHaveBeenCalledTimes(1);
    const error = await rejection(h.service.open(TARGET, options({ olderEnvironmentAsked: true })));
    expect(error.message).toBe(Messages.olderEnvironmentUsesVolumes(REPO));
    expect(confirm).toHaveBeenCalledTimes(1);
    await rejection(h.service.open(TARGET, options()));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('asks once in one open, also when the restore of a lost registry adds an entry of another repository', async () => {
    const { confirm } = withClaims(() => false);
    await seedEnvironment(h, { owner: null });
    const web = 'e0000001-0000-4000-8000-000000000001';
    h.docker.volumes.set(resourceName('acme/web', web), { [LABEL_ENVIRONMENT_ID]: web, [LABEL_REPOSITORY]: 'acme/web' });
    const own = (await h.service.open(TARGET, options())).environment;
    expect(own.id).not.toBe(ENV_ID);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('reads the token for the claim of a command interactively: a new sign-in while GitHub rejects the token', async () => {
    const { getRepository } = withClaims(() => true);
    const interactive: boolean[] = [];
    recreate({
      claims: h.service['deps'].claims,
      auth: {
        getToken: async (options: { interactive: boolean }) => {
          interactive.push(options.interactive);
          return options.interactive ? 'gho_new' : TOKEN;
        },
        getAccount: async () => ACCOUNT,
      },
    });
    await seedEnvironment(h, { owner: null });
    await h.service.listConfigurations(ENV_ID, options());
    expect(interactive).toContain(true);
    expect(getRepository).toHaveBeenCalledWith(REPO, 'gho_new', undefined);
    expect((await h.registry.get(ENV_ID))?.owner).toEqual(ACCOUNT);
  });

  it('creates an environment of the account when GitHub does not return the repository of the entry to it', async () => {
    const { confirm } = withClaims(() => true, async () => undefined);
    await seedEnvironment(h, { owner: null });
    const own = (await h.service.open(TARGET, options())).environment;
    expect(own.id).not.toBe(ENV_ID);
    expect(confirm).not.toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.owner).toBeUndefined();
  });

  it('refuses Start as not assigned while GitHub cannot be asked about the entry, and creates no second environment', async () => {
    let online = false;
    const { confirm } = withClaims(
      () => true,
      async (repository) => {
        if (!online) throw new Error('getaddrinfo ENOTFOUND api.github.com');
        return repositoryInfo(repository);
      },
    );
    await seedEnvironment(h, { owner: null });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('environmentUnassigned');
    expect(error.message).toBe(Messages.olderEnvironmentNotAssigned(REPO));
    expect(confirm).not.toHaveBeenCalled();
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
    expect(h.helper.clones).toEqual([]);
    expect(h.dockerStarts).toBe(0);

    // Try again when GitHub answers: the question comes, and the entry is used.
    online = true;
    const result = await h.service.open(TARGET, options());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.environment.id).toBe(ENV_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toEqual([]);
  });

  it('opens the environment of the account without asking GitHub or the user about the entry of an older version', async () => {
    const { getRepository, confirm } = withClaims(() => true);
    await seedEnvironment(h, { owner: null });
    const own = await seedEnvironment(h, { id: OTHER_ID });
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).toBe(own.id);
    expect(getRepository).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.owner).toBeUndefined();
  });

  it('never claims the entry for an account that has an environment of the repository, also by its ID', async () => {
    const { confirm } = withClaims(() => true);
    await seedEnvironment(h, { owner: null });
    await seedEnvironment(h, { id: OTHER_ID });
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.message).toBe(Messages.olderEnvironmentNotAssigned(REPO));
    expect(confirm).not.toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.owner).toBeUndefined();
  });
});

describe('the ID of a new environment (implementation notes 5)', () => {
  // The short ID (the first 8 characters) of ENV_ID, and a free one.
  const TAKEN = '3f2a9c1e-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const FREE = '5e5e5e5e-0000-4000-8000-000000000005';

  it('is not one whose short ID an environment of the registry has (its images and names would be shared)', async () => {
    const ids = vi.fn().mockReturnValueOnce(TAKEN).mockReturnValue(FREE);
    recreate({ newEnvironmentId: ids });
    await seedEnvironment(h, { repository: 'acme/web' });
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).toBe(FREE);
    expect(ids).toHaveBeenCalledTimes(2);
  });

  it('is not one whose volume exists, and that volume is never touched', async () => {
    const ids = vi.fn().mockReturnValueOnce(TAKEN).mockReturnValue(FREE);
    recreate({ newEnvironmentId: ids });
    const existing = resourceName(REPO, TAKEN);
    h.docker.volumes.set(existing, {});
    h.helper.cloneError = new Error('clone failed');
    await expect(h.service.open(TARGET, options())).rejects.toBeDefined();
    // The failed first open removed only what it created.
    expect(h.docker.volumes.get(existing)).toEqual({});
    expect(h.docker.log).toContain(`volume rm ${resourceName(REPO, FREE)}`);
    expect(h.docker.log).not.toContain(`volume rm ${existing}`);
  });

  it('gives up after a few IDs in use, before anything is created', async () => {
    const ids = vi.fn(() => TAKEN);
    recreate({ newEnvironmentId: ids });
    await seedEnvironment(h, { repository: 'acme/web' });
    await expect(h.service.open(TARGET, options())).rejects.toThrow(/No unused environment ID was found/);
    expect(ids.mock.calls.length).toBeGreaterThan(1);
    expect(ids.mock.calls.length).toBeLessThanOrEqual(10);
    expect((await h.registry.list()).map((entry) => entry.repository)).toEqual(['acme/web']);
    expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([]);
  });
});
