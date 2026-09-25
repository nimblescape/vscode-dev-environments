export const meta = {
  name: 'q-1b-decisions',
  description: '1b: runArgs allow-list and --rm, one environment per repository and account, sign-in fix, remaining restriction gaps; review rounds until dry; final check',
  phases: [{ title: 'Implement' }, { title: 'Review' }, { title: 'Verify' }, { title: 'Fix' }, { title: 'Final' }],
}
const REPO = '/Users/hs/workspace/projects/vscode-dev-environments'
const SP = '/private/tmp/claude-501/-Users-hs-workspace-projects-vscode-dev-environments/bce08af7-c1a4-4ec6-b4fd-f0585152ddc7/scratchpad'
const DC = '/Users/hs/.vscode/extensions/ms-vscode-remote.remote-containers-0.470.0'
const RULES = 'Rules: match the surrounding code style (2 spaces, single quotes, named exports, sparse why-comments, doc comments on exports); src/core never imports vscode; every NEW source file (.ts/.mjs/.mts/Dockerfile) starts with the three-line SPDX license header of the existing files (src/licenseHeaders.test.ts enforces it); pure logic in files without vscode imports, with table-driven unit tests; never weaken, skip or delete tests to make them pass; keep all existing tests passing; user-visible texts in plain language (NFR-02), exact concept texts where the concept gives them. Docker Desktop runs on this Mac and npm run test:docker works; never touch Docker objects you did not create (the user\'s environments devenv-majikmate-* and the volume mmc-development-postgres-data must never be touched). Do NOT commit or push: the orchestrator commits after the checks.'

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
const CONTEXT = `VS Code extension "Dev Environments" in ${REPO} (committed state = HEAD: account separation, container-only Git, host access policy, MIT license headers). Read first: the spec ${SP}/spec-decisions-policy-per-account.md (your task list: decision 1 runArgs allow-list and --rm; decision 2 one environment per repository AND GitHub account; bug 3 sign-in with a rejected token — the BUTTON NAME, the welcome texts and the sign-in row stay EXACTLY as they are; the findings of the restrictions summary), ${REPO}/docs/container-restrictions.md (section 11 known gaps; gaps 1 and 2 are fixed already), ${REPO}/docs/vscode-dev-environments.md, ${REPO}/docs/implementation-notes.md, the analyses ${SP}/w1-analysis-runargs-allowlist.md and ${SP}/w1-analysis-per-account-environments.md, and the last integration report ${SP}/w1-final.md.
User requirements that must hold: (a) VS Code port forwarding to localhost and opening URLs in the LOCAL browser ($BROWSER, openExternal, Open in Browser) keep working; (b) the container reaches everything the Mac reaches on the network, including VPN (no network restriction; --network host allowed). The Dev Containers extension 0.470.0 is installed at ${DC} — verify behavior claims in its dist/extension/extension.js. ${RULES}`

phase('Implement')
const partA1 = await agent(`${CONTEXT}

YOUR STEP A1 — analysis only, NO code changes: verify in ${DC}/dist/extension/extension.js (search with python for literal strings; quote the minified code) (1) what the REMOTE_CONTAINERS_IPC socket carries (which request types: git credential helper, docker credential helper, BROWSER/openExternal, code CLI, others), (2) how $BROWSER, vscode.env.openExternal and "Open in Browser" of a forwarded port reach the local browser in an attached container (which channel: REMOTE_CONTAINERS_IPC, VSCODE_IPC_HOOK_CLI of the VS Code server, or other), (3) which Dev Containers settings the extension reads per container from customizations.vscode.settings / the metadata label (e.g. copyGitConfig, gitCredentialHelperConfigLocation, dockerCredentialHelper, githubCLILoginWithToken) versus only from the user settings, (4) the exact rule by which copyGitConfig skips the copy. Write the result to ${SP}/gap3-analysis.md and return it. Final answer: the analysis with code quotes and a clear recommendation for gap 3 that keeps requirement (a).`, { label: 'implement:A1-analysis', phase: 'Implement', effort: 'max' })

const partA2 = await agent(`${CONTEXT}

YOUR STEP A2 — decision 1 only: extend the runArgs allow-list exactly per the spec and ${SP}/w1-analysis-runargs-allowlist.md (each added flag with a one-line reason in the rule table); remove --rm with a log line using the SAME flag parser as the check; re-check the final runArgs that docker gets. Table-driven tests including the exact bypass inputs of the spec (non-string entries, --name as the value of another flag). Update the planned markers of decision 1 in docs/container-restrictions.md and the concept section 9. Run npx tsc --noEmit and npx vitest run. Final answer: concise report.`, { label: 'implement:A2-allowlist', phase: 'Implement', effort: 'max' })

const partA3 = await agent(`${CONTEXT}

Steps A1 (analysis) and A2 (allow-list) are done (reports below). YOUR STEP A3 — the remaining known gaps of docs/container-restrictions.md section 11 / spec findings 3-7: gap 3 per the A1 analysis (neutralize the credential channel only if requirement (a) keeps working; otherwise document precisely why it stays); gap 4 — foreign named volumes (at least 'vscode'); gap 5 — refuse runArgs labels with the prefix 'devenv.'; gap 6 — refuse -e/--env/--env-file and configuration containerEnv/remoteEnv entries that set GIT_CONFIG_*, DOCKER_CONFIG, GNUPGHOME, GIT_SSH_COMMAND, SSH_AUTH_SOCK, REMOTE_CONTAINERS_IPC (decide for --env-file: refuse, or allow only inside /workspaces with a documented limit); gap 7 — document as a limit. Update docs/container-restrictions.md (section 11 statuses), concept section 9 and the notes. Tests: table-driven; Docker test: a configuration with --platform linux/amd64, --cap-drop ALL and --rm passes and the container has HostConfig.AutoRemove=false. Run npx tsc --noEmit, npx vitest run, npm run test:docker.
A1 analysis:
<report>
${partA1}
</report>
A2 report:
<report>
${partA2}
</report>
Final answer: concise report.`, { label: 'implement:A3-gaps', phase: 'Implement', effort: 'max' })
const partA = `A1 analysis:\n${partA1}\n\nA2 allow-list:\n${partA2}\n\nA3 gaps:\n${partA3}`

const partB1 = await agent(`${CONTEXT}

Part A is done (report below). YOUR STEP B1 — decision 2 (one environment per repository AND GitHub account), CORE ONLY (src/core/**, no src/vscode changes): per ${SP}/w1-analysis-per-account-environments.md — registry uniqueness per (repository, owner) (case-insensitive repository); account-aware lookups in the registry and the environment service (replace repository-only lookups; every caller passes the account); the first open of a second account creates its own environment; the legacy-claim rule (a claim succeeds only if the claiming account has no environment of that repository yet); names and labels; reconcileFromVolumes with owners; the Session Monitor with several environments per repository. Unit tests incl. two accounts with the same repository give two environments. Run npx tsc --noEmit (report errors in src/vscode that B2 must fix) and npx vitest run for src/core and src/monitor. Final answer: concise report incl. the changed core API that the VS Code layer must use.
Part A report:
<report>
${partA}
</report>`, { label: 'implement:B1-core', phase: 'Implement', effort: 'max' })

const partB2 = await agent(`${CONTEXT}

Part A and step B1 are done (reports below). YOUR STEP B2 — decision 2, VS Code layer and docs: adapt src/vscode/** to the core API of B1 (sidebar, switcher, search, reopen, pending operations, disconnect requests, the Start/Stop/Delete/Rebuild/Switch branch/Select configuration flows); no message, log line, row or tooltip reveals another account's environment (the otherAccount case for Start on a repository disappears: a second account gets its own environment). Update concept D-3, 6.2, 7.5, section 5 (disk space per account), the notes, README and docs/container-restrictions.md (finding 8 resolved). Tests with the fake vscode module; Docker test: two owners, same repository -> two volumes and containers. Run npx tsc --noEmit (0 errors), npx vitest run, npm run test:docker.
Part A report:
<report>
${partA}
</report>
B1 report:
<report>
${partB1}
</report>
Final answer: concise report.`, { label: 'implement:B2-vscode', phase: 'Implement', effort: 'max' })
const partB = `B1 core:\n${partB1}\n\nB2 VS Code layer:\n${partB2}`

const partC = await agent(`${CONTEXT}

Parts A and B are done (reports below). YOUR PART C — bug 3 of the spec: Sign in with GitHub cannot replace a token that GitHub rejects. The button name, the welcome texts and the sign-in row stay EXACTLY as they are (user decision). Behind the unchanged command devEnvironments.signIn: remember a rejected token (per session id); while rejected, request getSession(..., { forceNewSession: true }) instead of createIfNone; clear the state when a session with another id/token arrives or a request succeeds; comment it as a workaround for VS Code keeping a GitHub session whose token GitHub rejects. Set the context key devEnvironments.signedIn in ONE place with one meaning (a rejected session does not count as signed in). Every GitHub caller that gets HTTP 401 (discovery refresh, listBranches, getRepository, clone, the ghcr check via the session, the container token) reports it to that one place. Tests with the fake vscode module. Run npx tsc --noEmit and npx vitest run.
Part A report:
<report>
${partA}
</report>
Part B report:
<report>
${partB}
</report>
Final answer: concise report.`, { label: 'implement:C-sign-in', phase: 'Implement', effort: 'max' })

const REPORTS = `\nImplementation reports:\n<A>\n${partA}\n</A>\n<B>\n${partB}\n</B>\n<C>\n${partC}\n</C>`
const review = await reviewLoop({
  context: CONTEXT + REPORTS,
  maxRounds: 3,
  dimensions: [
    { key: 'policy', prompt: 'DIMENSION: the host access policy after the changes — bypasses (flag spellings, value-of-another-flag tricks, non-string entries, environment overrides, devenv labels, foreign volumes, Features and image metadata, build options), that the --rm removal and the final re-check use the same parser, that requirements (a) and (b) still hold, and that docs/container-restrictions.md matches the code.' },
    { key: 'per-account', prompt: 'DIMENSION: one environment per repository and account — every lookup, uniqueness check, claim, name and label, reconcile, sidebar/switcher/search/reopen/pending operation/disconnect request/Session Monitor path with two environments of one repository; nothing reveals another account\'s environment (messages, logs, rows, tooltips).' },
    { key: 'sign-in', prompt: 'DIMENSION: the sign-in fix — the rejected-token state, the forceNewSession path, the single place for devEnvironments.signedIn, every 401 caller, races with onDidChangeSessions, the button name and welcome texts unchanged, no token or account data in logs.' },
    { key: 'data-safety', prompt: 'DIMENSION: data safety (NFR-07) and pipeline correctness — never delete or change another environment\'s volume or container; a working container is never removed before its replacement is ready; busy marks, pending files and refusals on every new failure path; the Session Monitor with several environments per repository.' },
    { key: 'regressions', prompt: 'DIMENSION: regressions against HEAD — behavior changes the spec did not ask for; deleted or weakened tests (git diff HEAD -- "*.test.ts" test/); new code without tests. Run npx tsc --noEmit and npx vitest run and report failures.' },
    { key: 'docs', prompt: 'DIMENSION: documentation accuracy — concept (D-3, 6.2, 7.5, section 5, section 9), implementation notes, README and docs/container-restrictions.md against the code; one mismatch per finding with both locations.' },
  ],
  areas: [
    { key: 'core-helper', re: /^src\/core\/(helper|git)\//, scope: 'src/core/helper/**, src/core/git/**' },
    { key: 'core-pipeline', re: /^src\/core\/pipeline\//, scope: 'src/core/pipeline/**' },
    { key: 'core-other', re: /^src\/(core|monitor)\//, scope: 'other src/core/** (storage, ownership, discovery, docker, imageCheck), src/monitor/**' },
    { key: 'vscode', re: /^src\/vscode\//, scope: 'src/vscode/**' },
    { key: 'docs-tests', re: /.*/, scope: 'docs/**, README.md, package.json, test/docker/**' },
  ],
})

phase('Final')
const final = await finalCheck(CONTEXT + REPORTS, 'final:1b')
return { unit: '1b', partA1, partA2, partA3, partB1, partB2, partC, review, final }
