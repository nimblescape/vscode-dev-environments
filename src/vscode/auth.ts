// GitHub access through the built-in GitHub sign-in of VS Code (concept section 9, NFR-03). VS Code stores the session;
// the extension never stores the token on the computer and never logs it. It writes the token of an environment's owner
// account into that environment only (the open pipeline, concept section 9 "Git inside the container").
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { Credentials, GitHubAuth, Logger } from '../core/ports';
import type { GitHubAccount } from '../core/types';

export const GITHUB_PROVIDER_ID = 'github';
/** `repo` lists and clones private repositories; `read:org` reads the organization memberships. */
export const GITHUB_SCOPES: readonly string[] = ['repo', 'read:org'];
/** Requested only when a private image on ghcr.io needs it (concept 7.7). */
export const PACKAGES_SCOPES: readonly string[] = ['repo', 'read:org', 'read:packages'];
/** Context key for the welcome view and the menus (package.json). */
export const SIGNED_IN_CONTEXT_KEY = 'devEnvironments.signedIn';

// User-visible text that messages.ts lacks; to be moved there.
/** Shown by VS Code when a new session is requested because GitHub rejected the stored one. */
export const SIGN_IN_AGAIN_DETAIL = 'GitHub did not accept the current sign-in. Sign in again to see your repositories.';

export class VsCodeGitHubAuth implements GitHubAuth, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Interactive requests per scope set, so that parallel callers share one sign-in dialog. */
  private readonly interactive = new Map<string, Promise<vscode.AuthenticationSession | undefined>>();

  /** Fires when the GitHub sessions of VS Code change (sign-in, sign-out, account change). */
  readonly onDidChangeSession: vscode.Event<void> = this.changeEmitter.event;

  constructor(private readonly logger: Logger) {
    this.subscriptions.push(
      this.changeEmitter,
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id !== GITHUB_PROVIDER_ID) return;
        this.updateContextKey()
          .then(undefined, (error: unknown) => this.logger.warn(`Could not update the sign-in state: ${errorMessage(error)}`))
          .finally(() => this.changeEmitter.fire());
      }),
    );
  }

  /** Token with the scopes `repo` and `read:org`. `interactive` shows the sign-in dialog if needed; otherwise never a dialog. */
  async getToken(options: { interactive: boolean }): Promise<string | undefined> {
    const session = await this.session(GITHUB_SCOPES, options.interactive);
    return session?.accessToken;
  }

  /**
   * The account of the session of getToken (concept 7.5): `session.account.id` (the numeric GitHub user ID) and
   * `session.account.label` (the login). `undefined` without a session.
   */
  async getAccount(options: { interactive: boolean }): Promise<GitHubAccount | undefined> {
    const session = await this.session(GITHUB_SCOPES, options.interactive);
    return session ? { id: session.account.id, login: session.account.label } : undefined;
  }

  /**
   * The token and the account of one session. Use it where both must belong together (a claim, concept 7.5): the session
   * can change between a call of getAccount and a call of getToken. `undefined` without a session.
   */
  async getSession(options: { interactive: boolean }): Promise<{ token: string; account: GitHubAccount } | undefined> {
    const session = await this.session(GITHUB_SCOPES, options.interactive);
    return session ? { token: session.accessToken, account: { id: session.account.id, login: session.account.label } } : undefined;
  }

  /** Credentials for ghcr.io: the session with the additional scope `read:packages`. */
  async getPackagesCredentials(options: { interactive: boolean }): Promise<Credentials | undefined> {
    const session = await this.session(PACKAGES_SCOPES, options.interactive);
    return session ? { username: session.account.label, password: session.accessToken } : undefined;
  }

  /**
   * Asks for a new session when GitHub rejected the token of the current one (HTTP 401). Shows the sign-in dialog.
   * Returns the new token, or `undefined` when the user cancels.
   */
  async renewToken(): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...GITHUB_SCOPES], {
        forceNewSession: { detail: SIGN_IN_AGAIN_DETAIL },
      });
      return session.accessToken;
    } catch (error) {
      this.logger.warn(`GitHub sign-in was not completed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** True if a session with the scopes `repo` and `read:org` exists. Never shows a dialog. */
  async isSignedIn(): Promise<boolean> {
    return (await this.session(GITHUB_SCOPES, false)) !== undefined;
  }

  /** Sets the context key `devEnvironments.signedIn`. Returns the state. */
  async updateContextKey(): Promise<boolean> {
    const signedIn = await this.isSignedIn();
    await vscode.commands.executeCommand('setContext', SIGNED_IN_CONTEXT_KEY, signedIn);
    return signedIn;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  private async session(scopes: readonly string[], interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
    if (!interactive) {
      try {
        return await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...scopes], { silent: true });
      } catch (error) {
        this.logger.warn(`Could not read the GitHub session: ${errorMessage(error)}`);
        return undefined;
      }
    }
    const key = [...scopes].sort().join(' ');
    let request = this.interactive.get(key);
    if (!request) {
      request = this.requestInteractive(scopes).finally(() => this.interactive.delete(key));
      this.interactive.set(key, request);
    }
    return request;
  }

  private async requestInteractive(scopes: readonly string[]): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...scopes], { createIfNone: true });
    } catch (error) {
      // The user cancelled the dialog or did not allow the access.
      this.logger.warn(`GitHub sign-in was not completed: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
