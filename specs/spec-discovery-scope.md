# Spec — Scan scope by owners, faster discovery

Repository: /Users/hs/workspace/projects/vscode-dev-environments. Read docs/vscode-dev-environments.md (7.4, 6.1, 6.2, 8) and docs/implementation-notes.md first, then src/core/discovery/** and its callers (src/vscode/sidebar.ts, controller.ts, extension.ts). Build on top of the account-isolation change (per-account stored repository list, environment owners) that is already in the working tree. Match the code style; src/core never imports vscode; tests for every rule.

## User requirements
1. "The plugin shall get a setting with the organizations that are scanned for repositories. If they are configured, the plugin only ever shall scan the configured organizations for devcontainers."
2. The first load of the repository list is too slow: 664 repositories took ~100 s (GitHub needs ~3 s per request of 50 repositories with the configuration lookups; 14 requests run one after another).

## Decision
The existing setting `devEnvLauncher.owners` becomes the SCAN SCOPE (no second, overlapping setting):
- Empty (default): scan everything the account can access (today's query: `viewer.repositories` with the three affiliations).
- Configured (logins of organizations or user accounts, case-insensitive): the extension sends GitHub requests ONLY about repositories of these owners. No other repository is scanned or looked up — this includes the `getRepository` "still on GitHub?" lookup for environments and the legacy-environment claim check: for owners outside the scope they are skipped (such environments stay listed per the account rules, without the `not on GitHub` label, and without GitHub lookups; an unclaimed legacy environment outside the scope stays hidden — document this).
- Setting description and concept section 8 row: "Scan only the repositories of these organizations or accounts. An empty list scans all repositories that you can access."

## Implementation
- Query per owner: `repositoryOwner(login: $login) { __typename login ... on Organization { repositories(first: $pageSize, after: $cursor, orderBy: {field: PUSHED_AT, direction: DESC}) { … } } ... on User { repositories(first: …, ownerAffiliations: [OWNER], …) { … } } }` (for the signed-in user's own login use `viewer.repositories(ownerAffiliations: [OWNER], affiliations: [OWNER])` so private repositories are included). Unknown owner / no access → a hint row "The organization X was not found or is not accessible." (text in messages.ts), no error dialog. SAML/OAuth restriction errors → the existing organization hints.
- Concurrency: owners are scanned in parallel (at most 4 requests at the same time); pages of one owner stay sequential. The empty-scope full scan stays one sequential cursor (GitHub has no parallel cursor), but see incremental detection.
- Incremental detection (both scopes): split each page into (a) the list fields (cheap: name, owner, url, flags, pushedAt, defaultBranchRef) and (b) the configuration lookups (`object(expression: "HEAD:.devcontainer")` …). Keep the stored detection result per repository with its `pushedAt`; for a refresh, request the configuration lookups only for repositories whose `pushedAt` changed or that are new — as aliased batch queries (`r0: repository(owner:, name:) { rootFile … folder … }`, up to 50 per request, at most 4 requests in parallel). The first load (nothing stored) still does the lookups for all. Measure: log the duration of each refresh and the number of requests.
- Progressive display: the DiscoveryService reports partial results (callback or event per page/owner); the sidebar shows repositories as they arrive during the FIRST load (when nothing is stored). Later refreshes replace the list when complete (no flicker).
- Settings change of `devEnvLauncher.owners` → immediate refresh with the new scope; the stored list records the scope it was built with; a stored list of another scope is not shown (it may contain repositories outside the scope) — show the welcome/loading state instead and refresh.
- `filterRepositories` keeps applying `includeArchived`/`includeForks`; owners filtering stays as a safety filter.
- Keep: per-account storage, the serialization of refreshes, the 30 s request timeout and smaller-page retry, organization hints.

## Docs
Concept: 8 (setting row), 7.4 (scope, incremental detection, progressive display), 6.1 step 3 if needed. Implementation notes: discovery details (per-owner queries, concurrency 4, incremental detection by pushedAt, stored scope). README settings table.

## Verification
`npx tsc --noEmit`, `npx vitest run` (unit tests with a fake HttpTransport: scope empty vs configured → exactly the expected requests and no request about other owners; parallelism limit; incremental detection only for changed pushedAt; progressive callbacks; setting change → rescan; stored list of another scope not shown; getRepository/claim skipped outside the scope), `node esbuild.mjs --production`, `npm run package`. Do not commit.

## Organization selector in the view (user request, 2026-09-25: "where is the organizations selector / the organization configuration for constraining the view")
- New command `devEnvironments.selectOwners` "Select Organizations…" (category Dev Environments), as a button in the view title bar (`view/title`, group `navigation`, before Search) with the icon `$(filter)` when `devEnvLauncher.owners` is empty and `$(filter-filled)` when it is set (two menu entries with `when` on a context key such as `devEnvironments.ownersFiltered`).
- It opens a multi-select Quick Pick: the signed-in account (label = login, description "your account") and every organization the account is a member of (from `DiscoveryData.organizations`; if no list is stored yet, ask GitHub with the `viewer { login organizations }` part of the query — this request is allowed even when a scope is set, because it lists no repositories), plus the owners already in the setting that are not in these lists (so they can be removed). The current setting is pre-selected. An empty selection means "all repositories".
- OK writes `devEnvLauncher.owners` (global user setting) — the existing configuration change handler then rescans with the new scope. Not signed in → the command asks to sign in first.
- Update package.json (command, menus, context key), notes section 3 (command list), concept 6.2 (the title bar shows [Select Organizations] [Search] [Refresh] [Collapse All]) and 8 (the setting can be changed with the selector), README.
- Tests (fake vscode): items and pre-selection; empty selection → []; unknown owners kept as items; writes the setting; icon context key.
