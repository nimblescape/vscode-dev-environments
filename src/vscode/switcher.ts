// Switcher (concept 6.4): Quick Pick with the recent environments and the entry "Open repository…".
import * as vscode from 'vscode';
import type { Environment, RepositoryInfo } from '../core/types';
import { recentEnvironments, repositoriesForPicker, stateIcon, type OwnerGroup } from './treeModel';

// User-visible texts that messages.ts lacks; to be moved there.
export const SwitcherTexts = {
  title: 'Switch Environment',
  placeholder: 'Select an environment to open in this window',
  recentEnvironments: 'Recent environments',
  openRepository: 'Open repository…',
  repositoryPlaceholder: 'Search a repository to open in this window',
  archived: 'archived',
  fork: 'fork',
} as const;

export type SwitcherChoice =
  | { kind: 'environment'; environmentId: string }
  | { kind: 'repository'; repository: RepositoryInfo };

interface ChoiceItem extends vscode.QuickPickItem {
  choice?: { kind: 'environment'; environmentId: string } | { kind: 'openRepository' };
}

interface RepositoryItem extends vscode.QuickPickItem {
  repository: RepositoryInfo;
}

/**
 * First list: the recent environments with their state (most recently used first), then "Open repository…", which
 * shows all repositories with a text search. Without environments, the repository list opens at once.
 * The caller opens the result in the current window.
 */
export async function showSwitcher(input: {
  groups: readonly OwnerGroup[];
  environments: readonly Environment[];
  repositories: readonly RepositoryInfo[];
}): Promise<SwitcherChoice | undefined> {
  const recent = recentEnvironments(input.groups, input.environments);
  if (recent.length === 0) return openRepository(input.repositories);

  const items: ChoiceItem[] = [
    { label: SwitcherTexts.recentEnvironments, kind: vscode.QuickPickItemKind.Separator },
    ...recent.map((entry): ChoiceItem => ({
      label: entry.state ? `$(${stateIcon(entry.state).id}) ${entry.repository}` : entry.repository,
      description: entry.description,
      choice: { kind: 'environment', environmentId: entry.environmentId },
    })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(repo) ${SwitcherTexts.openRepository}`, alwaysShow: true, choice: { kind: 'openRepository' } },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: SwitcherTexts.title,
    placeHolder: SwitcherTexts.placeholder,
    matchOnDescription: true,
  });
  const choice = picked?.choice;
  if (!choice) return undefined;
  if (choice.kind === 'environment') return choice;
  return openRepository(input.repositories);
}

/**
 * Quick Pick with all repositories and a text search on the name and owner. `title` null: no title (a command that
 * does not open the repository, for example Show on GitHub).
 */
export async function pickRepository(
  repositories: readonly RepositoryInfo[],
  placeholder: string = SwitcherTexts.repositoryPlaceholder,
  title: string | null = SwitcherTexts.openRepository,
): Promise<RepositoryInfo | undefined> {
  const items = repositoriesForPicker(repositories).map(
    (repository): RepositoryItem => ({
      label: repository.nameWithOwner,
      description: [
        repository.defaultBranch ?? undefined,
        repository.isArchived ? SwitcherTexts.archived : undefined,
        repository.isFork ? SwitcherTexts.fork : undefined,
      ]
        .filter((text): text is string => text !== undefined && text !== '')
        .join(' · '),
      repository,
    }),
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: title ?? undefined,
    placeHolder: placeholder,
    matchOnDescription: true,
  });
  return picked?.repository;
}

async function openRepository(repositories: readonly RepositoryInfo[]): Promise<SwitcherChoice | undefined> {
  const repository = await pickRepository(repositories);
  return repository ? { kind: 'repository', repository } : undefined;
}
