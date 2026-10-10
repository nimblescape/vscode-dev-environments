// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #139 (reviewer B): probes of the mutants of the surrogate rule of ChannelServer.sendOutput (review
// round 1, A-L1) that the tests of the round leave alive: a piece never ends between the two halves of a pair, for the
// first and the last code unit of each half's range, and output that itself ends with a lone first half is sent once (an
// endless loop of empty pieces otherwise).
import { describe, expect, it } from 'vitest';
import { CHANNEL_PROTOCOL_VERSION, OUTPUT_CHUNK_CHARACTERS, encodeMessage, type ServerMessage } from '../core/helperChannel/protocol';
import { ChannelServer, type OperationHandler } from './server';

const HIGH = /[\uD800-\uDBFF]$/;
const LOW = /^[\uDC00-\uDFFF]/;

/** The `out` pieces of one run of an operation that writes `text` as its output. */
async function piecesOf(text: string): Promise<{ pieces: string[]; result: ServerMessage | undefined }> {
  const messages: ServerMessage[] = [];
  let outs = 0;
  const operation: OperationHandler = async (_params, context) => {
    context.output('stdout', text);
    return null;
  };
  let done!: () => void;
  const ended = new Promise<void>((resolve) => (done = resolve));
  const server = new ChannelServer({
    write: (line) => {
      for (const part of line.split('\n').filter((item) => item !== '')) {
        const message = JSON.parse(part) as ServerMessage;
        messages.push(message);
        if (message.t === 'out') outs++;
        if (message.t === 'result') done();
      }
      return true;
    },
    // A runaway loop of pieces (more than the text can make) ends here, so the probe fails instead of hanging.
    congested: () => {
      if (outs > text.length + 2) throw new Error('runaway output loop');
      return false;
    },
    operations: { write: operation },
    exit: () => {},
  });
  server.start();
  server.input(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION }));
  server.input(encodeMessage({ t: 'op', id: 1, op: 'write', params: null }));
  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  server.shutdown();
  const pieces = messages.flatMap((message) => (message.t === 'out' ? [message.data] : []));
  return { pieces, result: messages.find((message) => message.t === 'result') };
}

function expectWholePairs(pieces: string[]): void {
  for (let index = 0; index < pieces.length; index++) {
    if (index + 1 < pieces.length) expect(HIGH.test(pieces[index]), `piece ${index} ends with a first half`).toBe(false);
    if (index > 0) expect(LOW.test(pieces[index]), `piece ${index} starts with a second half`).toBe(false);
  }
}

describe('review round 2 of PR #139: the pieces of output never split a surrogate pair', () => {
  it('output that ends with a lone first half of a pair is sent once, whole', async () => {
    const { pieces, result } = await piecesOf('x\uD83D');
    expect(pieces).toEqual(['x\uD83D']);
    expect(result).toEqual({ t: 'result', id: 1, ok: true, value: null });
  });

  it('a pair whose second half ends a piece stays in that piece', async () => {
    const before = 'a'.repeat(OUTPUT_CHUNK_CHARACTERS - 2);
    const { pieces } = await piecesOf(`${before}\u{1F600}b`);
    expect(pieces).toEqual([`${before}\u{1F600}`, 'b']);
    expectWholePairs(pieces);
  });

  for (const [name, pair] of [
    ['U+10000 (first half U+D800)', '𐀀'],
    ['U+10FFFF (first half U+DBFF)', '􏿿'],
  ] as const) {
    it(`a pair at the end of a piece: ${name}`, async () => {
      const before = 'a'.repeat(OUTPUT_CHUNK_CHARACTERS - 1);
      const { pieces } = await piecesOf(`${before}${pair} after`);
      expect(pieces).toEqual([before, `${pair} after`]);
      expectWholePairs(pieces);
    });
  }
});
