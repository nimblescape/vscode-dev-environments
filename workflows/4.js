export const meta = {
  name: 'q-4-internals-inventory',
  description: '4: inventory of every non-public Dev Containers / CLI / VS Code / Docker Desktop dependency, verified against the installed versions, completeness rounds until dry; final check incl. CI',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Complete' }, { title: 'Synthesize' }, { title: 'Final' }],
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
const CLI = `${REPO}/node_modules/@devcontainers/cli`
const ITEMS = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    name: { type: 'string' },
    owner: { type: 'string', enum: ['dev-containers-extension', 'devcontainer-cli', 'vscode-internal', 'docker-desktop', 'github', 'other'] },
    what: { type: 'string', description: 'exactly what we rely on (value, format, command id, label, file path, env var, output text, behavior)' },
    purpose: { type: 'string' },
    locations: { type: 'array', items: { type: 'string' }, description: 'repo-relative file:line' },
    publicStatus: { type: 'string', enum: ['public-documented', 'internal-undocumented', 'unclear'] },
    evidence: { type: 'string' },
    assumptionTag: { type: 'string' },
  }, required: ['name', 'owner', 'what', 'purpose', 'locations', 'publicStatus', 'evidence', 'assumptionTag'] } } },
  required: ['items'],
}
const VERDICT_INV = {
  type: 'object',
  properties: {
    real: { type: 'boolean' }, correctedLocations: { type: 'array', items: { type: 'string' } },
    publicStatus: { type: 'string', enum: ['public-documented', 'internal-undocumented', 'unclear'] },
    verifiedIn: { type: 'string' }, holdsInInstalledVersion: { type: 'string', enum: ['yes', 'no', 'not-checkable'] },
    risk: { type: 'string', enum: ['high', 'medium', 'low'] }, failureMode: { type: 'string' }, fallback: { type: 'string' },
    isolatedInOneComponent: { type: 'boolean', description: 'NFR-06: used only in the Connection Adapter (src/vscode/connection/**, src/vscode/connectionAdapter.ts)?' },
    guardedByTest: { type: 'string', description: 'which test (contract test, Docker test, unit test) would notice a change, or none' },
  },
  required: ['real', 'correctedLocations', 'publicStatus', 'verifiedIn', 'holdsInInstalledVersion', 'risk', 'failureMode', 'fallback', 'isolatedInOneComponent', 'guardedByTest'],
}
const BASE = `You inventory NON-PUBLIC dependencies of the VS Code extension "Dev Environments" in ${REPO} (the code at HEAD; the working tree is clean). READ-ONLY: do not modify repository files, do not run builds, do not touch Docker. References: the concept ${REPO}/docs/vscode-dev-environments.md (7.8, 7.13, RK-1, V-1..V-12, NFR-06 "internal details of the Dev Containers extension are used in one component only"), ${REPO}/docs/implementation-notes.md, ${REPO}/docs/container-restrictions.md, the installed Dev Containers extension ${DC} (package.json = its public contributions; dist/extension/extension.js = its implementation, search it with python for literal strings), the Dev Container CLI ${CLI} (package.json, dist/spec-node/devContainersSpecCLI.js, node ${CLI}/devcontainer.js <command> --help), and VS Code (/Applications/Visual Studio Code.app/Contents/Resources/app). Report every place where the extension relies on a value, format, command id, file path, label, environment variable, output text, or behavior that is NOT a documented public contract (VS Code extension API, containers.dev spec, documented CLI options, documented Dev Containers settings/commands); also include public items that the concept lists as assumptions to verify (mark them public-documented). Exact file:line locations; no speculation.`
const FINDERS = [
  { key: 'connection', prompt: 'ANGLE: connecting a window to a container and window handling — the attached-container authority and its JSON, the @parent suffix, vscode-remote URIs, vscode.env.remoteName, onResolveRemoteAuthority activation and its blocking assumption, vscode.openFolder options, workbench.action.remote.close, workbench.action.reloadWindow, every executeCommand id.' },
  { key: 'attach-behavior', prompt: 'ANGLE: behavior of the Dev Containers extension on attach that the design relies on or works around — devcontainer.metadata label application (V-1), lifecycle commands not re-run, shutdownAction none (V-4), port forwarding, $BROWSER and REMOTE_CONTAINERS_IPC, copyGitConfig and its skip rule, the credential helper location, the Docker credential helper, GPG forwarding (private-keys-v1.d), the SSH agent socket, per-container settings in customizations.vscode.settings, X11.' },
  { key: 'cli', prompt: 'ANGLE: the Dev Container CLI 0.89.0 — last-line JSON result, the lifecycle failure text, the devcontainer.metadata label structure and the remoteUser rule replicated in the code, read-configuration output shape (configuration, mergedConfiguration), --user-data-folder and ociCache, --update-remote-user-uid-default, --no-lockfile, --skip-post-attach, --id-label lookup, --override-config semantics, --remove-existing-container ordering, runArgs/label ordering, how up starts a stopped container.' },
  { key: 'vscode-internal', prompt: 'ANGLE: VS Code and platform internals — command ids that are not in the API reference (workbench.action.*, workbench.action.openWalkthrough), ELECTRON_RUN_AS_NODE with process.execPath, the GitHub OAuth app client id in hint URLs, command links in notifications, activation after Close Remote Connection, the extension host PID as liveness, globalStorage shared across profiles, the GitHub authentication behavior worked around by the sign-in fix, anything reading VS Code files; Docker Desktop specifics (host.docker.internal, /var/run/docker.sock in the VM, docker desktop start, desktop.docker.com URLs, the Homebrew cask and winget ids).' },
  { key: 'sweep', prompt: "ANGLE: systematic sweep — list EVERY '// Assumption (V-' comment in src/** and test/** with file:line and report those that concern Dev Containers, the CLI, VS Code internals, or Docker Desktop; grep src/** and package.json for: attached-container, remote-containers, dev.containers, remote.containers, devcontainer.metadata, REMOTE_CONTAINERS, vscode-ssh-auth, BROWSER, vscode-remote, workbench.action, ELECTRON_RUN_AS_NODE, openWalkthrough, desktop.docker.com, docker-desktop, Docker.DockerDesktop, gpg, private-keys, gitconfig, credential — report every hit that is a dependency." },
]

phase('Find')
const found = await parallel(FINDERS.map((f) => () =>
  agent(`${BASE}\n\n${f.prompt}`, { label: `find:${f.key}`, phase: 'Find', schema: ITEMS, effort: 'max' })
    .then((r) => (r?.items ?? []).map((it) => ({ ...it, source: f.key })))))
const ikey = (it) => it.owner + '|' + String(it.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 5).join(' ')
const merged = new Map()
for (const it of found.filter(Boolean).flat()) {
  const k = ikey(it)
  const prev = merged.get(k)
  if (!prev) merged.set(k, { ...it, sources: [it.source] })
  else { prev.locations = Array.from(new Set([...(prev.locations || []), ...(it.locations || [])])); prev.sources.push(it.source); prev.evidence = prev.evidence + ' | ' + it.evidence }
}
let candidates = Array.from(merged.values())
log(`${candidates.length} candidate dependencies`)

const verifyItem = (c, label, ph) => agent(`${BASE}\n\nVERIFY ONE reported dependency. (1) open each location and confirm it is really there (correct the list); (2) decide public vs internal against ${DC}/package.json, ${DC}/dist/extension/extension.js (quote the code), the CLI (--help, source) and the VS Code API reference; (3) check it holds in the INSTALLED versions; (4) risk if it changes, the failure mode for the user, any fallback; (5) NFR-06: confined to the Connection Adapter?; (6) which test would notice a change.\nDependency: ${c.name} (owner ${c.owner})\nWhat: ${c.what}\nPurpose: ${c.purpose}\nLocations: ${(c.locations || []).join(', ')}\nEvidence: ${String(c.evidence).slice(0, 1500)}`, { label, phase: ph, schema: VERDICT_INV, effort: 'max' }).then((v) => ({ ...c, verdict: v }))

phase('Verify')
const verified = (await parallel(candidates.map((c, i) => () => verifyItem(c, `verify:${i}`, 'Verify')))).filter(Boolean)
let finalItems = verified.filter((v) => v.verdict && v.verdict.real)
log(`${finalItems.length} verified dependencies`)

phase('Complete')
for (let round = 1; round <= 3; round++) {
  const critic = await agent(`${BASE}\n\nCOMPLETENESS CRITIC (round ${round}). Verified inventory so far:\n${finalItems.map((r) => `- [${r.owner}] ${r.name}: ${r.what}`).join('\n')}\nSearch the code (src/**, package.json, resources/**, test/docker/**) for further dependencies of this kind that are MISSING. Return only new items with exact locations; an empty list is fine.`, { label: `critic:${round}`, phase: 'Complete', schema: ITEMS, effort: 'max' })
  const extra = (critic?.items ?? []).filter((it) => !finalItems.some((f) => ikey(f) === ikey(it)))
  log(`completeness round ${round}: ${extra.length} new candidates`)
  if (!extra.length) break
  const extraVerified = (await parallel(extra.map((c, i) => () => verifyItem(c, `verify-extra:${round}:${i}`, 'Complete')))).filter(Boolean)
  const added = extraVerified.filter((v) => v.verdict && v.verdict.real)
  finalItems = [...finalItems, ...added]
  if (!added.length) break
}

phase('Synthesize')
const report = await agent(`Write the final report for the user's request: "Report any Dev Containers internal API we use in our extension" (the author of the extension; plain, precise English; short sentences). Do not modify repository files; ALSO write the report as markdown to ${SP}/internals-inventory.md.\nVerified items (JSON):\n${JSON.stringify(finalItems.map((f) => ({ name: f.name, owner: f.owner, what: f.what, purpose: f.purpose, locations: f.verdict.correctedLocations, publicStatus: f.verdict.publicStatus, verifiedIn: f.verdict.verifiedIn, holds: f.verdict.holdsInInstalledVersion, risk: f.verdict.risk, failureMode: f.verdict.failureMode, fallback: f.verdict.fallback, isolated: f.verdict.isolatedInOneComponent, guardedByTest: f.verdict.guardedByTest, assumptionTag: f.assumptionTag })), null, 1)}\nStructure: 1) summary paragraph (count of internal Dev Containers dependencies, the critical one, whether NFR-06 holds — name each violation); 2) table A "Dev Containers extension — internal" (Dependency | What we rely on | Used for | Where (markdown links relative to the repo root, at most 2) | Checked in 0.470.0 | Risk | Guarded by test); 3) table B "Dev Containers extension — public, relied on as behavior"; 4) table C "Dev Container CLI 0.89.0 — not a stable contract" (note which the contract tests guard); 5) table D "VS Code, GitHub and Docker Desktop internals"; 6) "What breaks first and what to do" (3-6 concrete bullets). Only verified items; compact.`, { label: 'synthesize', phase: 'Synthesize', effort: 'max' })

phase('Final')
const final = await agent(`FINAL CHECK of the committed state of ${REPO} (the working tree should be clean). Run: npx tsc --noEmit; npx vitest run (counts); node esbuild.mjs --production; npm run package and npx vsce ls --no-dependencies; npm run test:docker (Docker runs; report timings; leftovers check); gh run list --limit 6 for the CI results of the last pushes (read-only; report failures with gh run view --log-failed). Do not modify files and do not commit; if something fails, report it precisely. First line of the answer: ALL GREEN or FAILING.`, { label: 'final:4', phase: 'Final', effort: 'max' })
return { unit: '4', counts: { candidates: candidates.length, final: finalItems.length }, report, final }
