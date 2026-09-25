// Image update check (concept 7.7, implementation notes 9): the references of a configuration,
// their current digests, and the comparison with the build record.
import { errorMessage } from '../errors';
import { abortError, silentLogger, type Logger } from '../ports';
import type { BuildRecord, DevcontainerConfig } from '../types';
import { extractBaseImages } from './dockerfile';
import { hasDigest, isOciFeatureReference, parseFeatureReference, parseImageReference, registryDisplayName } from './reference';
import type { DigestResult, RegistryClient } from './registryClient';

/** Common time limit of all requests of one check (NFR-08). */
export const IMAGE_CHECK_TIMEOUT_MS = 5000;

/** References of a configuration, as written in the configuration (Dockerfile references with ARG values applied). */
export interface ConfigReferences {
  images: string[];
  features: string[];
}

/**
 * `image`; each FROM image of the Dockerfile (ARG values from `build.args` and the ARG defaults, stages up to
 * `build.target`); each Feature key that is an OCI reference. References with a digest (`@sha256:…`) are skipped,
 * because they never change. In a Dockerfile configuration, `image` is not checked: the Dev Container CLI then uses it
 * only as the name of the built image, not as a base image.
 */
export function collectReferences(config: DevcontainerConfig, dockerfileText?: string): ConfigReferences {
  const images: string[] = [];
  const usesDockerfile =
    dockerfileText !== undefined || config.dockerFile !== undefined || (isRecord(config.build) && config.build.dockerfile !== undefined);
  if (!usesDockerfile && typeof config.image === 'string' && config.image.trim() !== '') images.push(config.image.trim());
  if (dockerfileText !== undefined) {
    const build: { args?: unknown; target?: unknown } = isRecord(config.build) ? config.build : {};
    const args: Record<string, string> = {};
    if (isRecord(build.args)) {
      for (const [name, value] of Object.entries(build.args)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') args[name] = String(value);
      }
    }
    const target = typeof build.target === 'string' && build.target !== '' ? build.target : undefined;
    images.push(...extractBaseImages(dockerfileText, args, { target }));
  }
  const features = isRecord(config.features) ? Object.keys(config.features).filter(isOciFeatureReference) : [];
  return {
    images: uniqueWithoutDigest(images),
    features: uniqueWithoutDigest(features),
  };
}

export type CheckOutcome =
  | {
      status: 'checked';
      /** Reference → current digest. */
      images: Record<string, string>;
      /** Feature reference → current digest. */
      features: Record<string, string>;
      /** Registries that require a sign-in (registry hosts, Docker Hub is `registry-1.docker.io`). */
      authRequired: string[];
      /** References without a current digest (not found, sign-in required, invalid, other errors). */
      failed: string[];
    }
  | {
      status: 'unreachable';
      /** Registries that could not be reached or did not answer in time. */
      registries: string[];
    };

export type CheckedOutcome = Extract<CheckOutcome, { status: 'checked' }>;

interface Entry {
  kind: 'image' | 'feature';
  reference: string;
}

/** Runs the digest requests of one check. */
export class ImageChecker {
  constructor(
    private readonly client: RegistryClient,
    private readonly logger: Logger = silentLogger,
  ) {}

  /**
   * All digest requests in parallel, under one AbortController with `timeoutMs` (default 5000, NFR-08). This limit
   * includes token requests and credential helper calls. If any registry cannot be reached or does not answer in time,
   * the result is `{ status: 'unreachable' }` (FR-13): the caller skips the whole update step. The check then ends at
   * once, without waiting for the other requests. Rejects with an AbortError when `signal` aborts.
   */
  async check(references: ConfigReferences, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CheckOutcome> {
    const external = options.signal;
    if (external?.aborted) throw abortError();
    const entries: Entry[] = [
      ...unique(references.images).map((reference): Entry => ({ kind: 'image', reference })),
      ...unique(references.features).map((reference): Entry => ({ kind: 'feature', reference })),
    ];
    const outcome: CheckedOutcome = { status: 'checked', images: {}, features: {}, authRequired: [], failed: [] };
    if (entries.length === 0) return outcome;

    const controller = new AbortController();
    let stopReason: 'timeout' | 'unreachable' | 'cancelled' | undefined;
    const stop = (reason: 'timeout' | 'unreachable' | 'cancelled') => {
      if (stopReason) return;
      stopReason = reason;
      controller.abort();
    };
    const stopped = new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? IMAGE_CHECK_TIMEOUT_MS);
    const onExternalAbort = () => stop('cancelled');
    external?.addEventListener('abort', onExternalAbort, { once: true });
    const unreachable = new Set<string>();

    try {
      const results = await Promise.all(
        entries.map(async (entry) => {
          const parsed = entry.kind === 'feature' ? parseFeatureReference(entry.reference) : parseImageReference(entry.reference);
          if (!parsed) return { entry, result: undefined };
          // The race makes the time limit hold also if a request does not react to the abort.
          const result: DigestResult = await Promise.race([
            this.client.getDigest(parsed, controller.signal).catch(
              (error: unknown): DigestResult => ({ kind: 'error', registry: parsed.registry, error: errorMessage(error) }),
            ),
            stopped.then((): DigestResult => ({ kind: 'unreachable', registry: parsed.registry, error: 'No answer in time.' })),
          ]);
          if (result.kind === 'unreachable') {
            // After an early stop, the other requests end as unreachable, too; they do not count.
            if (stopReason === undefined || stopReason === 'timeout') unreachable.add(result.registry);
            if (stopReason === undefined) {
              this.logger.info(`Image check: ${registryDisplayName(result.registry)} is not reachable: ${result.error}`);
            }
            stop('unreachable');
          }
          return { entry, result };
        }),
      );

      if (stopReason === 'cancelled') throw abortError();
      if (unreachable.size > 0) {
        const registries = [...unreachable];
        this.logger.info(`Image check skipped. No answer from: ${registries.map(registryDisplayName).join(', ')}`);
        return { status: 'unreachable', registries };
      }

      const authRequired = new Set<string>();
      for (const { entry, result } of results) {
        const target = entry.kind === 'image' ? outcome.images : outcome.features;
        if (!result) {
          outcome.failed.push(entry.reference);
          this.logger.warn(`Image check: ${entry.reference} is not a valid reference and is not checked.`);
        } else if (result.kind === 'digest') {
          target[entry.reference] = result.digest;
          this.logger.info(`Image check: ${entry.reference} → ${result.digest}`);
        } else {
          outcome.failed.push(entry.reference);
          if (result.kind === 'authRequired') authRequired.add(result.registry);
          this.logger.warn(`Image check: no digest for ${entry.reference}: ${describe(result)}`);
        }
      }
      outcome.authRequired = [...authRequired];
      return outcome;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Compares the current digests with the build record (not with the local images, concept 7.7).
 * A reference whose current digest is unknown (failed) counts as unchanged. A reference that is not in the record
 * counts as changed. Without a record, everything counts as changed.
 */
export function compareWithBuildRecord(
  record: BuildRecord | undefined,
  outcome: CheckedOutcome,
): { upToDate: boolean; changedImages: string[]; changedFeatures: string[] } {
  if (!record) {
    return { upToDate: false, changedImages: Object.keys(outcome.images), changedFeatures: Object.keys(outcome.features) };
  }
  const changedImages = changedReferences(record.images, outcome.images);
  const changedFeatures = changedReferences(record.features, outcome.features);
  return { upToDate: changedImages.length === 0 && changedFeatures.length === 0, changedImages, changedFeatures };
}

function changedReferences(recorded: Record<string, string> | undefined, current: Record<string, string>): string[] {
  const changed: string[] = [];
  for (const [reference, digest] of Object.entries(current)) {
    const previous = recorded && Object.prototype.hasOwnProperty.call(recorded, reference) ? recorded[reference] : undefined;
    // Assumption (V-9): the registry returns the same digest for an unchanged tag at each HEAD request with our Accept
    // header (the index digest for images with several architectures), so equal digests mean an unchanged image,
    // also on Apple silicon and with the containerd image store. The build record stores digests of this check.
    if (previous === undefined || previous.toLowerCase() !== digest.toLowerCase()) changed.push(reference);
  }
  return changed;
}

function describe(result: Exclude<DigestResult, { kind: 'digest' }>): string {
  switch (result.kind) {
    case 'authRequired':
      return `${registryDisplayName(result.registry)} requires a sign-in.`;
    case 'notFound':
      return `not found on ${registryDisplayName(result.registry)}.`;
    case 'unreachable':
    case 'error':
      return result.error;
  }
}

function uniqueWithoutDigest(references: string[]): string[] {
  return unique(references.filter((reference) => !hasDigest(reference)));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
