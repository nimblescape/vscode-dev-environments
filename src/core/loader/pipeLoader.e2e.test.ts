// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 3 (pipe loading, user decisions 2026-09-29): the real loader (`node -e PIPE_LOADER <path> <hash> <entry>`)
// in a Node.js process of this computer, with the bundle path in a temporary folder. The same in a real container:
// test/docker/helperChannel.test.ts and test/docker/remoteMonitor.test.ts.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOADER_EXIT_CODE, MAX_BUNDLE_LINE_LENGTH, bundleHash, encodeBundle, loaderCommand } from './pipeLoader';

interface Ended {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Running {
  write(text: string): void;
  end(): void;
  ended: Promise<Ended>;
}

/** Starts the loader with `node` of this computer. */
function startLoader(file: string, hash: string, entry: string): Running {
  const [, ...args] = loaderCommand({ path: file, hash, entry });
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
  child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
  child.stdin.on('error', () => {});
  const ended = new Promise<Ended>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return {
    write: (text) => void child.stdin.write(text),
    end: () => child.stdin.end(),
    ended,
  };
}

/** Starts the loader, writes `input`, ends the input, and waits for its end. */
async function load(file: string, hash: string, entry: string, input: string): Promise<Ended> {
  const running = startLoader(file, hash, entry);
  running.write(input);
  running.end();
  return running.ended;
}

/**
 * A bundle whose `start` prints what it got: the rest of the input that the loader read, all later input, the state of
 * the standard input when it was called (null: never read; false: paused), and its encoding.
 */
const ECHO_BUNDLE = [
  'exports.start = (rest) => {',
  '  const flowing = process.stdin.readableFlowing;',
  '  const encoding = process.stdin.readableEncoding;',
  '  let later = "";',
  '  process.stdin.on("data", (d) => (later += d));',
  '  process.stdin.on("end", () => process.stdout.write(JSON.stringify({ rest, later, flowing, encoding })));',
  '  process.stdin.resume();',
  '};',
].join('\n');

/** A bundle that says it was started and does not read its input. */
const START_BUNDLE = 'exports.start = (rest) => { process.stdout.write("started " + JSON.stringify(rest) + " " + process.stdin.readableFlowing); };\n';

describe('the pipe loader in a Node.js process (plan step 3)', () => {
  let dir = '';
  let count = 0;
  /** A new bundle path in a folder that does not exist yet. */
  const newPath = () => path.join(dir, `case-${++count}`, 'devenv', 'bundle.js');
  const leftovers = (file: string) => (fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')) : []);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-loader-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores the bundle, calls the entry with the rest of the input, and hands the paused input over', async () => {
    const file = newPath();
    const running = startLoader(file, bundleHash(ECHO_BUNDLE), 'start');
    running.write(`${encodeBundle(ECHO_BUNDLE)}first`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    running.write(' second\nthird');
    running.end();
    const ended = await running.ended;
    expect(ended.stderr).toBe('');
    expect(ended.code).toBe(0);
    const seen = JSON.parse(ended.stdout) as { rest: string; later: string; flowing: boolean | null; encoding: string };
    // Everything after the first line reaches the bundle once, in order, as text.
    expect(seen.rest + seen.later).toBe('first second\nthird');
    expect(seen.flowing).toBe(false);
    expect(seen.encoding).toBe('utf8');
    expect(fs.readFileSync(file, 'utf8')).toBe(ECHO_BUNDLE);
    // Atomic: no temporary file stays.
    expect(leftovers(file)).toEqual([]);
  });

  it('refuses a bundle with another hash: exit 3, nothing stored', async () => {
    const file = newPath();
    const ended = await load(file, bundleHash('another bundle'), 'start', encodeBundle(START_BUNDLE));
    expect(ended.code).toBe(LOADER_EXIT_CODE);
    expect(ended.stderr).toBe('devenv loader: the bundle does not match its hash\n');
    expect(ended.stdout).toBe('');
    expect(fs.existsSync(file)).toBe(false);
    expect(leftovers(file)).toEqual([]);
  });

  it('exits 3 when the input ends before the first line', async () => {
    const file = newPath();
    for (const input of ['', JSON.stringify(START_BUNDLE)]) {
      const ended = await load(file, bundleHash(START_BUNDLE), 'start', input);
      expect(ended.code).toBe(LOADER_EXIT_CODE);
      expect(ended.stderr).toBe('devenv loader: the input ended before the bundle\n');
    }
    expect(fs.existsSync(file)).toBe(false);
  });

  it('exits 3 for a first line that is no JSON string', async () => {
    const file = newPath();
    for (const line of ['{"start":1}', '42', 'null', 'not json', '"unterminated']) {
      const ended = await load(file, bundleHash(line), 'start', `${line}\n`);
      expect(ended.code, line).toBe(LOADER_EXIT_CODE);
      expect(ended.stderr, line).toBe('devenv loader: the bundle does not match its hash\n');
    }
    expect(fs.existsSync(file)).toBe(false);
  });

  it('exits 3 for a first line longer than MAX_BUNDLE_LINE_LENGTH, with or without its line feed', { timeout: 30_000 }, async () => {
    const file = newPath();
    const long = `"${'a'.repeat(MAX_BUNDLE_LINE_LENGTH)}"`;
    // Without a line feed, and the input stays open: the loader does not wait for more.
    const open = startLoader(file, bundleHash('a'), 'start');
    open.write(long);
    const ended = await open.ended;
    open.end();
    expect(ended.code).toBe(LOADER_EXIT_CODE);
    expect(ended.stderr).toBe('devenv loader: the bundle is too long\n');
    const whole = await load(file, bundleHash('a'.repeat(MAX_BUNDLE_LINE_LENGTH)), 'start', `${long}\n`);
    expect(whole.code).toBe(LOADER_EXIT_CODE);
    expect(whole.stderr).toBe('devenv loader: the bundle is too long\n');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('exits 3 when the bundle has no such function or cannot be loaded', async () => {
    const noEntry = 'exports.other = () => {};';
    const ended = await load(newPath(), bundleHash(noEntry), 'start', encodeBundle(noEntry));
    expect(ended.code).toBe(LOADER_EXIT_CODE);
    expect(ended.stderr).toBe('devenv loader: the bundle has no function start\n');
    const notAFunction = 'exports.start = 1;';
    expect((await load(newPath(), bundleHash(notAFunction), 'start', encodeBundle(notAFunction))).code).toBe(LOADER_EXIT_CODE);
    const broken = 'this is not javascript (';
    const failed = await load(newPath(), bundleHash(broken), 'start', encodeBundle(broken));
    expect(failed.code).toBe(LOADER_EXIT_CODE);
    expect(failed.stderr).toMatch(/^devenv loader: the bundle cannot be loaded: .+\n$/);
  });

  it('exits 3 for invalid arguments before it reads anything', async () => {
    const hash = bundleHash(START_BUNDLE);
    for (const [file, sha, entry] of [
      [newPath(), 'abc', 'start'],
      [newPath(), hash.toUpperCase(), 'start'],
      ['relative/bundle.js', hash, 'start'],
      [newPath(), hash, 'start2'],
      [newPath(), hash, ''],
    ]) {
      const ended = await load(file, sha, entry, encodeBundle(START_BUNDLE));
      expect(ended.code, `${file} ${sha} ${entry}`).toBe(LOADER_EXIT_CODE);
      expect(ended.stderr).toBe('devenv loader: invalid arguments\n');
    }
  });

  it('resumes from a stored file with the right hash without reading its input', async () => {
    const file = newPath();
    const hash = bundleHash(START_BUNDLE);
    const first = await load(file, hash, 'start', encodeBundle(START_BUNDLE));
    expect(first).toEqual({ code: 0, stdout: 'started "" false', stderr: '' });
    // A restart: the input stays open and holds something that is no bundle; the loader never reads it.
    const again = startLoader(file, hash, 'start');
    again.write('garbage that is not read\n');
    const ended = await again.ended;
    again.end();
    expect(ended).toEqual({ code: 0, stdout: 'started "" null', stderr: '' });
  });

  it('replaces a stored file with another hash by the bundle from its input', async () => {
    const file = newPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'exports.start = () => process.stdout.write("tampered");');
    const ended = await load(file, bundleHash(START_BUNDLE), 'start', `${encodeBundle(START_BUNDLE)}rest`);
    expect(ended).toEqual({ code: 0, stdout: 'started "rest" false', stderr: '' });
    expect(fs.readFileSync(file, 'utf8')).toBe(START_BUNDLE);
    expect(leftovers(file)).toEqual([]);
  });

  it('loads a bundle of 2 MB with quotes, backslashes, line feeds and non-ASCII characters', { timeout: 30_000 }, async () => {
    const file = newPath();
    const filler = 'a "quoted" \\ back\nslash ä € 😀 '.repeat(Math.ceil((2 * 1024 * 1024) / 30));
    const bundle = `${START_BUNDLE}/*${filler}*/\n`;
    expect(bundle.length).toBeGreaterThan(2 * 1024 * 1024);
    const ended = await load(file, bundleHash(bundle), 'start', encodeBundle(bundle));
    expect(ended).toEqual({ code: 0, stdout: 'started "" false', stderr: '' });
    expect(fs.readFileSync(file, 'utf8')).toBe(bundle);
    expect(leftovers(file)).toEqual([]);
  });
});
