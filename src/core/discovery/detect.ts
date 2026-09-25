// Detection of Dev Container configurations in a GraphQL query result (concept 7.4). The rules follow the file
// locations of the Dev Container specification, in its order of precedence.

export const DEVCONTAINER_FILE = 'devcontainer.json';
export const DEVCONTAINER_FOLDER = '.devcontainer';
export const ROOT_CONFIG_PATH = '.devcontainer.json';
export const FOLDER_CONFIG_PATH = '.devcontainer/devcontainer.json';

/** An entry of a Git tree. `type` is `blob` (file), `tree` (folder), or `commit` (submodule). */
export interface TreeEntryNode {
  name: string;
  type?: string;
  object?: { entries?: Array<{ name: string; type?: string }> } | null;
}

/** The part of a repository node that the detection reads: the aliases `rootFile` and `folder` of the queries. */
export interface ConfigurationNode {
  /** `object(expression: "<rev>:.devcontainer.json")`. `null` if the path does not exist. */
  rootFile?: { __typename: string } | null;
  /** `object(expression: "<rev>:.devcontainer")`. Without `entries` if the path is not a folder. */
  folder?: { entries?: TreeEntryNode[] } | null;
}

function isFile(entry: { type?: string }): boolean {
  // Nested entries of older query results may lack `type`; a name match is then enough.
  return entry.type === undefined || entry.type === 'blob';
}

/**
 * Configuration paths in the order of precedence (concept 7.4):
 * 1. `.devcontainer/devcontainer.json`
 * 2. `.devcontainer.json`
 * 3. `.devcontainer/<sub-folder>/devcontainer.json`, sub-folders in the order of their names
 * The first path is the default configuration. An empty list means that the repository has no configuration.
 */
export function detectConfigurations(node: ConfigurationNode): string[] {
  const paths: string[] = [];
  const folderEntries = node.folder?.entries;
  const entries = Array.isArray(folderEntries) ? folderEntries : [];

  if (entries.some((entry) => entry?.name === DEVCONTAINER_FILE && isFile(entry))) {
    paths.push(FOLDER_CONFIG_PATH);
  }

  // A symbolic link is a Blob too; Git checks it out as a link to the file.
  if (node.rootFile?.__typename === 'Blob') {
    paths.push(ROOT_CONFIG_PATH);
  }

  const subFolders = entries
    .filter((entry) => entry && entry.type === 'tree' && isValidFolderName(entry.name))
    .filter((entry) => {
      const nested = entry.object?.entries;
      return Array.isArray(nested) && nested.some((child) => child?.name === DEVCONTAINER_FILE && isFile(child));
    })
    .map((entry) => entry.name)
    .sort(compareNames);
  for (const name of subFolders) {
    paths.push(`${DEVCONTAINER_FOLDER}/${name}/${DEVCONTAINER_FILE}`);
  }
  return paths;
}

function isValidFolderName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !name.includes('/');
}

/** Order of code units, as Git orders tree entries. Independent of the locale of the computer. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
