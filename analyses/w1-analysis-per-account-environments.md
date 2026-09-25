# Product question 2: one environment per repository and account

Analysis only. No files were changed and no tests were run.

## Current behaviour
- `EnvironmentRegistry.findByRepository(repo)` (registry.ts:102) looks up by repository only. `add()` (registry.ts:131) refuses a second environment for the same repository under the lock.
- The problem: account B presses **Start** on repository X, which has a hidden environment that belongs to account A. The lookup finds A's environment, and B gets `otherAccount` in two places: `EnvironmentService.open` → `requireOwner` (environmentService.ts:488/663) and `controller.ownTarget` (controller.ts:1415).
- **Side effect: the refusal gives away a hidden environment.** `Messages.otherAccount(repo)` says "The environment of X belongs to another GitHub account. Sign in with that account to use it." That breaks the rule in 6.2 that hidden environments are never named or counted. The proposed change removes this for repository targets.

## Change per area

| Area | Change | Size |
|---|---|---|
| `findByRepository` | Becomes `findByRepository(repo, ownerId)`. Add a helper `findUnowned(repo)` for legacy entries. Callers: `open` (488), `openFirst` after reconcile (535) and after a failed `add` (562), controller `resolveTargetOfAnyAccount` row case (1451), `repositoryTargetFor` (1487, used by the switcher, search and `refreshedTarget`). | S |
| `add` uniqueness | The key becomes `(repository lower-case, owner.id)`. New environments always have an owner. Legacy (unowned) entries count as their own key. | S |
| Names (volume/container/image) | **No change needed.** `resourceName` already ends in the environment short id (8 hex chars), and images are `devenv-<shortid>`, so two environments of one repository get different names. Adding the owner is not worth it: the login can change, and it uses up the 63-character limit. One new risk: a short-id collision within one repository (2^-32). `docker volume create` quietly reuses an existing name, and `removeFailedFirstOpen` would then delete the other environment's volume and container. Fix: in `openFirst`, check `volumeExists` before creating the volume and pick a new id if it exists (about 5 lines). | XS |
| Volume labels | No change. `devenv.owner-id` already exists on new volumes. | – |
| `reconcileFromVolumes` (1760) | The skip rule "repository already has an environment" becomes "the same (repository, owner-id or none) already exists". At most one unowned entry per repository. | S |
| Legacy claim (`EnvironmentClaims`) | New rule: **an account that already owns an environment of the repository does not claim another one.** This must be checked under the lock with `registry.update`, because `updateEnvironment` only sees one entry. Without the rule, one account ends up with two environments of one repository. `openFirst` with an unowned entry of the same repository: claim it first, and create a new environment only if that fails. In practice a failed claim (no access, offline) also means a clone would fail. | S–M |
| `EnvironmentService.open` | Call `requireSession()` before the lookup, because the account decides which environment is used. Side effect: the sign-in prompt now comes before the "untrusted repository" confirmation. Pass only the repository from the controller, so an account change during the flow cannot bring in the wrong environment. `requireOwner` stays for `openEnvironment(id)`. | S |
| Controller targets | A repository target (row without environment, switcher "Open repository…", search) no longer refuses. It resolves to the account's own environment, or none, which creates one. `otherAccount` stays only for explicit environment ids: a stale row with `environmentId`, or the status bar Reconnect. | S–M |
| Sidebar / tree model / switcher | **Nearly no change.** `TreeInput.environments` is already filtered to the account, so there is at most one environment per repository. The row id `repo:<key>` is the same across accounts, which is harmless. `treeModel` already handles duplicates with `#<id>`. | XS |
| Session Monitor | No change: it works by environment id and container label. Optional: log the container name as well as the repository, so two environments of one repository can be told apart. | XS |
| Pending operations, disconnect requests, pending connections | No change: they are keyed by environment id and already filtered by account. Minor: `decideReopen` counts all `operations/*.json`, so a pending operation of A blocks B's reopen until it expires. This problem exists today too. | – |
| Reopen record | No change needed: it is keyed by id and filtered by availability. Optional: `reopen-<accountId>.json`, so each account reopens its own last environment after an account switch. | – / S |
| Per-account repository list | Already `repositories-<accountId>.json`. No change. | – |
| Serialization (`exclusive` queues, `OperationGate`) | Keep the repository key. Only one account is active at a time, so the extra serialization is harmless. | – |
| Messages | `otherAccount` is only used for explicit environment ids. Remove "Sign in with that account" from it, so it names no hidden environment. | XS |
| Concept | D-3 (table row 912): "One environment per repository and GitHub account." FR-03 (line 85): "the one environment of the repository **for the signed-in account**". 6.2 (line 157): "at most one environment per account". 7.5 rules: replace "One environment per repository" (line 462), extend the claim rule (no claim when the account already has one; claim on Start), and add a registry-lost note. Section 9 "Accounts": two accounts have separate clones, containers and tokens; named volumes are shared by name (a known limit). | S |
| Implementation notes | Section 4: registry uniqueness `(repository, owner.id)`. Section 5: names are unchanged because the short id makes them unique. Section 7.5 note on the claim. | XS |
| Tests | **Registry:** the "exists already" test at registry.test.ts:269 flips to "allowed for another owner, refused for the same owner". **environmentService.test:** "refuses a restored volume of another account, creates no second environment" (around line 1387) flips to "creates a second environment"; `open(TARGET)` against another account's environment (1868) becomes a create, while `openEnvironment(id)` still refuses; the "created in the meantime" race (321) becomes per account; add a legacy entry plus `openFirst` → claim. **ownership.test:** "no claim when the account owns one already". **controller.test (1448–1560):** a row or switcher target with another account's environment → Start creates; an explicit id still refuses. **sidebar.test:** two accounts, same repository, each sees its own row. **Docker test** (cannot run now): two owners → two volumes and tokens. | M |

## Estimated size
- Production code: about 150–250 lines, mostly `environmentService.ts`, `controller.ts`, `registry.ts` and `ownership.ts`.
- Tests: about 350–500 lines, including roughly 10–15 existing tests that change their expected result.
- Docs: about 20 lines.
- That is about a quarter of the current uncommitted change: around half a day to implement plus a review.

## Risks
1. **Named volumes are shared across accounts (the main risk).** A repository's configuration often has `source=${localWorkspaceFolderBasename}-node_modules`, `…-bashhistory` or a literal volume name. In the helper, `${localWorkspaceFolderBasename}` becomes the repository name, so A's and B's environments of the same repository **mount the same volume automatically**. That means shell history, caches and possibly credentials cross accounts, and the two environments write to one volume at the same time. `${devcontainerId}` is per environment because the id label is the environment id, so it is safe. Today this only happens across repositories by chance; with this change it happens by default. The options conflict:
   - (a) The host-access policy refuses a named volume that an environment of another account uses. This breaks the feature for the common `node_modules` setup.
   - (b) Rename the volumes per environment. This goes against "do not change anything silently".
   - (c) Document it as a limit.

   The user needs to pick one.
2. **The legacy claim decides who gets old work.** The first account with access that refreshes claims the unowned environment. The other account then quietly gets a new, empty clone, and the unpushed work is invisible to it. Example: if staussh has access to majikmate/module-ts, staussh claims scalarion's old environment. This already happens today, but a second environment makes it less noticeable. Mitigation: claim only on an explicit Start, with a question ("An environment of X from an earlier version exists. Use it with <login>?").
3. **After a registry loss, a claimed legacy volume is unowned again,** because a label cannot be added to an existing volume, so the other account can claim it. Mitigation, which also helps with D-3 as it is: at the claim, write the owner into `/workspaces/.devenv+/owner` and check it in later claims through the helper.
4. **Account switch during an operation.** The lookup must use the account of the same session that supplies the token (`requireSession`). Otherwise B's Start could open A's environment. The controller's target must not carry an environment into `open()`.
5. **Disk use and confusion.** Two clones, two images and two containers per repository. The privacy rule forbids showing hidden environments even as a count, so B cannot see how much space A's environments use or delete them. Docker Desktop and the Dev Containers "Recent" list show two containers `devenv-<repo>-<id>` that are hard to tell apart. A restored window of the wrong one is already closed by the role A rule.
6. **Shared build cache.** BuildKit and base-image layers pulled with A's ghcr.io credentials can be reused by B's build. Low impact, and it happens today across repositories too.
7. **Short-id name collision** (2^-32). Cheap to guard, see Names.

## Decisions the user makes, if the answer is yes
- How to handle shared named volumes (risk 1: refuse, rename or document).
- Whether the legacy claim is automatic or asked on Start (risk 2).
- Optional: reopen record per account.

Relevant files: `/Users/hs/workspace/projects/vscode-dev-environments/src/core/storage/registry.ts`, `/Users/hs/workspace/projects/vscode-dev-environments/src/core/pipeline/environmentService.ts`, `/Users/hs/workspace/projects/vscode-dev-environments/src/core/ownership.ts`, `/Users/hs/workspace/projects/vscode-dev-environments/src/vscode/controller.ts`, `/Users/hs/workspace/projects/vscode-dev-environments/src/core/helper/hostAccess.ts`, `/Users/hs/workspace/projects/vscode-dev-environments/src/core/helper/configChecks.ts`, `/Users/hs/workspace/projects/vscode-dev-environments/docs/vscode-dev-environments.md`, `/Users/hs/workspace/projects/vscode-dev-environments/docs/implementation-notes.md`