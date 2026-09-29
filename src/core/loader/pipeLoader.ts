// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Pipe loading (plan step 3, user decisions 2026-09-29): one mechanism fills our own containers with their code. The
// container runs PIPE_LOADER, a short `node -e` program, with three arguments: the path of the bundle in the container's
// own file system, the sha256 of the bundle, and the name of the exported function to start. The extension writes the
// bundle (a file of the `.vsix`) as the first line of the standard input, as a JSON string (encodeBundle). The loader
// checks its hash, stores it atomically (a temporary file, then a rename), and calls the entry with the rest of the
// input that it read already; the standard input stays paused (UTF-8) and belongs to the bundle from then on.
//
// When the file at the path exists already and has the expected hash (a container that was restarted: `docker start`,
// `docker restart`, a restart policy), the loader starts it without reading the standard input at all. A stored file
// with another hash is replaced by the bundle from the input.
//
// Every failure (invalid arguments, the input ended before the bundle, no bundle within LOADER_BUNDLE_TIMEOUT_MS, a line
// longer than MAX_BUNDLE_LINE_LENGTH, not a JSON string, another hash, the file cannot be stored or loaded, no such
// function) writes one line `devenv loader: …` to stderr and exits with LOADER_EXIT_CODE; nothing of a refused bundle
// is stored. The hash protects against a broken or mixed-up transfer and a changed stored file; it is no defence
// against someone who already has the Docker socket of the engine (who can run anything anyway).
//
// So no code goes into a variable or an argument of the container: the command line holds only the loader, the path,
// the hash, and the entry name, whatever the size of the bundle. Pure functions and constants; no I/O. No `vscode`.
import { createHash } from 'crypto';

/** The exit code of the loader for every failure. */
export const LOADER_EXIT_CODE = 3;
/**
 * The longest first line (the bundle as its JSON string, without the line feed): a guard of the memory of the loader
 * (user decision 2026-09-29), checked by the writer before it writes too.
 */
export const MAX_BUNDLE_LINE_LENGTH = 8 * 1024 * 1024;
/** The loader exits when no complete first line came within this time. */
export const LOADER_BUNDLE_TIMEOUT_MS = 60_000;

/**
 * The program of the container (`node -e PIPE_LOADER <path> <sha256> <entry>`). Only Node.js built-ins, one line.
 * `x`: fail; `h`: sha256 hex over UTF-8; `go`: load the stored file and call its entry with the rest of the input.
 */
export const PIPE_LOADER = [
  `const fs=require('fs'),c=require('crypto'),p=require('path'),[,P,H,E]=process.argv,M=${MAX_BUNDLE_LINE_LENGTH},`,
  `x=t=>{process.stderr.write('devenv loader: '+t+'\\n');process.exit(${LOADER_EXIT_CODE})},`,
  `h=t=>c.createHash('sha256').update(t,'utf8').digest('hex'),`,
  `go=r=>{let f;try{f=require(P)[E]}catch(e){x('the bundle cannot be loaded: '+e.message)}`,
  `typeof f==='function'?f(r):x('the bundle has no function '+E)};`,
  `if(!/^[0-9a-f]{64}$/.test(H||'')||!P||!p.isAbsolute(P)||!/^[A-Za-z]+$/.test(E||''))x('invalid arguments');`,
  `let o;try{o=fs.readFileSync(P,'utf8')}catch{}`,
  `if(o!==undefined&&h(o)===H)go('');else{`,
  `let b='';const s=process.stdin;s.setEncoding('utf8');`,
  `const t=setTimeout(()=>x('no bundle within ${LOADER_BUNDLE_TIMEOUT_MS / 1000} s'),${LOADER_BUNDLE_TIMEOUT_MS}),`,
  `e=()=>x('the input ended before the bundle'),`,
  `f=d=>{const n=b.length;b+=d;const i=b.indexOf('\\n',n);if(i<0?b.length>M:i>M)x('the bundle is too long');if(i<0)return;`,
  `s.off('data',f);s.off('end',e);s.pause();clearTimeout(t);`,
  `let v;try{v=JSON.parse(b.slice(0,i))}catch{}`,
  `if(typeof v!=='string'||h(v)!==H)x('the bundle does not match its hash');`,
  `try{fs.mkdirSync(p.dirname(P),{recursive:true});fs.writeFileSync(P+'.tmp',v);fs.renameSync(P+'.tmp',P)}`,
  `catch(e){x('the bundle cannot be stored: '+e.message)}`,
  `go(b.slice(i+1))};`,
  `s.on('data',f);s.on('end',e)}`,
].join('');

/** The sha256 of a bundle as the loader checks it: 64 lower-case hex digits over its UTF-8 bytes. */
export function bundleHash(bundle: string): string {
  return createHash('sha256').update(bundle, 'utf8').digest('hex');
}

/** The first line of the input: the bundle as a JSON string and a line feed (JSON.stringify escapes every line feed). */
export function encodeBundle(bundle: string): string {
  return `${JSON.stringify(bundle)}\n`;
}

/** Where the bundle is stored, its hash (bundleHash), and the exported function that starts it (letters only). */
export interface LoaderTarget {
  path: string;
  hash: string;
  entry: string;
}

/** The command of the container: `node -e PIPE_LOADER <path> <hash> <entry>`. Never the bundle itself. */
export function loaderCommand(target: LoaderTarget): string[] {
  return ['node', '-e', PIPE_LOADER, target.path, target.hash, target.entry];
}
