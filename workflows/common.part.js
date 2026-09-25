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
