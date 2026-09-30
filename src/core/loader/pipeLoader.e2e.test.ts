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
import { LOADER_BUNDLE_TIMEOUT_MS, LOADER_EXIT_CODE, MAX_BUNDLE_LINE_LENGTH, bundleHash, encodeBundle, loaderCommand, readableStderr } from './pipeLoader';

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

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('exits 3 when the input ends before the first line', { timeout: 30_000 }, async () => {
    // Review round 1 of PR #69 (A-R1-1): changed expectation (before: one path for all cases): a new path per case, as
    // the marker of the first start makes a second start on the same path exit at once (its own test below).
    for (const input of ['', JSON.stringify(START_BUNDLE)]) {
      const file = newPath();
      const ended = await load(file, bundleHash(START_BUNDLE), 'start', input);
      expect(ended.code).toBe(LOADER_EXIT_CODE);
      expect(ended.stderr).toBe('devenv loader: the input ended before the bundle\n');
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('exits 3 for a first line that is no JSON string', { timeout: 30_000 }, async () => {
    // Review round 1 of PR #69 (A-R1-1): changed expectation (before: one path for all cases): a new path per case (the
    // marker of the first start).
    for (const line of ['{"start":1}', '42', 'null', 'not json', '"unterminated']) {
      const file = newPath();
      const ended = await load(file, bundleHash(line), 'start', `${line}\n`);
      expect(ended.code, line).toBe(LOADER_EXIT_CODE);
      expect(ended.stderr, line).toBe('devenv loader: the bundle does not match its hash\n');
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it('exits 3 for a first line longer than MAX_BUNDLE_LINE_LENGTH, with or without its line feed', { timeout: 30_000 }, async () => {
    // Review round 1 of PR #69 (A-R1-1): changed expectation (before: one path for both cases): a new path per case (the
    // marker of the first start).
    const file = newPath();
    const long = `"${'a'.repeat(MAX_BUNDLE_LINE_LENGTH)}"`;
    // Without a line feed, and the input stays open: the loader does not wait for more.
    const open = startLoader(file, bundleHash('a'), 'start');
    open.write(long);
    const ended = await open.ended;
    open.end();
    expect(ended.code).toBe(LOADER_EXIT_CODE);
    expect(ended.stderr).toBe('devenv loader: the bundle is too long\n');
    expect(fs.existsSync(file)).toBe(false);
    const other = newPath();
    const whole = await load(other, bundleHash('a'.repeat(MAX_BUNDLE_LINE_LENGTH)), 'start', `${long}\n`);
    expect(whole.code).toBe(LOADER_EXIT_CODE);
    expect(whole.stderr).toBe('devenv loader: the bundle is too long\n');
    expect(fs.existsSync(other)).toBe(false);
  });

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('exits 3 when the bundle has no such function or cannot be loaded', { timeout: 30_000 }, async () => {
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

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('exits 3 for invalid arguments before it reads anything', { timeout: 30_000 }, async () => {
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
    // Review round 1 of PR #69 (A-R1-1): the marker of the first start is there and does not stop the resume.
    expect(fs.existsSync(`${file}.started`)).toBe(true);
  });

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('review round 1 of PR #69 (A-R1-1): a second start without a stored bundle exits 3 at once, also with its input open', { timeout: 45_000 }, async () => {
    const file = newPath();
    const hash = bundleHash(START_BUNDLE);
    // The first start: its input ended before the bundle (the attached client was cut off).
    const first = await load(file, hash, 'start', '');
    expect(first.stderr).toBe('devenv loader: the input ended before the bundle\n');
    expect(fs.existsSync(`${file}.started`)).toBe(true);
    // The restart: a new input without a writer that never ends. The loader does not wait for it (60 s before).
    const startedAt = Date.now();
    const again = startLoader(file, hash, 'start');
    const ended = await again.ended;
    again.end();
    expect(ended).toEqual({ code: LOADER_EXIT_CODE, stdout: '', stderr: 'devenv loader: started before without its bundle\n' });
    // PR #69 review round 6, A-R6-3: changed expectation (before: below 4 s, which a loaded machine can exceed): still far
    // below the wait for a bundle, so it proves that the loader does not wait for this input.
    expect(Date.now() - startedAt).toBeLessThan(LOADER_BUNDLE_TIMEOUT_MS / 2);
    expect(fs.existsSync(file)).toBe(false);
    // The same with a stored file of another hash (changed in the container): never read from an input again.
    fs.writeFileSync(file, 'exports.start = () => process.stdout.write("changed");');
    const changed = startLoader(file, hash, 'start');
    changed.write(encodeBundle(START_BUNDLE));
    const refused = await changed.ended;
    changed.end();
    expect(refused).toEqual({ code: LOADER_EXIT_CODE, stdout: '', stderr: 'devenv loader: started before without its bundle\n' });
  });

  it('review round 1 of PR #69 (A-R1-1): a valid stored bundle still resumes with the marker present', async () => {
    const file = newPath();
    const hash = bundleHash(START_BUNDLE);
    expect((await load(file, hash, 'start', '')).code).toBe(LOADER_EXIT_CODE);
    expect(fs.existsSync(`${file}.started`)).toBe(true);
    // The script came some other way (a later load of the same container is not possible; here written directly).
    fs.writeFileSync(file, START_BUNDLE);
    const again = startLoader(file, hash, 'start');
    const ended = await again.ended;
    again.end();
    expect(ended).toEqual({ code: 0, stdout: 'started "" null', stderr: '' });
  });

  it('review round 1 of PR #69 (A-R1-1): exits 3 when the marker cannot be written', async () => {
    const file = newPath();
    // The folder of the bundle is a file: neither the folder nor the marker can be created.
    fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.dirname(file), 'not a folder');
    const running = startLoader(file, bundleHash(START_BUNDLE), 'start');
    const ended = await running.ended;
    running.end();
    expect(ended.code).toBe(LOADER_EXIT_CODE);
    expect(ended.stderr).toMatch(/^devenv loader: the bundle cannot be stored: .+\n$/);
  });

  it('review round 1 of PR #69 (A-R1-3): an entry that throws exits 3 with one line, never the source of the bundle', async () => {
    const throwing = `exports.start = () => { throw new Error('boom'); }; // ${'x'.repeat(5_000)}`;
    const ended = await load(newPath(), bundleHash(throwing), 'start', encodeBundle(throwing));
    expect(ended).toEqual({ code: LOADER_EXIT_CODE, stdout: '', stderr: 'devenv loader: the entry failed: boom\n' });
  });

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('B-R2-3: an entry that throws something that is no Error (undefined, null) still exits 3 with one line', { timeout: 30_000 }, async () => {
    for (const thrown of ['undefined', 'null']) {
      const throwing = `exports.start = () => { throw ${thrown}; }; // ${'x'.repeat(5_000)}`;
      const ended = await load(newPath(), bundleHash(throwing), 'start', encodeBundle(throwing));
      expect(ended, thrown).toEqual({ code: LOADER_EXIT_CODE, stdout: '', stderr: `devenv loader: the entry failed: ${thrown}\n` });
    }
  });

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('review round 2 of PR #69 (A-R2-3): the source excerpt of an asynchronous uncaught error of a multi-line bundle is not in readableStderr', { timeout: 30_000 }, async () => {
    for (const [thrown, shown] of [
      ['new TypeError("not a secret: " + 7)', 'TypeError: not a secret: 7'],
      ['42', '42'],
    ] as const) {
      // A bundle of many lines (as template literals keep their line feeds); its line 2 throws later, outside the entry.
      const SECRET = 'SECRET-cf1d2e3a';
      const bundle = [
        `exports.start = () => {`,
        `  setTimeout(() => { const secret = "${SECRET}"; if (secret) throw ${thrown}; }, 1); };`,
        `const text = \`${'line\n'.repeat(20)}\`;`,
      ].join('\n');
      const file = newPath();
      const ended = await load(file, bundleHash(bundle), 'start', encodeBundle(bundle));
      expect(fs.readFileSync(file, 'utf8')).toBe(bundle);
      expect(ended.code, thrown).toBe(1);
      expect(ended.stderr).toContain(SECRET);
      const tail = ended.stderr.slice(-4_000);
      const readable = readableStderr(tail, 4_000);
      expect(readable, thrown).not.toContain(SECRET);
      expect(readable).toContain(`${file}:2`);
      expect(readable.split('\n')).toContain(shown);
    }
  });

  it('review round 1 of PR #69 (B-R1-1): exits 3 when no bundle comes within 60 s while the input stays open', { timeout: 90_000 }, async () => {
    const startedAt = Date.now();
    const running = startLoader(newPath(), bundleHash('x'), 'start');
    const ended = await running.ended;
    running.end();
    expect(ended.code).toBe(LOADER_EXIT_CODE);
    expect(ended.stderr).toBe('devenv loader: no bundle within 60 s\n');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(59_000);
  });

  it('review round 1 of PR #69 (B-R1-5): a first line of exactly MAX_BUNDLE_LINE_LENGTH loads, also with its line feed later; one more is refused', { timeout: 60_000 }, async () => {
    const head = 'exports.start=()=>process.stdout.write(String.fromCharCode(111,107));//';
    const bundle = head + 'a'.repeat(MAX_BUNDLE_LINE_LENGTH - 2 - head.length);
    const line = encodeBundle(bundle);
    expect(line.length - 1).toBe(MAX_BUNDLE_LINE_LENGTH);
    const ok = startLoader(newPath(), bundleHash(bundle), 'start');
    ok.write(line.slice(0, -1));
    await new Promise((resolve) => setTimeout(resolve, 500));
    ok.write('\n');
    ok.end();
    expect(await ok.ended).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    const longer = `${bundle}a`;
    const refused = await load(newPath(), bundleHash(longer), 'start', encodeBundle(longer));
    expect(refused.code).toBe(LOADER_EXIT_CODE);
    expect(refused.stderr).toBe('devenv loader: the bundle is too long\n');
  });

  it('review round 1 of PR #69 (B-R1-5): exactly MAX_BUNDLE_LINE_LENGTH characters without a line feed are not too long', { timeout: 60_000 }, async () => {
    const running = startLoader(newPath(), bundleHash('a'), 'start');
    running.write('a'.repeat(MAX_BUNDLE_LINE_LENGTH));
    running.end();
    const ended = await running.ended;
    expect(ended.code).toBe(LOADER_EXIT_CODE);
    expect(ended.stderr).toBe('devenv loader: the input ended before the bundle\n');
  });

  it('review round 1 of PR #69 (B-R1-6): the bundle replaces the file at the path by a rename, never writes into what is there', async () => {
    const file = newPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const other = path.join(path.dirname(file), 'other.js');
    fs.writeFileSync(other, 'old');
    fs.symlinkSync(other, file);
    const ended = await load(file, bundleHash(START_BUNDLE), 'start', encodeBundle(START_BUNDLE));
    expect(ended).toEqual({ code: 0, stdout: 'started "" false', stderr: '' });
    expect(fs.readFileSync(other, 'utf8')).toBe('old');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(START_BUNDLE);
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
