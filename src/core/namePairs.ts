// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The readable pair `<adjective>-<scientist>` of the names of an environment and of a Docker context (user decisions
// 2026-10-03): derived from the environment ID (or the Docker host) by SHA-256, so it is the same on every computer and
// needs no record of its own. The lists are part of the names: reordering them, or changing a word, renames every
// environment. Only ASCII lower-case letters, so that a pair fits every Docker name (containers, volumes, image
// repositories, Compose projects, contexts) and never contains `-` inside a word.
import { createHash } from 'crypto';

export const ADJECTIVES: readonly string[] = [
  'agile', 'amazing', 'ample', 'awake', 'balanced', 'blissful', 'bold', 'brave', 'bright', 'brisk',
  'calm', 'careful', 'charming', 'cheerful', 'clever', 'cool', 'cosmic', 'crisp', 'curious', 'daring',
  'dazzling', 'decisive', 'eager', 'earnest', 'easy', 'elated', 'elegant', 'epic', 'exact', 'fair',
  'fearless', 'festive', 'fluent', 'focused', 'friendly', 'gallant', 'generous', 'gentle', 'gifted', 'glad',
  'golden', 'graceful', 'grand', 'happy', 'hardy', 'helpful', 'heroic', 'honest', 'hopeful', 'humble',
  'jolly', 'joyful', 'keen', 'kind', 'lively', 'logical', 'loyal', 'lucid', 'lucky', 'magical',
  'mellow', 'merry', 'mighty', 'modest', 'nifty', 'nimble', 'noble', 'optimal', 'patient', 'peaceful',
  'playful', 'polite', 'precise', 'proud', 'quick', 'quiet', 'radiant', 'rapid', 'ready', 'relaxed',
  'resolute', 'serene', 'sharp', 'shiny', 'sincere', 'sleek', 'smart', 'snappy', 'solid', 'sparkling',
  'spirited', 'stable', 'steady', 'sturdy', 'sunny', 'swift', 'tidy', 'trusty', 'upbeat', 'valiant',
  'vibrant', 'vivid', 'warm', 'wise', 'witty', 'zealous',
];

/** Scientists and computer scientists, by family name. */
export const SCIENTISTS: readonly string[] = [
  'agnesi', 'allen', 'archimedes', 'aryabhata', 'babbage', 'backus', 'bardeen', 'bartik', 'bell', 'berners',
  'bohr', 'boole', 'borg', 'bose', 'brahmagupta', 'brattain', 'carson', 'cerf', 'chandrasekhar', 'chomsky',
  'church', 'clarke', 'codd', 'conway', 'copernicus', 'corbato', 'cori', 'cray', 'curie', 'darwin',
  'dijkstra', 'dirac', 'einstein', 'elion', 'engelbart', 'euclid', 'euler', 'faraday', 'fermat', 'fermi',
  'feynman', 'franklin', 'galileo', 'galois', 'gauss', 'germain', 'goldberg', 'goodall', 'hamilton', 'hawking',
  'heisenberg', 'hertz', 'hilbert', 'hodgkin', 'hoare', 'hopper', 'hubble', 'huffman', 'hypatia', 'jackson',
  'jemison', 'johnson', 'joliot', 'kahn', 'kare', 'kay', 'kepler', 'khorana', 'kilby', 'knuth',
  'kowalevski', 'lamarr', 'lamport', 'laplace', 'leakey', 'leavitt', 'lederberg', 'leibniz', 'lichterman', 'liskov',
  'lovelace', 'lumiere', 'mayer', 'mccarthy', 'mcclintock', 'meitner', 'mendel', 'mendeleev', 'minsky', 'mirzakhani',
  'moore', 'morse', 'napier', 'nash', 'neumann', 'newton', 'nightingale', 'nobel', 'noether', 'noyce',
  'ohm', 'pascal', 'pasteur', 'pauli', 'payne', 'perlman', 'planck', 'poincare', 'ptolemy', 'raman',
  'ramanujan', 'riemann', 'ritchie', 'rosalind', 'rubin', 'saha', 'sammet', 'shannon', 'shaw', 'shockley',
  'sinoussi', 'snyder', 'spence', 'stallman', 'stonebraker', 'sutherland', 'swartz', 'tesla', 'thompson', 'torvalds',
  'turing', 'volta', 'wescoff', 'wiles', 'williams', 'wilson', 'wing', 'wozniak', 'wright', 'wu',
  'yalow', 'yonath', 'zuse',
];

/** The pair `<adjective>-<scientist>` of `seed`: the first 4 bytes of its SHA-256 pick the adjective, the next 4 the scientist. */
export function namePair(seed: string): string {
  const digest = createHash('sha256').update(seed, 'utf8').digest();
  return `${ADJECTIVES[digest.readUInt32BE(0) % ADJECTIVES.length]}-${SCIENTISTS[digest.readUInt32BE(4) % SCIENTISTS.length]}`;
}

/** The pair of a name that ends in `-<adjective>-<scientist>` of the lists, else undefined. */
export function trailingPair(name: string): string | undefined {
  const match = /-([a-z]+)-([a-z]+)$/.exec(name);
  if (match === null || !ADJECTIVES.includes(match[1]) || !SCIENTISTS.includes(match[2])) return undefined;
  return `${match[1]}-${match[2]}`;
}
