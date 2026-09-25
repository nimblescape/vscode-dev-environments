import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingOperation } from '../core/types';
import {
  DISCONNECT_DIR_NAME,
  DISCONNECT_REQUEST_MAX_AGE_MS,
  DisconnectRequests,
  isFreshDisconnectRequest,
} from './disconnectRequests';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const ENV_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

function request(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    environmentId: ENV_ID,
    operation: 'delete',
    requestedAt: new Date(NOW).toISOString(),
    requestedBy: 'window-2',
    reason: 'manual',
    removeAdditionalVolumes: true,
    ...overrides,
  };
}

let root: string;
let requests: DisconnectRequests;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  requests = new DisconnectRequests(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('DisconnectRequests', () => {
  it('writes a request into disconnect/<environment-id>.json and reads it back', async () => {
    await requests.write(request());
    expect(fs.readdirSync(path.join(root, DISCONNECT_DIR_NAME))).toEqual([`${ENV_ID}.json`]);
    expect(await requests.read(ENV_ID)).toEqual(request());
  });

  it('reads nothing for a missing, invalid, or misplaced file', async () => {
    expect(await requests.read(ENV_ID)).toBeUndefined();
    fs.mkdirSync(requests.dir, { recursive: true });
    fs.writeFileSync(path.join(requests.dir, `${ENV_ID}.json`), '{ "environmentId": ');
    expect(await requests.read(ENV_ID)).toBeUndefined();
    fs.writeFileSync(path.join(requests.dir, `${ENV_ID}.json`), JSON.stringify(request({ environmentId: 'other-id' })));
    expect(await requests.read(ENV_ID)).toBeUndefined();
  });

  it('takes a request only once', async () => {
    await requests.write(request());
    expect(await requests.take(ENV_ID)).toBe(true);
    expect(await requests.take(ENV_ID)).toBe(false);
    expect(await requests.read(ENV_ID)).toBeUndefined();
  });

  it('removes a request, also a missing one', async () => {
    await requests.remove(ENV_ID);
    await requests.write(request());
    await requests.remove(ENV_ID);
    expect(await requests.read(ENV_ID)).toBeUndefined();
  });

  it('refuses an environment ID that is not a file name part', async () => {
    await expect(requests.write(request({ environmentId: '../registry' }))).rejects.toThrow('Invalid environment ID');
  });

  it('calls back when a request is written into the watched folder', async () => {
    let changes = 0;
    const watcher = requests.watch(
      () => changes++,
      (error) => {
        throw error;
      },
    );
    expect(watcher).toBeDefined();
    try {
      await requests.write(request());
      const deadline = Date.now() + 5000;
      while (changes === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(changes).toBeGreaterThan(0);
    } finally {
      watcher?.dispose();
    }
  });
});

describe('isFreshDisconnectRequest', () => {
  it('accepts a request younger than the maximum age, also slightly in the future', () => {
    expect(isFreshDisconnectRequest(request(), NOW)).toBe(true);
    expect(isFreshDisconnectRequest(request(), NOW + DISCONNECT_REQUEST_MAX_AGE_MS)).toBe(true);
    expect(isFreshDisconnectRequest(request(), NOW - 1000)).toBe(true);
  });

  it('rejects an old request, a time far in the future, and an invalid time', () => {
    expect(isFreshDisconnectRequest(request(), NOW + DISCONNECT_REQUEST_MAX_AGE_MS + 1)).toBe(false);
    expect(isFreshDisconnectRequest(request(), NOW - DISCONNECT_REQUEST_MAX_AGE_MS - 1)).toBe(false);
    expect(isFreshDisconnectRequest(request({ requestedAt: 'yesterday' }), NOW)).toBe(false);
  });
});
