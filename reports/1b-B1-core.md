# Unit 1b, step B1 report: one environment per repository and GitHub account (core only)

Checks after the last B1 edit (16:47): `npx vitest run src/core src/monitor src/licenseHeaders.test.ts` 40 files / 1725 tests pass; 26 deliberate rule breaks each failed a test (script `b1-mutate.py`, not in the repo). The full tree then had 2 type errors and 10 failing tests, all in the VS Code layer (step B2).

Note: two copies of the B1 agent worked on the same files between 16:44 and 16:48 (a message from another agent had started a second copy). The second copy added one consistent change: when GitHub cannot be asked about an entry of an older version (offline, rate limit), Start refuses with `environmentUnassigned` instead of creating a second environment (`ClaimOptions.onUnanswered`, 3 tests). The review of unit 1b should look at this part again.

## Core API that the VS Code layer must use
- Registry (`src/core/storage/registry.ts`): `findByRepository(repo)` is removed. `findForAccount(repo, accountId)` returns the account's own environment of the repository (repository name case-insensitive). `findUnowned(repo)` returns the entry of an older version (no owner). New export `isEnvironmentOf(env, repo, accountId | undefined)`. `add()` refuses a second entry with the same repository and owner; entries without an owner count as one owner.
- Ownership (`src/core/ownership.ts`): new export `canClaim(environments, entry, account)`. `claim()` and `adopt()` never give an account a second environment of a repository (checked before GitHub or the user is asked, and again under the registry lock); such an entry stays hidden and is logged by ID only. `ClaimDeps.registry` needs `list` and `update`. New `ClaimOptions.onUnanswered`.
- `EnvironmentService.open(target)`: asks for the session first (the sign-in prompt now comes before the "untrusted repository" question); the lookup and the token come from that one session. Uses the signed-in account's own environment of the repository; for an entry of an older version it asks to claim it — claimed: that entry is used; declined or no access: a new environment of the account is created; GitHub could not be asked: `environmentUnassigned`. Never uses or names another account's environment; that account's first open creates its own environment (clone, volume, container, token, Git identity). `open` no longer throws `otherAccount`; `openEnvironment(id)` and the other ID-based commands still do. `EnvironmentStore` picks `findForAccount | findUnowned`.
- `reconcileFromVolumes()`: restores one environment per repository and owner (from the `devenv.owner-id` label), and at most one per repository for volumes without that label.
- New environment IDs: an ID is skipped when its short ID is already in the registry or its volume exists; gives up after 5 tries before anything is created. New `EnvironmentServiceDeps.newEnvironmentId` for tests.
- Names and labels unchanged (names end in the short ID).
- Session Monitor: new export `environmentLabel()` in `src/monitor/monitorLoop.ts`; log lines add the short ID when a repository has more than one environment.

## What B2 must do (B2 was interrupted before it finished)
- `src/vscode/controller.ts`: replace the calls to the removed `findByRepository` with `findForAccount(repo, signedInAccount.id)`; a repository target must never carry another account's environment into `open`; `otherAccount` applies only to explicit environment IDs.
- Obsolete under decision 2: `lockedRepositories` in `sidebar.ts`; the `otherAccountEnvironment` row and tooltip in `treeModel.ts`; `ControllerTexts.otherAccount` ("keeps one environment per repository") — B2 had already removed the text; `src/vscode/controller.test.ts` still refers to it (type errors) and has failing tests.
- Docs: concept D-3, FR-03, 6.2, 7.5 (claim rules), 5 (known limits: disk space per account); implementation notes sections 4 and 5.
- Docker test: two owners of the same repository give two volumes and containers.
- Optional: `Messages.otherAccount` text; `decideReopen` still counts other accounts' pending operations (minor, older).

## Files changed by B1
`src/core/storage/registry.ts` (+test), `src/core/ownership.ts` (+test), `src/core/pipeline/environmentService.ts` (+test), `src/core/pipeline/environmentService.accounts.test.ts` (new), `src/monitor/monitorLoop.ts` (+test).
