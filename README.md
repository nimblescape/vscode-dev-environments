# Hand-off: remaining work queue of vscode-dev-environments

This branch (`handoff/queue`) is not code. It carries the plan, the specifications, the analyses, and the reports of a local Claude Code session (2026-09-25) so that a cloud session can finish the work. **Never merge this branch.** Read files from it with `git show origin/handoff/queue:<path>` or a separate worktree.

## Repository state

| Ref | Content |
|---|---|
| `main` (534e20c) | Last verified state: extension version 1, account separation, container-only Git, host access policy, MIT license headers. CI green. |
| `wip/1b-decisions` (40b7570) | Unit 1b, **not finished, does not type-check**: steps A1, A2, A3, B1 done; step B2 interrupted. |
| `handoff/queue` | This material. |

## Standing rules of the user (must hold for every step)

1. **Commit finished, verified work directly to `main` and push**, without asking — only after all checks pass. Work in progress stays on the work branch. (Where the specs or scripts say "Do not commit", that was meant for subagents; you, the orchestrator, commit by this rule.)
2. Every new source file (`.ts`, `.mjs`, `.mts`, Dockerfile) starts with the three-line SPDX license header of the existing files (`src/licenseHeaders.test.ts` enforces it). License: MIT, © 2026 Hannes Stauss (scalarion@nimblescape.com).
3. Never weaken, skip, or delete tests to make them pass. Every rule gets a unit test; pure logic in files without `vscode` imports; `src/core` never imports `vscode`.
4. User-visible texts in plain language (concept NFR-02); exact concept texts where the concept gives them.
5. **Never override variables that belong to the Dev Containers extension or the VS Code server** (`REMOTE_CONTAINERS_IPC`, `SSH_AUTH_SOCK`, `BROWSER`, `VSCODE_*`, `REMOTE_CONTAINERS*`, …) and never rely on their internal skip rules. Switch Dev Containers features off only through their documented settings; use only the tools' own documented variables (Git, Docker).
6. Two requirements that must keep working: (a) VS Code port forwarding to localhost and opening URLs in the local browser; (b) the container reaches everything the user's computer reaches on the network, including VPN.
7. Subagents must not message each other (a message to a running agent starts a second copy of it).
8. **Thoroughness "max"**: for each unit, implement in small steps; then review rounds — several independent reviewers, one per dimension; every finding verified by three independent verifiers (code path, requirement, reproduction), confirmed only if at least two agree; fix the confirmed findings with tests; integrate; repeat until a round finds nothing new (at most three rounds); then a final check. The scripts in `workflows/` show the exact dimensions and prompts that were planned (their paths point to the original machine; see "Path mapping").
9. Commit messages: plain imperative subject, short bullet body, and the last line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Documents to read first (on `main` / the work branch)

`docs/vscode-dev-environments.md` (concept — the source of requirements), `docs/implementation-notes.md` (technical decisions), `docs/container-restrictions.md` (every restriction on containers), `README.md`.

## The queue

### Unit 1b — decisions, per-account environments, sign-in fix (branch `wip/1b-decisions`)
Spec: `specs/spec-decisions-policy-per-account.md` — read **all** sections, including the user decisions, the accepted A3 results, the coordination rule, and the docs task at the end. Analyses: `analyses/w1-analysis-runargs-allowlist.md`, `analyses/w1-analysis-per-account-environments.md`, `analyses/gap3-analysis.md`. Reports: `reports/1b-A3-gaps.md`, `reports/1b-B1-core.md`.

Done: A1 (analysis of the Dev Containers channels), A2 (runArgs allow-list, `--rm` removal), A3 (restriction gaps 3–7 and 9), B1 (one environment per repository and account, core).

Remaining:
1. **B2** — the VS Code layer for B1 (see `reports/1b-B1-core.md`, "What B2 must do"): `src/vscode/controller.ts` and `controller.test.ts` still refer to the removed `findByRepository` and `ControllerTexts.otherAccount`; remove the obsolete `lockedRepositories` / `otherAccountEnvironment` parts; docs (concept D-3, FR-03, 6.2, 7.5, 5; notes 4, 5); Docker test "two owners, same repository → two volumes and containers".
2. **C** — the sign-in fix of the spec ("Bug 3"): the button name, the welcome texts and the sign-in row stay **exactly** as they are; behind the unchanged command `devEnvironments.signIn`, a token that GitHub rejected (HTTP 401) is replaced with `getSession(…, { forceNewSession: true })`; `devEnvironments.signedIn` is set in one place; every GitHub 401 reports to that place.
3. Review rounds (dimensions: policy, per-account, sign-in, data safety, regressions, docs), fixes, final check.
4. Squash-merge into `main` with the subject "Extend the runArgs allow-list, give each account its own environment, and fix sign-in with a rejected token", push.

### Unit 2 — scan scope, faster discovery, organization selector
Spec: `specs/spec-discovery-scope.md` (including the section "Organization selector in the view"). Measured baseline: 664 repositories, GitHub needs about 3 s per request of 50 repositories, 14 requests in a row, about 43 s (the extension took about 100 s). Subject: "Scan only the configured organizations, load the repository list faster, and add an organization selector".

### Unit 3 — Docker installation wizard
Spec: `specs/spec-docker-setup.md`. The wizard **runs** the installer visibly in a VS Code terminal after a modal confirmation that lists the exact commands. **Never run an installer, a package-manager install, `wsl --install`, or an installer download in this environment**; test the plans as pure functions. Subject: "Offer a Docker installation wizard when Docker is missing".

### Unit 4 — inventory of non-public dependencies, final check
See `workflows/4.js` for the angles (connection, attach behavior, Dev Container CLI 0.89.0, VS Code internals, systematic sweep), the verification fields and the report structure. The user asked: "report any Dev Containers internal API we use". Write the report to this branch as `reports/internals-inventory.md` (push `handoff/queue`) and put it in your final answer. Final check: all checks on `main`, and the CI runs of the last pushes.

## Verification before every merge to `main`

`npx tsc --noEmit` (0 errors) · `npx vitest run` (all pass) · `node esbuild.mjs --production` · `npm run package` and `npx vsce ls --no-dependencies` (package.json, README.md, LICENSE, dist/extension.js, dist/sessionMonitor.js, resources/**) · `npm run test:docker` if Docker is available in your environment. If it is not: open a pull request from the work branch to `main` — the CI workflow runs the job `docker` (Docker tests on ubuntu-latest) for pull requests — and merge only when both CI jobs are green. If pushing to `main` is not permitted in your environment, leave the pull request open and report it.

## Path mapping (the material was written on the user's Mac)

| Path in the material | Meaning here |
|---|---|
| `/Users/hs/workspace/projects/vscode-dev-environments` | your checkout of the repository |
| `/private/tmp/claude-501/…/scratchpad/<file>` | this branch: `specs/`, `analyses/`, `reports/` |
| `/Users/hs/.vscode/extensions/ms-vscode-remote.remote-containers-0.470.0` | the Dev Containers extension 0.470.0; if you need its code, download the VSIX from the Visual Studio Marketplace (publisher ms-vscode-remote, extension remote-containers, version 0.470.0) and unzip it; otherwise rely on `analyses/gap3-analysis.md` |
| `devenv-majikmate-*`, `mmc-development-postgres-data` | Docker objects on the user's Mac — they do not exist here |

## What the user checks afterwards in real VS Code (list it in the final report)

V-8 live check after unit 1b: the window connects and a terminal opens; "Open in Browser" and `$BROWSER <url>` open the local browser; `git push` from the terminal and from the Source Control view pushes as the environment's owner; the Mac's `~/.gitconfig` is not copied; a second GitHub account gets its own environment of the same repository; the sign-in button replaces a rejected token.
