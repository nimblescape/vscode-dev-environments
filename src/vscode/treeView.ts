// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Sidebar view `devEnvironments.repositories` (concept 6.2). The rows come from the pure model in treeModel.ts.
import * as vscode from 'vscode';
import { Actions } from '../core/messages';
import type { Logger } from '../core/ports';
import {
  rootNodes,
  stateIcon,
  type GroupNode,
  type HintRow,
  type OwnerGroup,
  type RepositoryRow,
  type SignInRow,
} from './treeModel';

export const REPOSITORIES_VIEW_ID = 'devEnvironments.repositories';

/** Command handlers of row actions receive a RepositoryRow as the first argument. */
export type TreeNode = OwnerGroup | GroupNode | RepositoryRow | HintRow | SignInRow;

/** Command of the sign-in row (package.json). */
const SIGN_IN_COMMAND = 'devEnvironments.signIn';

export class RepositoriesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  private groups: OwnerGroup[] = [];
  private roots: TreeNode[] = [];
  private readonly parents = new Map<string, OwnerGroup | GroupNode>();

  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this.changeEmitter.event;

  constructor(private readonly logger: Logger) {}

  /**
   * Replaces the model and refreshes the view. `signedIn: false` adds the sign-in row at the top when the view is not
   * empty (see `rootNodes`). Default: signed in. While the Docker setup is required, the sidebar passes an empty model.
   */
  setModel(groups: OwnerGroup[], options: { signedIn?: boolean } = {}): void {
    this.groups = groups;
    this.roots = rootNodes(groups, options.signedIn ?? true);
    this.parents.clear();
    // The nodes of the setting repositoryGroups nest the rows: every parent is recorded, so reveal finds each row.
    const record = (parent: OwnerGroup | GroupNode): void => {
      for (const child of parent.children) {
        this.parents.set(child.id, parent);
        if (child.kind === 'group') record(child);
      }
    };
    for (const group of groups) record(group);
    this.changeEmitter.fire(undefined);
  }

  /** The current model. */
  getModel(): readonly OwnerGroup[] {
    return this.groups;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    try {
      switch (node.kind) {
        case 'owner':
          return ownerItem(node);
        case 'group':
          return groupItem(node);
        case 'repository':
          return repositoryItem(node);
        case 'hint':
          return hintItem(node);
        case 'signIn':
          return signInItem(node);
      }
    } catch (error) {
      this.logger.error('Could not show a row of the sidebar.', error);
      return new vscode.TreeItem(node.id);
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.roots;
    return node.kind === 'owner' || node.kind === 'group' ? node.children : [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return node.kind === 'owner' || node.kind === 'signIn' ? undefined : this.parents.get(node.id);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function ownerItem(group: OwnerGroup): vscode.TreeItem {
  const item = new vscode.TreeItem(group.owner, vscode.TreeItemCollapsibleState.Expanded);
  item.id = group.id;
  item.contextValue = 'owner';
  return item;
}

/** Node of the setting repositoryGroups. Its contextValue does not start with `repository`, so no row action applies. */
function groupItem(node: GroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = node.id;
  item.contextValue = 'group';
  if (node.tooltip !== undefined) item.tooltip = node.tooltip;
  return item;
}

function repositoryItem(row: RepositoryRow): vscode.TreeItem {
  const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
  item.id = row.id;
  item.description = row.description;
  item.tooltip = row.tooltip;
  item.contextValue = row.contextValue;
  if (row.state) {
    const icon = stateIcon(row.state);
    item.iconPath = new vscode.ThemeIcon(icon.id, icon.color ? new vscode.ThemeColor(icon.color) : undefined);
  } else {
    // A repository without environment has no symbol; the blank icon keeps the names aligned.
    item.iconPath = new vscode.ThemeIcon('blank');
  }
  item.accessibilityInformation = { label: [row.repository, row.description].filter((text) => text !== '').join(', ') };
  return item;
}

function signInItem(row: SignInRow): vscode.TreeItem {
  const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
  item.id = row.id;
  item.tooltip = row.tooltip;
  item.contextValue = 'signIn';
  item.iconPath = new vscode.ThemeIcon('account');
  item.command = { command: SIGN_IN_COMMAND, title: row.label };
  return item;
}

function hintItem(hint: HintRow): vscode.TreeItem {
  const item = new vscode.TreeItem(hint.label, vscode.TreeItemCollapsibleState.None);
  item.id = hint.id;
  // An owner that GitHub does not return has nothing to authorize: the row opens its page.
  const action = hint.notFound ? Actions.open : Actions.authorize;
  if (!hint.notFound) item.description = action;
  item.tooltip = `${action}: ${hint.url}`;
  item.contextValue = 'hint';
  item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
  item.command = { command: 'vscode.open', title: action, arguments: [vscode.Uri.parse(hint.url)] };
  return item;
}
