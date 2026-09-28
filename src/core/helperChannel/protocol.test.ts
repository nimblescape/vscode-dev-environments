// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_LOADER,
  CHANNEL_SCRIPT_PATH,
  CHANNEL_SILENCE_EXIT_MS,
  CHANNEL_PING_INTERVAL_MS,
  CHANNEL_PONG_TIMEOUT_MS,
  CHANNEL_IDLE_CLOSE_MS,
  CHANNEL_SERVER_IDLE_EXIT_MS,
  LineSplitter,
  MAX_CLIENT_LINE,
  MAX_SECRET_LENGTH,
  channelLabelValue,
  encodeMessage,
  encodeScript,
  parseClientMessage,
  parseDockerOperationParams,
  parseDockerOperationValue,
  parseProbeValue,
  parseServerMessage,
  refusedOperationId,
} from './protocol';

describe('the protocol of the helper channel (user request 2026-09-28)', () => {
  it('keeps the times in the order that makes the script end by itself and the extension notice a loss first', () => {
    // Several pings fit into the silence, so a lost ping or two does not end a working channel.
    expect(CHANNEL_SILENCE_EXIT_MS).toBeGreaterThanOrEqual(3 * CHANNEL_PING_INTERVAL_MS);
    // The extension gives up on the script before the script gives up on the extension.
    expect(CHANNEL_PONG_TIMEOUT_MS).toBeLessThan(CHANNEL_SILENCE_EXIT_MS);
    expect(CHANNEL_PONG_TIMEOUT_MS).toBeGreaterThan(CHANNEL_PING_INTERVAL_MS);
    // The script's own idle limit is a backstop behind the extension's.
    expect(CHANNEL_SERVER_IDLE_EXIT_MS).toBeGreaterThan(CHANNEL_IDLE_CLOSE_MS);
  });

  it('parses the messages of the extension strictly', () => {
    expect(parseClientMessage('{"t":"hello","protocol":1}')).toEqual({ t: 'hello', protocol: 1 });
    expect(parseClientMessage('{"t":"ping","n":3}')).toEqual({ t: 'ping', n: 3 });
    expect(parseClientMessage('{"t":"cancel","id":2}')).toEqual({ t: 'cancel', id: 2 });
    expect(parseClientMessage('{"t":"op","id":1,"op":"docker","params":{"args":["ps"]},"secret":"s","timeoutMs":5}')).toEqual({
      t: 'op',
      id: 1,
      op: 'docker',
      params: { args: ['ps'] },
      secret: 's',
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
    expect(encodeScript('line 1\nline 2')).toBe('"line 1\\nline 2"\n');
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

  it('the loader writes the script to CHANNEL_SCRIPT_PATH and gives up on an input without it', () => {
    expect(CHANNEL_LOADER).toContain(JSON.stringify(CHANNEL_SCRIPT_PATH));
    expect(CHANNEL_LOADER).toContain('startChannel');
    expect(CHANNEL_LOADER).toContain('process.exit(3)');
    // It is one argument of `docker run`: short, one line.
    expect(CHANNEL_LOADER.length).toBeLessThan(1_000);
    expect(CHANNEL_LOADER).not.toContain('\n');
  });

  it('channelLabelValue names the protocol and the script', () => {
    expect(channelLabelValue('a')).toMatch(/^1-[0-9a-f]{12}$/);
    expect(channelLabelValue('a')).not.toBe(channelLabelValue('b'));
  });

  it('checks the parameters and values of docker and probe', () => {
    expect(parseDockerOperationParams({ args: ['ps'], input: 'x', cleanup: ['a-1'] })).toEqual({ args: ['ps'], input: 'x', cleanup: ['a-1'] });
    expect(parseDockerOperationParams({ args: ['exec'], inputIsSecret: true })).toEqual({ args: ['exec'], inputIsSecret: true });
    for (const params of [
      null,
      { args: [] },
      { args: ['a\0b'] },
      { args: ['ps'], extra: 1 },
      { args: ['ps'], input: 'x', inputIsSecret: true },
      { args: ['ps'], cleanup: ['-rf'] },
      { args: ['ps'], cleanup: ['a b'] },
    ]) {
      expect(parseDockerOperationParams(params), JSON.stringify(params)).toBeUndefined();
    }
    expect(parseDockerOperationValue({ exitCode: null })).toEqual({ exitCode: null });
    expect(parseDockerOperationValue({ exitCode: 1.5 })).toBeUndefined();
    expect(parseProbeValue({ serverVersion: '27', detail: 'd' })).toEqual({ serverVersion: '27', detail: 'd' });
    expect(parseProbeValue({ detail: 3 })).toBeUndefined();
  });
});
