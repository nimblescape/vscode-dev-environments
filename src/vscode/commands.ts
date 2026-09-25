// The commands of package.json (implementation notes 3). No `vscode` import.

export const Commands = {
  start: 'devEnvironments.start',
  stop: 'devEnvironments.stop',
  delete: 'devEnvironments.delete',
  switchBranch: 'devEnvironments.switchBranch',
  selectConfiguration: 'devEnvironments.selectConfiguration',
  rebuild: 'devEnvironments.rebuild',
  showOnGitHub: 'devEnvironments.showOnGitHub',
  switchEnvironment: 'devEnvironments.switchEnvironment',
  refresh: 'devEnvironments.refresh',
  search: 'devEnvironments.search',
  showLog: 'devEnvironments.showLog',
  signIn: 'devEnvironments.signIn',
} as const;

export type CommandName = keyof typeof Commands;
