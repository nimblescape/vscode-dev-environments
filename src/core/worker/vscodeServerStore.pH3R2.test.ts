// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Reviewer B, review round 2 of 11H3 (mutation testing): downloadToFile with `allowedUrl` refuses a URL that does not
// parse before any request (the check of round 1, A-L6, fails closed).
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { downloadToFile } from './vscodeServerStore';

describe('the allowed hosts of a download, an unparsable URL (reviewer B, round 2 of 11H3)', () => {
  it('is refused before any request', async () => {
    const urls: string[] = [];
    const transport = {
      stream: async (url: string) => {
        urls.push(url);
        return { status: 200, headers: {}, body: Readable.from([Buffer.from('x')]) };
      },
    };
    await expect(downloadToFile(transport, 'not a url', '/nonexistent/never-written', 10, new AbortController().signal, () => true)).rejects.toThrow('not on an allowed host');
    expect(urls).toEqual([]);
  });
});
