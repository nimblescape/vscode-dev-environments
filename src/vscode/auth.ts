// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

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

/** A session whose token GitHub rejected (HTTP 401): its ID and its token. */
interface RejectedSession {
  id: string;
  token: string;
}

export class VsCodeGitHubAuth implements GitHubAuth, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly signInStateEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Interactive requests per scope set, so that parallel callers share one sign-in dialog. */
  private readonly interactive = new Map<string, Promise<vscode.AuthenticationSession | undefined>>();
  /**
   * Per scope set, the session whose token GitHub rejected (HTTP 401).
   * Workaround for VS Code keeping a GitHub session whose token GitHub rejects: `getSession` with `createIfNone` returns
   * that session again without a dialog, so a sign-in could never replace the token. While the session is rejected, an
   * interactive request asks for a new session (`forceNewSession`), and the session does not count as signed in. Remove
   * when VS Code handles it.
   */
  private readonly rejected = new Map<string, RejectedSession>();

  /** Fires when the GitHub sessions of VS Code change (sign-in, sign-out, account change). */
  readonly onDidChangeSession: vscode.Event<void> = this.changeEmitter.event;
  /**
   * Fires when GitHub rejected the token of the current session, or accepted it again. The session itself did not
   * change, so this is not onDidChangeSession: the account and its environments stay the same.
   */
  readonly onDidChangeSignInState: vscode.Event<void> = this.signInStateEmitter.event;

  constructor(private readonly logger: Logger) {
    this.subscriptions.push(
      this.changeEmitter,
      this.signInStateEmitter,
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
    // The account needs no working token: a session whose token GitHub rejected still names it, so commands on the
    // environments of the account (Stop, Delete) ask for no new sign-in. Only without any session a dialog shows.
    const existing = options.interactive ? await this.session(GITHUB_SCOPES, false) : undefined;
    const session = existing ?? (await this.session(GITHUB_SCOPES, options.interactive));
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

  /**
   * True if a session with the scopes `repo` and `read:org` exists and GitHub did not reject its token. Never shows a
   * dialog.
   */
  async isSignedIn(): Promise<boolean> {
    const session = await this.session(GITHUB_SCOPES, false);
    return session !== undefined && !this.isRejected(GITHUB_SCOPES, session);
  }

  /**
   * GitHub answered HTTP 401 for `token`: the session with this token does not count as signed in, and the next
   * interactive request asks for a new session. Every GitHub caller reports a 401 here. A token that belongs to no
   * current session (an older one) changes nothing. Never throws.
   */
  reportRejectedToken(token: string): void {
    void this.updateRejected(token, true).catch((error: unknown) =>
      this.logger.warn(`Could not update the sign-in state: ${errorMessage(error)}`),
    );
  }

  /** GitHub accepted `token` (a request succeeded): a rejection of its session is forgotten. Never throws. */
  reportAcceptedToken(token: string): void {
    if (![...this.rejected.values()].some((entry) => entry.token === token)) return;
    void this.updateRejected(token, false).catch((error: unknown) =>
      this.logger.warn(`Could not update the sign-in state: ${errorMessage(error)}`),
    );
  }

  /**
   * Sets the context key `devEnvironments.signedIn` (package.json: the welcome view with **Sign in with GitHub**). The
   * only place that sets it: signed in means a session exists and GitHub did not reject its token. Returns the state.
   */
  async updateContextKey(): Promise<boolean> {
    const signedIn = await this.isSignedIn();
    await vscode.commands.executeCommand('setContext', SIGNED_IN_CONTEXT_KEY, signedIn);
    return signedIn;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  private async updateRejected(token: string, rejected: boolean): Promise<void> {
    let changed = false;
    for (const scopes of [GITHUB_SCOPES, PACKAGES_SCOPES]) {
      const key = scopeKey(scopes);
      const session = await this.session(scopes, false);
      if (session === undefined || session.accessToken !== token) continue;
      if (rejected && !this.isRejected(scopes, session)) {
        this.rejected.set(key, { id: session.id, token });
        this.logger.warn('GitHub rejected the token of the current sign-in (HTTP 401). Sign in with GitHub replaces it.');
        changed = true;
      } else if (!rejected && this.rejected.delete(key)) {
        this.logger.info('GitHub accepted the token of the current sign-in again.');
        changed = true;
      }
    }
    if (!changed) return;
    await this.updateContextKey();
    this.signInStateEmitter.fire();
  }

  /** True if GitHub rejected the token of `session`. A session with another ID or token clears the rejection. */
  private isRejected(scopes: readonly string[], session: vscode.AuthenticationSession): boolean {
    const key = scopeKey(scopes);
    const entry = this.rejected.get(key);
    if (!entry) return false;
    if (entry.id === session.id && entry.token === session.accessToken) return true;
    this.rejected.delete(key);
    return false;
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
    const key = scopeKey(scopes);
    let request = this.interactive.get(key);
    if (!request) {
      request = this.requestInteractive(scopes).finally(() => this.interactive.delete(key));
      this.interactive.set(key, request);
    }
    return request;
  }

  private async requestInteractive(scopes: readonly string[]): Promise<vscode.AuthenticationSession | undefined> {
    // Workaround (see `rejected`): `createIfNone` would return the rejected session again without a dialog.
    const current = this.rejected.has(scopeKey(scopes)) ? await this.session(scopes, false) : undefined;
    const force = current !== undefined && this.isRejected(scopes, current);
    try {
      return await vscode.authentication.getSession(GITHUB_PROVIDER_ID, [...scopes], force ? { forceNewSession: true } : { createIfNone: true });
    } catch (error) {
      // The user cancelled the dialog or did not allow the access.
      this.logger.warn(`GitHub sign-in was not completed: ${errorMessage(error)}`);
      return undefined;
    }
  }
}

/**
 * The listener of RegistryClient for credentials that a token service rejected (HTTP 401): for ghcr.io, whose
 * credentials may be the GitHub session (withGitHubPackagesFallback), the password is reported to `auth`, which ignores
 * a token that belongs to no current session (for example one of the Docker credentials). Other registries report
 * nothing: their credentials are not the GitHub session.
 */
export function ghcrRejectionReporter(auth: Pick<VsCodeGitHubAuth, 'reportRejectedToken'>): (registry: string, credentials: Credentials) => void {
  return (registry, credentials) => {
    if (registry.toLowerCase() === 'ghcr.io') auth.reportRejectedToken(credentials.password);
  };
}

function scopeKey(scopes: readonly string[]): string {
  return [...scopes].sort().join(' ');
}
