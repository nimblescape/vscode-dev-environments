// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { PIPE_LOADER, encodeBundle } from '../loader/pipeLoader';
import type { StateEnvironment } from '../pipeline/refreshStates';
import { ENV_API, ENV_WEB, EXPECTED_STATES, REFRESH_ENVIRONMENTS } from '../pipeline/refreshStates.testkit';
import {
  CHANNEL_ENTRY,
  CHANNEL_SCRIPT_PATH,
  CHANNEL_SILENCE_EXIT_MS,
  CHANNEL_PING_INTERVAL_MS,
  CHANNEL_PONG_TIMEOUT_MS,
  CHANNEL_IDLE_CLOSE_MS,
  CHANNEL_SERVER_IDLE_EXIT_MS,
  LineSplitter,
  MAX_CLIENT_LINE,
  MAX_SECRET_LENGTH,
  MAX_REFRESH_BRANCH_LENGTH,
  MAX_REFRESH_ENVIRONMENTS,
  parseRefreshParams,
  parseRefreshValue,
  refreshValue,
  channelLabelValue,
  channelStepLabel,
  isCleanupLabel,
  newCleanupLabel,
  encodeMessage,
  parseClientMessage,
  parseDockerOperationParams,
  parseDockerOperationValue,
  engineIdentity,
  parseProbeValue,
  parseServerMessage,
  refusedOperationId,
} from './protocol';

describe('the protocol of the helper channel (user request 2026-09-28)', () => {
  it('keeps the times in the order that makes the script end by itself and the extension notice a loss first', () => {
    // Several pings fit into the silence, so a lost ping or two does not end a working channel.
    expect(CHANNEL_SILENCE_EXIT_MS).toBeGreaterThanOrEqual(3 * CHANNEL_PING_INTERVAL_MS);
    // The extension gives up on the script before the script gives up on the extension. Review round 1 (P3): the loss is
    // checked at each ping, so it is noticed at most one interval after the pong timeout.
    expect(CHANNEL_PONG_TIMEOUT_MS + CHANNEL_PING_INTERVAL_MS).toBeLessThan(CHANNEL_SILENCE_EXIT_MS);
    expect(CHANNEL_PONG_TIMEOUT_MS).toBeGreaterThan(CHANNEL_PING_INTERVAL_MS);
    // The script's own idle limit is a backstop behind the extension's.
    expect(CHANNEL_SERVER_IDLE_EXIT_MS).toBeGreaterThan(CHANNEL_IDLE_CLOSE_MS);
  });

  it('parses the messages of the extension strictly', () => {
    expect(parseClientMessage('{"t":"hello","protocol":1}')).toEqual({ t: 'hello', protocol: 1 });
    expect(parseClientMessage('{"t":"ping","n":3}')).toEqual({ t: 'ping', n: 3 });
    expect(parseClientMessage('{"t":"cancel","id":2}')).toEqual({ t: 'cancel', id: 2 });
    expect(parseClientMessage('{"t":"op","id":1,"op":"docker","params":{"args":["ps"]},"secret":"s3cr","timeoutMs":5}')).toEqual({
      t: 'op',
      id: 1,
      op: 'docker',
      params: { args: ['ps'] },
      secret: 's3cr',
      timeoutMs: 5,
    });
    for (const line of [
      'not json',
      '[]',
      '{"t":"hello","protocol":-1}',
      '{"t":"hello","protocol":1,"x":1}',
      '{"t":"op","id":1,"op":"Bad-Name","params":null}',
      '{"t":"op","id":1.5,"op":"docker","params":null}',
      '{"t":"op","id":1,"op":"docker"}',
      '{"t":"op","id":1,"op":"docker","params":null,"timeoutMs":0}',
      `{"t":"op","id":1,"op":"docker","params":null,"secret":"${'x'.repeat(MAX_SECRET_LENGTH + 1)}"}`,
      // Review round 1 (S6): a secret too short to be masked.
      '{"t":"op","id":1,"op":"docker","params":null,"secret":"abc"}',
      '{"t":"op","id":1,"op":"docker","params":null,"secret":""}',
      '{"t":"quit"}',
    ]) {
      expect(parseClientMessage(line), line.slice(0, 60)).toBeUndefined();
    }
    expect(parseClientMessage(`{"t":"ping","n":1,"pad":"${'x'.repeat(MAX_CLIENT_LINE)}"}`)).toBeUndefined();
    expect(refusedOperationId('{"t":"op","id":7,"op":"Bad"}')).toBe(7);
    expect(refusedOperationId('{"t":"ping","id":7}')).toBeUndefined();
  });

  it('parses the messages of the script strictly', () => {
    expect(parseServerMessage('{"t":"hello","protocol":1,"node":"v24","ops":["docker"]}')).toEqual({ t: 'hello', protocol: 1, node: 'v24', ops: ['docker'] });
    expect(parseServerMessage('{"t":"progress","id":1,"step":"Cloning"}')).toEqual({ t: 'progress', id: 1, step: 'Cloning' });
    // Review round 4 (M2): the confirmation of a cancel.
    expect(parseServerMessage('{"t":"cancelled","id":4}')).toEqual({ t: 'cancelled', id: 4 });
    expect(parseServerMessage('{"t":"cancelled","id":4,"x":1}')).toBeUndefined();
    expect(parseServerMessage('{"t":"log","id":1,"level":"warn","text":"x"}')).toEqual({ t: 'log', id: 1, level: 'warn', text: 'x' });
    expect(parseServerMessage('{"t":"out","id":1,"stream":"stderr","data":"x"}')).toEqual({ t: 'out', id: 1, stream: 'stderr', data: 'x' });
    expect(parseServerMessage('{"t":"result","id":1,"ok":true,"value":{"a":1}}')).toEqual({ t: 'result', id: 1, ok: true, value: { a: 1 } });
    expect(parseServerMessage('{"t":"result","id":1,"ok":false,"error":{"code":"c","message":"m"},"cancelled":true,"timedOut":false}')).toEqual({
      t: 'result',
      id: 1,
      ok: false,
      error: { code: 'c', message: 'm' },
      cancelled: true,
      timedOut: false,
    });
    for (const line of [
      '{"t":"hello","protocol":1,"node":"v24","ops":["Bad Op"]}',
      '{"t":"log","id":1,"level":"error","text":"x"}',
      '{"t":"out","id":1,"stream":"stdin","data":"x"}',
      '{"t":"result","id":1,"ok":false,"error":{"code":"c"},"cancelled":true,"timedOut":false}',
      '{"t":"result","id":1,"ok":"yes"}',
      '{"t":"pong"}',
    ]) {
      expect(parseServerMessage(line), line).toBeUndefined();
    }
  });

  it('encodes a message and the script as one line each', () => {
    expect(encodeMessage({ t: 'log', id: 1, level: 'info', text: 'a\nb' })).toBe('{"t":"log","id":1,"level":"info","text":"a\\nb"}\n');
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: encodeScript of the channel; now encodeBundle of the pipe loader, the same line).
    expect(encodeBundle('line 1\nline 2')).toBe('"line 1\\nline 2"\n');
  });

  it('LineSplitter passes whole lines on and fails once on a line that is too long', () => {
    const lines: string[] = [];
    let tooLong = 0;
    const splitter = new LineSplitter(5, (line) => lines.push(line), () => tooLong++);
    splitter.push('ab');
    splitter.push('c\n\nde\nf');
    expect(lines).toEqual(['abc', 'de']);
    splitter.push('123456');
    expect(tooLong).toBe(1);
    splitter.push('\nok\n');
    expect(lines).toEqual(['abc', 'de']);
  });

  // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: CHANNEL_LOADER held the path and
  // `startChannel`; now the shared pipe loader gets them as arguments, channelRunArgs, and pipeLoader.test.ts checks it).
  it('the loader stores the script at CHANNEL_SCRIPT_PATH and starts CHANNEL_ENTRY', () => {
    expect(CHANNEL_SCRIPT_PATH).toBe('/opt/devenv/channel.js');
    expect(CHANNEL_ENTRY).toBe('startChannel');
    expect(PIPE_LOADER).not.toContain(CHANNEL_SCRIPT_PATH);
    // It is one argument of `docker run`: one line.
    expect(PIPE_LOADER).not.toContain('\n');
  });

  it('the cleanup label: its values, and the label of a step container (review round 1, S1)', () => {
    expect(isCleanupLabel('0a1b2c3d4e5f60718293a4b5')).toBe(true);
    expect(isCleanupLabel('abc123')).toBe(false);
    // Review round 2 (B4): only values of newCleanupLabel (24 hex digits), each new.
    expect(isCleanupLabel('cancel-0a1b2c3d')).toBe(false);
    expect(isCleanupLabel(newCleanupLabel())).toBe(true);
    expect(newCleanupLabel()).not.toBe(newCleanupLabel());
    expect(isCleanupLabel('a'.repeat(65))).toBe(false);
    expect(channelStepLabel('0a1b2c3d')).toBe('nimblescape.devenv.channel-step=0a1b2c3d');
  });

  it('channelLabelValue names the protocol, the script and the loader', () => {
    // Plan step 6, PR B: changed expectation (protocol version 2, before 1).
    expect(channelLabelValue('a')).toMatch(/^2-[0-9a-f]{12}$/);
    expect(channelLabelValue('a')).not.toBe(channelLabelValue('b'));
    // Plan step 3 (pipe loading, user decision 2026-09-29): the loader is part of the label (a new loader, a new version).
    const hash = createHash('sha256').update('a', 'utf8').update('\n', 'utf8').update(PIPE_LOADER, 'utf8').digest('hex');
    // Plan step 6, PR B: changed expectations (protocol version 2, before 1).
    expect(channelLabelValue('a')).toBe(`2-${hash.slice(0, 12)}`);
    expect(channelLabelValue('a')).not.toBe(`2-${createHash('sha256').update('a').digest('hex').slice(0, 12)}`);
  });

  it('checks the parameters and values of docker and probe', () => {
    // Review round 1 (S1): the cleanup is a label value, no longer container names; review round 2 (B4): 24 hex digits.
    expect(parseDockerOperationParams({ args: ['ps'], input: 'x', cleanup: '0a1b2c3d4e5f60718293a4b5' })).toEqual({
      args: ['ps'],
      input: 'x',
      cleanup: '0a1b2c3d4e5f60718293a4b5',
    });
    expect(parseDockerOperationParams({ args: ['exec'], inputIsSecret: true })).toEqual({ args: ['exec'], inputIsSecret: true });
    for (const params of [
      null,
      { args: [] },
      { args: ['a\0b'] },
      { args: ['ps'], extra: 1 },
      { args: ['ps'], input: 'x', inputIsSecret: true },
      { args: ['ps'], cleanup: ['step-0a1b2c3d'] },
      { args: ['ps'], cleanup: 'short' },
      { args: ['ps'], cleanup: '-step-0a1b2c3d' },
      { args: ['ps'], cleanup: 'step-0a1b2c3d4e5f60718293' },
      { args: ['ps'], cleanup: 'Step-0A1B2C3D' },
    ]) {
      expect(parseDockerOperationParams(params), JSON.stringify(params)).toBeUndefined();
    }
    expect(parseDockerOperationValue({ exitCode: null })).toEqual({ exitCode: null });
    expect(parseDockerOperationValue({ exitCode: 1.5 })).toBeUndefined();
    expect(parseProbeValue({ serverVersion: '27', detail: 'd' })).toEqual({ serverVersion: '27', detail: 'd' });
    expect(parseProbeValue({ detail: 3 })).toBeUndefined();
  });

  // Plan step 5, PR A: the engine identity of the probe is checked strictly.
  it('engineIdentity and the engine of ProbeValue', () => {
    const engine = '"7b1c:ABCD" "/var/lib/docker"';
    expect(engineIdentity(`${engine}\n`)).toBe(engine);
    expect(engineIdentity('"" "/var/lib/docker"')).toBeUndefined();
    expect(engineIdentity('"id"')).toBeUndefined();
    expect(engineIdentity('WARNING: x\n"id" "/r"')).toBeUndefined();
    expect(engineIdentity(`"${'a'.repeat(2_000)}" "/r"`)).toBeUndefined();
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine })).toEqual({ serverVersion: '27', detail: 'd', engine });
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine: 3 })).toBeUndefined();
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine: ` ${engine}` })).toBeUndefined();
    expect(parseProbeValue({ serverVersion: '27', detail: 'd', engine: '"id" "/r"', other: 1 })).toBeUndefined();
  });
});

describe('the refresh operation (plan step 5, PR C)', () => {
  const env: StateEnvironment = { id: ENV_API, containerName: 'devenv-api', volumeName: 'devenv-api-vol', folder: '/workspaces/api', branch: true };

  it('accepts at most MAX_REFRESH_ENVIRONMENTS environments of the strict shape', () => {
    expect(parseRefreshParams({ environments: REFRESH_ENVIRONMENTS })).toEqual({ environments: REFRESH_ENVIRONMENTS });
    expect(parseRefreshParams({ environments: [] })).toEqual({ environments: [] });
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ ...env, id: `env-${index}` }));
    expect(parseRefreshParams({ environments: many(MAX_REFRESH_ENVIRONMENTS) })?.environments).toHaveLength(MAX_REFRESH_ENVIRONMENTS);
    expect(parseRefreshParams({ environments: many(MAX_REFRESH_ENVIRONMENTS + 1) })).toBeUndefined();
    expect(parseRefreshParams({ environments: [{ ...env, user: 'node' }] })?.environments[0].user).toBe('node');
    expect(parseRefreshParams({ environments: [{ ...env, user: '1000:1000' }] })).toBeDefined();
  });

  it('refuses anything else', () => {
    for (const value of [
      undefined,
      null,
      [],
      {},
      { environments: {} },
      { environments: [env], other: 1 },
      { environments: [env, env] },
      { environments: [{ ...env, extra: true }] },
      { environments: [{ ...env, id: '../x' }] },
      { environments: [{ ...env, id: '' }] },
      { environments: [{ ...env, containerName: '-e' }] },
      { environments: [{ ...env, containerName: 'a b' }] },
      { environments: [{ ...env, volumeName: '--mount' }] },
      { environments: [{ ...env, volumeName: 3 }] },
      { environments: [{ ...env, user: '' }] },
      { environments: [{ ...env, user: '-u' }] },
      { environments: [{ ...env, user: 'a b' }] },
      { environments: [{ ...env, folder: '/etc' }] },
      { environments: [{ ...env, folder: '/workspaces/..' }] },
      { environments: [{ ...env, folder: '/workspaces/a/b' }] },
      { environments: [{ ...env, folder: 'workspaces/api' }] },
      { environments: [{ ...env, branch: 'yes' }] },
      { environments: [{ id: env.id, containerName: env.containerName, volumeName: env.volumeName, folder: env.folder }] },
    ]) {
      expect(parseRefreshParams(value)).toBeUndefined();
    }
  });

  it('checks the value against its parameters', () => {
    const params = parseRefreshParams({ environments: REFRESH_ENVIRONMENTS })!;
    const value = refreshValue(EXPECTED_STATES);
    expect(parseRefreshValue(JSON.parse(JSON.stringify(value)), params)).toEqual(EXPECTED_STATES);
    const running = { id: ENV_API, container: 'running', volume: true };
    const one = parseRefreshParams({ environments: [env] })!;
    expect(parseRefreshValue({ runtime: [running], branches: [{ id: ENV_API, branch: 'main' }] }, one)).toEqual({
      runtime: new Map([[ENV_API, { container: 'running', volume: true }]]),
      branches: new Map([[ENV_API, 'main']]),
    });
    for (const bad of [
      undefined,
      { runtime: [running] },
      { runtime: [running], branches: [], other: 1 },
      // Missing, duplicate, or unknown environments.
      { runtime: [], branches: [] },
      { runtime: [running, running], branches: [] },
      { runtime: [{ ...running, id: ENV_WEB }], branches: [] },
      // Invalid states.
      { runtime: [{ ...running, container: 'paused' }], branches: [] },
      { runtime: [{ ...running, volume: 'yes' }], branches: [] },
      { runtime: [{ ...running, servicesRunning: false }], branches: [] },
      { runtime: [{ ...running, extra: 1 }], branches: [] },
      // Branches of another environment, of a container that does not run, or invalid names.
      { runtime: [running], branches: [{ id: ENV_WEB, branch: 'main' }] },
      { runtime: [{ ...running, container: 'stopped' }], branches: [{ id: ENV_API, branch: 'main' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: 'main' }, { id: ENV_API, branch: 'main' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: '' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: ' main' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: 'a\nb' }] },
      { runtime: [running], branches: [{ id: ENV_API, branch: 'b'.repeat(MAX_REFRESH_BRANCH_LENGTH + 1) }] },
    ]) {
      expect(parseRefreshValue(bad, one)).toBeUndefined();
    }
    // No branch of an environment whose branch was not asked for.
    const notAsked = parseRefreshParams({ environments: [{ ...env, branch: false }] })!;
    expect(parseRefreshValue({ runtime: [running], branches: [{ id: ENV_API, branch: 'main' }] }, notAsked)).toBeUndefined();
  });
});
