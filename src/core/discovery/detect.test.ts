// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, it, expect } from 'vitest';
import { detectConfigurations, type ConfigurationNode, type TreeEntryNode } from './detect';

const blob = (name: string): TreeEntryNode => ({ name, type: 'blob', object: {} });
const tree = (name: string, children: string[] = [], childType = 'blob'): TreeEntryNode => ({
  name,
  type: 'tree',
  object: { entries: children.map((child) => ({ name: child, type: childType })) },
});
const folder = (...entries: TreeEntryNode[]): ConfigurationNode['folder'] => ({ entries });
const rootBlob = { __typename: 'Blob' };

describe('detectConfigurations', () => {
  const rows: Array<{ title: string; node: ConfigurationNode; expected: string[] }> = [
    { title: 'nothing', node: { rootFile: null, folder: null }, expected: [] },
    { title: 'missing fields', node: {}, expected: [] },
    {
      title: 'folder contains devcontainer.json',
      node: { rootFile: null, folder: folder(blob('devcontainer.json'), blob('Dockerfile')) },
      expected: ['.devcontainer/devcontainer.json'],
    },
    { title: 'rootFile exists', node: { rootFile: rootBlob, folder: null }, expected: ['.devcontainer.json'] },
    {
      title: 'sub-folders with devcontainer.json, sorted by name',
      node: {
        rootFile: null,
        folder: folder(tree('python', ['devcontainer.json', 'Dockerfile']), tree('Node', ['devcontainer.json']), tree('go', ['devcontainer.json'])),
      },
      // Code unit order, like Git: upper case before lower case.
      expected: ['.devcontainer/Node/devcontainer.json', '.devcontainer/go/devcontainer.json', '.devcontainer/python/devcontainer.json'],
    },
    {
      title: 'all three locations, in the order of precedence',
      node: {
        rootFile: rootBlob,
        folder: folder(tree('python', ['devcontainer.json']), blob('devcontainer.json')),
      },
      expected: ['.devcontainer/devcontainer.json', '.devcontainer.json', '.devcontainer/python/devcontainer.json'],
    },
    {
      title: 'sub-folder without devcontainer.json',
      node: { rootFile: null, folder: folder(tree('scripts', ['setup.sh']), blob('Dockerfile')) },
      expected: [],
    },
    {
      title: 'rootFile that is a folder',
      node: { rootFile: { __typename: 'Tree' }, folder: null },
      expected: [],
    },
    {
      title: '.devcontainer that is a file (no entries)',
      node: { rootFile: null, folder: {} },
      expected: [],
    },
    {
      title: 'devcontainer.json in the folder that is itself a folder',
      node: { rootFile: null, folder: folder(tree('devcontainer.json', ['README.md'])) },
      expected: [],
    },
    {
      title: 'nested devcontainer.json that is a folder',
      node: { rootFile: null, folder: folder(tree('python', ['devcontainer.json'], 'tree')) },
      expected: [],
    },
    {
      title: 'submodule entry without object entries',
      node: { rootFile: null, folder: folder({ name: 'shared', type: 'commit', object: null }) },
      expected: [],
    },
    {
      title: 'nested entries without a type (older result shape)',
      node: { rootFile: null, folder: folder({ name: 'python', type: 'tree', object: { entries: [{ name: 'devcontainer.json' }] } }) },
      expected: ['.devcontainer/python/devcontainer.json'],
    },
    {
      title: 'file name with different case does not count',
      node: { rootFile: null, folder: folder(blob('DevContainer.json'), tree('x', ['Devcontainer.json'])) },
      expected: [],
    },
  ];

  for (const row of rows) {
    it(row.title, () => {
      expect(detectConfigurations(row.node)).toEqual(row.expected);
    });
  }

  it('tolerates null entries and malformed values from the network', () => {
    const node = {
      rootFile: null,
      folder: { entries: [null, { name: 'python', type: 'tree', object: { entries: [null, { name: 'devcontainer.json', type: 'blob' }] } }] },
    } as unknown as ConfigurationNode;
    expect(detectConfigurations(node)).toEqual(['.devcontainer/python/devcontainer.json']);
    expect(detectConfigurations({ folder: { entries: 'x' } } as unknown as ConfigurationNode)).toEqual([]);
  });
});
