export const meta = {
  name: 'q-2-discovery-scope',
  description: '2: devEnvLauncher.owners as scan scope, parallel and incremental discovery, progressive display, organization selector; review rounds until dry; final check',
  phases: [{ title: 'Implement' }, { title: 'Review' }, { title: 'Verify' }, { title: 'Fix' }, { title: 'Final' }],
}
const REPO = '/Users/hs/workspace/projects/vscode-dev-environments'
const SP = '/private/tmp/claude-501/-Users-hs-workspace-projects-vscode-dev-environments/bce08af7-c1a4-4ec6-b4fd-f0585152ddc7/scratchpad'
const DC = '/Users/hs/.vscode/extensions/ms-vscode-remote.remote-containers-0.470.0'
const RULES = 'Rules: match the surrounding code style (2 spaces, single quotes, named exports, sparse why-comments, doc comments on exports); src/core never imports vscode; every NEW source file (.ts/.mjs/.mts/Dockerfile) starts with the three-line SPDX license header of the existing files (src/licenseHeaders.test.ts enforces it); pure logic in files without vscode imports, with table-driven unit tests; never weaken, skip or delete tests to make them pass; keep all existing tests passing; user-visible texts in plain language (NFR-02), exact concept texts where the concept gives them. Docker Desktop runs on this Mac and npm run test:docker works; never touch Docker objects you did not create (the user\'s environments devenv-majikmate-* and the volume mmc-development-postgres-data must never be touched). Do NOT commit or push: the orchestrator commits after the checks. Never use SendMessage or any agent-to-agent message (a message to another workflow agent starts a second copy of it that edits the same files); coordinate only through the working tree and your final report.'

const FINDINGS = {
  type: 'object',
  properties: { findings: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, file: { type: 'string' }, line: { type: 'number' },
    description: { type: 'string' }, failureScenario: { type: 'string' }, suggestedFix: { type: 'string' },
  }, required: ['title', 'severity', 'file', 'line', 'description', 'failureScenario', 'suggestedFix'] } } },
  required: ['findings'],
}
const VERDICT = { type: 'object', properties: { verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, reasoning: { type: 'string' }, fixGuidance: { type: 'string' } }, required: ['verdict', 'severity', 'reasoning', 'fixGuidance'] }
const DEDUP = { type: 'object', properties: { groups: { type: 'array', items: { type: 'object', properties: { indices: { type: 'array', items: { type: 'number' } } }, required: ['indices'] } } }, required: ['groups'] }
const LENSES = [
  'Lens CODE PATH: trace the exact code path end to end across modules; does the failure scenario really happen with the current code?',
  'Lens REQUIREMENTS: does the spec, the concept, or a documented user decision demand this, or is the reported behavior deliberate?',
  'Lens REPRODUCE: demonstrate it with a throwaway unit test or node snippet under /private/tmp (never in the repository) using the real modules, or with concrete values; refute if you cannot make it happen.',
]
const SEV = ['high', 'medium', 'low']
const norm = (p) => String(p || '').replace(REPO + '/', '').replace(/^\.\//, '')
const fkey = (f) => norm(f.file) + '|' + String(f.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70)

async function dedup(list, round) {
  const d = await agent(`Group duplicate code-review findings: findings that describe the SAME defect (same root cause, even from different angles) go into one group; every index must appear in exactly one group.\n${list.map((f, i) => `#${i} [${f.source}] ${f.file}:${f.line} - ${f.title}: ${String(f.description).slice(0, 300)}`).join('\n')}`, { label: `dedup${round}`, phase: 'Review', schema: DEDUP })
  if (!d || !d.groups || !d.groups.length) return list
  const seen = new Set()
  const out = []
  for (const g of d.groups) {
    const idx = (g.indices || []).filter((i) => i >= 0 && i < list.length && !seen.has(i))
    if (!idx.length) continue
    idx.forEach((i) => seen.add(i))
    const primary = idx.map((i) => list[i]).sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity))[0]
    out.push({ ...primary, alsoReportedBy: idx.map((i) => list[i].source), related: idx.map((i) => `${list[i].file}:${list[i].line} ${list[i].title}`) })
  }
  list.forEach((f, i) => { if (!seen.has(i)) out.push(f) })
  return out
}

async function reviewLoop(o) {
  const handledTitles = []
  const seenKeys = new Set()
  const confirmedAll = []
  const rounds = []
  let dry = 0
  for (let round = 1; round <= o.maxRounds && dry < 1; round++) {
    const handled = handledTitles.slice(-150).map((t) => '- ' + t).join('\n') || '(none)'
    const found = await parallel(o.dimensions.map((d) => () =>
      agent(`${o.context}\n\nYou are a skeptical reviewer (round ${round}) of the UNCOMMITTED changes on top of HEAD (git -C ${REPO} diff HEAD; git status; new files are untracked). ${d.prompt}\nFindings already handled in earlier rounds (do NOT report them again unless their fix is wrong):\n${handled}\nReport ONLY real defects with a concrete failure scenario and exact file:line; verify each suspicion by reading the code paths end to end. No style remarks. Do NOT modify files. Up to 12 findings; an empty list is a good result.`, { label: `review${round}:${d.key}`, phase: 'Review', schema: FINDINGS, effort: 'max' })
        .then((r) => (r?.findings ?? []).map((f) => ({ ...f, source: d.key })))))
    let fresh = found.filter(Boolean).flat().filter((f) => !seenKeys.has(fkey(f)))
    if (fresh.length > 1) fresh = await dedup(fresh, round)
    fresh.forEach((f) => { seenKeys.add(fkey(f)); handledTitles.push(`${norm(f.file)}: ${f.title}`) })
    log(`review round ${round}: ${fresh.length} new findings`)
    if (!fresh.length) { dry++; rounds.push({ round, found: 0, confirmed: 0 }); continue }
    const verified = await parallel(fresh.map((f, i) => () =>
      parallel(LENSES.map((lens, j) => () =>
        agent(`${o.context}\n\nSkeptical verifier. Try to REFUTE this reported defect. ${lens} Default to refuted if the evidence is weak. Never modify repository files.\nFinding [${f.severity}] (${(f.alsoReportedBy || [f.source]).join(', ')}): ${f.title}\nlocation: ${f.file}:${f.line}\n${f.description}\nfailure scenario: ${f.failureScenario}\nsuggested fix: ${f.suggestedFix}${f.related ? '\nrelated reports: ' + f.related.join(' | ') : ''}\nFor a confirmed defect give precise fix guidance (files, change, test).`, { label: `verify${round}:${i}:${j}`, phase: 'Verify', schema: VERDICT, effort: 'max' })))
        .then((vs) => {
          const ok = vs.filter(Boolean)
          const c = ok.filter((v) => v.verdict === 'confirmed')
          return { ...f, votes: ok.map((v) => v.verdict), confirmed: c.length >= 2, verdicts: c.length ? c : ok }
        })))
    const confirmed = verified.filter(Boolean).filter((f) => f.confirmed)
    log(`review round ${round}: ${confirmed.length} of ${fresh.length} confirmed`)
    rounds.push({ round, found: fresh.length, confirmed: confirmed.length, notConfirmed: verified.filter(Boolean).filter((f) => !f.confirmed).map((f) => ({ title: f.title, votes: f.votes })) })
    if (!confirmed.length) { dry++; continue }
    dry = 0
    const groups = {}
    for (const f of confirmed) {
      const a = o.areas.find((x) => x.re.test(norm(f.file))) || o.areas[o.areas.length - 1]
      ;(groups[a.key] = groups[a.key] || { a, items: [] }).items.push(f)
    }
    const fixes = await parallel(Object.values(groups).map((g) => () =>
      agent(`${o.context}\n\nFix CONFIRMED findings (review round ${round}) in AREA "${g.a.key}" (${g.a.scope}). Other fixers work IN PARALLEL on other areas: edit only files of your area plus their tests; describe any needed change elsewhere precisely under "cross-area".\n${g.items.map((f) => `### ${f.title} [${f.verdicts[0].severity}]\n${f.file}:${f.line}\n${f.description}\nfailure: ${f.failureScenario}\nverifier guidance: ${f.verdicts.map((v) => v.fixGuidance).join(' / ')}`).join('\n\n')}\nFix each root cause minimally in the surrounding style, with a unit test that fails without the fix. Run npx tsc --noEmit (your files must be clean) and npx vitest run for your area. Final answer: per finding fixed / not fixed (why) / cross-area (exactly what, where).`, { label: `fix${round}:${g.a.key}`, phase: 'Fix', effort: 'max' })))
    const integration = await agent(`${o.context}\n\nIntegration after fix round ${round}. Fix reports:\n${fixes.filter(Boolean).map((r, i) => `--- report ${i}\n${r}`).join('\n')}\nApply every cross-area change described (read code and requirements first; add tests). Then npx tsc --noEmit must report 0 errors and npx vitest run must pass completely (fix root causes; never weaken tests). Final answer: what you applied, command results with counts.`, { label: `integrate${round}`, phase: 'Fix', effort: 'max' })
    rounds[rounds.length - 1].integration = String(integration || '').slice(0, 2000)
    confirmedAll.push(...confirmed.map((f) => ({ round, title: f.title, severity: f.verdicts[0].severity, file: norm(f.file), source: f.source, votes: f.votes })))
  }
  return { rounds, confirmed: confirmedAll }
}

async function finalCheck(context, label) {
  return agent(`${context}\n\nFINAL CHECK of the uncommitted work before the orchestrator commits it. Run from ${REPO} and fix any failure at its root (never weaken tests): 1) npx tsc --noEmit (0 errors); 2) npx vitest run (all pass; report counts); 3) node esbuild.mjs --production; 4) npm run package and npx vsce ls --no-dependencies (expected: package.json, README.md, LICENSE, dist/extension.js, dist/sessionMonitor.js, resources/icon.svg, resources/helper/Dockerfile, plus any resources the task added on purpose); 5) npm run test:docker (Docker runs; must pass; report timings) and confirm nothing it created is left (compare docker ps -a / volume ls / images before and after); 6) git status: no stray files (.DS_Store, logs, backups, scratch files) — remove them; 7) the docs (concept, implementation notes, README, docs/container-restrictions.md) match the code for everything this work changed. Final answer: command results with counts and timings, anything you fixed, anything still failing (be explicit: FAILING or ALL GREEN on the first line).`, { label, phase: 'Final', effort: 'max' })
}
const CONTEXT = `VS Code extension "Dev Environments" in ${REPO} (committed state = HEAD, which already contains account separation, one environment per repository and account, the host access policy and the sign-in fix). Read first: the spec ${SP}/spec-discovery-scope.md (your task list, including the section "Organization selector in the view"), ${REPO}/docs/vscode-dev-environments.md (6.1, 6.2, 7.4, section 8), ${REPO}/docs/implementation-notes.md, and the code of src/core/discovery/**, src/vscode/sidebar.ts, src/vscode/controller.ts, src/vscode/extension.ts, src/vscode/settings.ts, src/core/ownership.ts, package.json.
Background: the user has 664 repositories (489 with a configuration) across several organizations; one full load took about 100 s (GitHub needs about 3 s per request of 50 repositories, 14 requests one after another). The user decided: devEnvLauncher.owners becomes the SCAN SCOPE — when configured, the extension sends GitHub requests ONLY about repositories of these owners (no other scan or lookup); empty = scan everything as today. The organization selector is a button in the view title bar. ${RULES}`

phase('Implement')
const partA = await agent(`${CONTEXT}

YOUR PART A — discovery core: per-owner queries for a configured scope (organizations and user accounts; the signed-in user's own login via viewer.repositories with the OWNER affiliation), at most 4 requests at the same time, incremental configuration detection (list fields first; configuration lookups as aliased batch queries only for new repositories or repositories whose pushedAt changed; the stored detection result per repository), progressive results during the FIRST load (callback/event per page or owner), the stored list records its scope (a list of another scope is never shown), unknown/inaccessible owners give a hint row text (messages.ts), and every repository lookup, claim check and branch/configuration query outside the scope is skipped. Keep: per-account storage, serialized refreshes, request timeouts and smaller-page retries, organization hints. Tests with a fake HttpTransport: exact requests for empty vs configured scope (no request about other owners), the parallel limit, incremental detection, progressive callbacks, stored-scope handling, lookups skipped outside the scope. Measure with a fake transport that adds 3 s latency per request (664 repositories, realistic owner split) and report the modeled first-load and refresh times before and after; optionally time the real query shapes read-only with gh api graphql (never print or store tokens). Run npx tsc --noEmit and npx vitest run. Final answer: concise report with the measurements.`, { label: 'implement:A-discovery', phase: 'Implement', effort: 'max' })

const partB = await agent(`${CONTEXT}

Part A is done (report below). YOUR PART B — the VS Code side: the setting devEnvLauncher.owners as scan scope (new description in package.json and concept section 8: "Scan only the repositories of these organizations or accounts. An empty list scans all repositories that you can access."); a settings change rescans at once; the sidebar shows repositories progressively during the first load (no flicker on later refreshes); the organization selector: command devEnvironments.selectOwners "Select Organizations…" as a view title button before Search, icon $(filter) when the setting is empty and $(filter-filled) when set (context key), a multi-select Quick Pick with the signed-in account ("your account"), every organization of the account (stored data, or the viewer/organizations part of the query when nothing is stored — it lists no repositories), plus owners in the setting that are not in these lists; current selection pre-selected; empty selection = all; OK writes the global user setting; not signed in -> sign in first. Update package.json (command, menus, context key), notes section 3, concept 6.2 (title bar) and 8, README. Tests with the fake vscode module. Run npx tsc --noEmit and npx vitest run.
Part A report:
<report>
${partA}
</report>
Final answer: concise report.`, { label: 'implement:B-selector', phase: 'Implement', effort: 'max' })

const REPORTS = `\nImplementation reports:\n<A>\n${partA}\n</A>\n<B>\n${partB}\n</B>`
const review = await reviewLoop({
  context: CONTEXT + REPORTS,
  maxRounds: 3,
  dimensions: [
    { key: 'scope-strictness', prompt: 'DIMENSION: with a configured scope, NO GitHub request concerns repositories outside it — trace every caller of the GitHub API (refresh, lookups of unlisted environments, claims, listBranches, configurationsOnBranch, getRepository, hints, the selector) with fake data.' },
    { key: 'performance-correctness', prompt: 'DIMENSION: discovery correctness and speed — pagination per owner, the parallel limit, incremental detection (a changed configuration is always detected; nothing stale is shown), partial failures (one owner fails, SAML/OAuth errors, timeouts), progressive display during the first load, stored-scope handling, per-account storage.' },
    { key: 'selector-ui', prompt: 'DIMENSION: the organization selector and the setting — Quick Pick items and pre-selection, empty selection, owners not in the lists, writing the setting (global target), the icon context key, not signed in, account switch, settings change triggering exactly one rescan.' },
    { key: 'accounts-interplay', prompt: 'DIMENSION: interplay with account separation and one environment per repository and account — environments outside the scope stay usable per the account rules without GitHub lookups; legacy claims outside the scope; hints; switching accounts with different scopes.' },
    { key: 'regressions', prompt: 'DIMENSION: regressions against HEAD — changed behavior not asked for; deleted or weakened tests (git diff HEAD -- "*.test.ts" test/); new code without tests. Run npx tsc --noEmit and npx vitest run.' },
    { key: 'docs', prompt: 'DIMENSION: documentation accuracy — concept (6.1, 6.2, 7.4, 8), implementation notes, README against the code; one mismatch per finding.' },
  ],
  areas: [
    { key: 'core-discovery', re: /^src\/core\/discovery\//, scope: 'src/core/discovery/**' },
    { key: 'core-other', re: /^src\/(core|monitor)\//, scope: 'other src/core/**, src/monitor/**' },
    { key: 'vscode', re: /^src\/vscode\//, scope: 'src/vscode/**' },
    { key: 'docs-manifest', re: /.*/, scope: 'docs/**, README.md, package.json, test/docker/**' },
  ],
})

phase('Final')
const final = await finalCheck(CONTEXT + REPORTS, 'final:2')
return { unit: '2', partA, partB, review, final }
