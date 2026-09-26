# GitHub token: options for later

This document keeps the options for a stronger handling of the GitHub token inside environments, for a later decision. The options A, B, and D are not implemented. The requirements are in the concept ([vscode-dev-environments.md](vscode-dev-environments.md), section 9 "Git inside the container"); the restrictions of the containers are in [Container restrictions](container-restrictions.md).

## Decided for now (2026-09-26)

The user decided: **the token is kept only in the memory of the container** (planned as the next change after Docker Compose support; until then, the token is a file in the workspace volume) (a `tmpfs` inside the dev container), never in the workspace volume. It is written at each open and stays while the container runs, also without a window (for AI agents that keep working after the window disconnects). It is gone when the container stops. The token is the OAuth token of the GitHub sign-in of VS Code: it reaches every repository of the account and does not expire until it is revoked.

What this protects and what not:

| Risk | Token in the volume (before) | Token only in memory (decided) |
|---|---|---|
| At rest: stopped environment, copy or export of the volume, volume kept by a Delete | exposed | gone when the container stops |
| Anyone who can use Docker on the computer, while the container runs | readable | readable |
| A process or AI agent in the container | readable (it must be) | readable (it must be) |
| What a leaked token can do | every repository of the account, no expiry | the same |

The last row is what the options below improve: shorter lifetime, fewer repositories, or no token in the container at all.

## Constraints

- Several VS Code windows at the same time, and AI agents that keep working in a container after its window disconnects.
- The containers may run on a remote Docker host (setting `devEnvLauncher.dockerHost`). The computer of the user may sleep or hibernate, so nothing on the computer (not the extension, not the Session Monitor) can renew a token while agents work on the remote host. **Renewal must run where the containers run, or on a service that is always on.**
- The sign-in of VS Code (the GitHub authentication provider) gives only the long-lived OAuth token; it cannot issue short-lived or repository-scoped tokens.

## Background: GitHub Apps

A GitHub App is installed on selected repositories or an organization; the installation is the lasting permission and stays until it is removed. With its **private key**, the operator of the app mints **installation tokens**: valid for one hour, limited to the permissions of the installation and, if requested, to single repositories. A GitHub App can also give **user access tokens** (on behalf of the signed-in user): valid for about 8 hours, renewed with a **refresh token** that is valid for about 6 months and changes at every renewal. The private key can mint tokens for every installation of the app, so it must never be in the extension or on the computer or Docker host of a user.

This is also how the Claude GitHub App works: the installation is the lasting permission, and a service that holds the private key mints short-lived tokens when they are needed. In Claude's cloud sessions, a proxy outside the sandbox adds the credentials to Git and GitHub requests, so the sandbox holds no token (observed behaviour; the details of the service are not documented here).

## Option A: renewal on the Docker host with a user access token

- A GitHub App of Dev Environments (public, no private key needed for this option). The user signs in once through the app (device flow).
- A small renewal container on each Docker host keeps the refresh token and gets a new user access token every few hours. It writes the token into the in-memory folder of each running environment of that user. No window and no computer is needed.
- Better than today: tokens expire after about 8 hours; access is limited to the repositories where the user installed the app; the refresh token changes at each renewal and can be revoked on GitHub.
- Limits: the refresh token (about 6 months, only for this app) is stored on the Docker host; access cannot be limited to exactly one repository per environment. To verify first: whether GitHub renews user access tokens of a GitHub App without the client secret (a secret shipped in the extension would not be secret).

## Option B: installation tokens for exactly one repository

- A GitHub App of Dev Environments, and a **hosted token service** that holds its private key and mints installation tokens (one hour, one repository, only the needed permissions such as contents and pull requests).
- A renewal component on the Docker host asks the service for a new token for each environment before the old one expires and writes it into the in-memory folder.
- Better than A: one repository per environment, one hour.
- Limits: a service must be operated (availability, security of the private key); the renewal component needs its own credential to prove to the service which user and repositories it may ask for.

## Option D: B plus a proxy, so no token is in the container

- As B, but the token never enters the container: a proxy on the Docker host, next to the containers, adds the token to Git and GitHub requests of the environment (Git over HTTPS through the proxy, and the GitHub CLI through the same proxy).
- Better than B: a process or AI agent in the container cannot read or copy a token at all; revoking access is a matter of the proxy.
- Limits: everything of B, plus the proxy (TLS handling for github.com and api.github.com, Git and `gh` configuration in the container, per-environment policy in the proxy).

## Recommendation for the decision later

Without a hosted service: **A**. With a hosted service: **D**, the strongest protection. B alone is an intermediate step towards D.
