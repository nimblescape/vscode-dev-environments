export const meta = {
  name: 'q-3-docker-wizard',
  description: '3: Install Docker offer and setup walkthrough that runs the platform installer visibly; review rounds until dry; final check',
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
const CONTEXT = `VS Code extension "Dev Environments" in ${REPO} (committed state = HEAD). Read first: the spec ${SP}/spec-docker-setup.md (your task list; the user decided that the wizard RUNS the installer, visibly in a VS Code terminal, after a modal confirmation that lists the exact commands or the download), ${REPO}/docs/vscode-dev-environments.md (6.1, 6.5, 7.3, 7.6 Docker start, section 9), ${REPO}/docs/implementation-notes.md (sections 3, 6), and the code of src/core/docker/** (dockerCli.ts, containerAdapter.ts incl. the repeated CLI lookup while it is missing, dockerStart.ts), src/vscode/controller.ts, src/vscode/sidebar.ts, src/vscode/treeModel.ts, src/vscode/extension.ts, package.json.
NEVER run an installer, a package manager install, wsl --install, or a download of an installer on this machine (Docker is installed here): test the installation plans as pure functions and the command wiring with the fake vscode module. Read-only checks are allowed (brew info --cask, curl -sI HEAD requests to URLs, fetching docs pages). ${RULES}`

phase('Implement')
const partA = await agent(`${CONTEXT}

YOUR PART A — core: a pure installation plan per platform in src/core (e.g. src/core/docker/dockerSetup.ts): installPlan({ platform, arch, osRelease, has }) -> terminal commands (with needsAdmin and a description) | download (official desktop.docker.com URL for the architecture, file name, how to open it) | manual (docs URL). macOS: Homebrew present -> brew install --cask docker-desktop (verify the current cask name with brew info --cask docker-desktop, read-only) else Docker.dmg for arm64/amd64; Windows: winget present -> winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements, else the installer .exe for amd64/arm64; WSL 2 check/installation step; Linux: Docker Engine from Docker's official repository for ubuntu, debian, fedora, rhel/centos (the commands of https://docs.docker.com/engine/install/ — fetch and follow them), then usermod -aG docker and the note about a new login; other distributions -> manual. Also the pure state function for the context keys (dockerMissing, dockerInstalled, dockerReady, wslReady) and the text of the confirmation (lists exactly the commands / URL and target file, says an administrator password may be asked in the terminal). Verify every URL with a HEAD request (no download). Table-driven tests for all platform/arch/tool/distribution combinations. Run npx tsc --noEmit and npx vitest run. Final answer: concise report incl. the verified cask name, winget id, URLs and Linux commands with their sources.`, { label: 'implement:A-plan', phase: 'Implement', effort: 'max' })

const partB = await agent(`${CONTEXT}

Part A is done (report below). YOUR PART B — the VS Code side per the spec: context keys kept current (the CLI lookup every 10 s while missing; no background docker info when installed); a viewsWelcome entry FIRST with the Install Docker… button (command devEnvironments.installDocker, category Dev Environments) and a sign-in-like row at the top when the tree has rows; the 6.5 message "Docker Desktop is not installed." gets the action Install Docker… instead of Open download page; only in a local window (in a remote window: "Open a local window to install Docker."); the walkthrough contribution (id dockerSetup, title "Set up Docker for Dev Environments", platform steps with when clauses isMac/isWindows/isLinux, media markdown in resources/walkthrough/ — included in the VSIX; completionEvents onContext for the steps: WSL 2 (Windows), Install Docker (runs the plan after the modal confirmation, visibly in a terminal named Install Docker; downloads with a cancellable progress notification into the Downloads folder, then open), Start Docker (existing ensureDockerRunning with progress; Linux: sudo systemctl enable --now docker in the terminal), Sign in with GitHub); opening it with workbench.action.openWalkthrough (mark as a VS Code command outside the extension API); after the installer: check for the CLI every 5 s up to 30 min, then update the context keys and refresh the sidebar. Windows shells: PowerShell 5 has no && — send separate lines. Update package.json (command, walkthrough, viewsWelcome, menus), notes section 3 and 6, concept 6.1 step 2, 6.5, 7.3, section 9, README. Tests with the fake vscode module; check npx vsce ls includes the walkthrough media. Run npx tsc --noEmit and npx vitest run.
Part A report:
<report>
${partA}
</report>
Final answer: concise report.`, { label: 'implement:B-wizard', phase: 'Implement', effort: 'max' })

const REPORTS = `\nImplementation reports:\n<A>\n${partA}\n</A>\n<B>\n${partB}\n</B>`
const review = await reviewLoop({
  context: CONTEXT + REPORTS,
  maxRounds: 3,
  dimensions: [
    { key: 'platform-commands', prompt: 'DIMENSION: correctness of every installation plan — Homebrew cask name, winget id and flags, WSL 2 steps, the Linux repository commands per distribution against docs.docker.com, architecture detection (Apple silicon vs Intel, Windows arm64), download URLs (HEAD requests only), PowerShell vs cmd vs bash syntax of the terminal lines, what happens after the installer (group membership, new login, Docker Desktop first start dialogs).' },
    { key: 'security', prompt: 'DIMENSION: security — nothing runs without the modal confirmation that lists exactly what runs; nothing hidden (visible terminal only); downloads only over HTTPS from desktop.docker.com; no command built from untrusted input; only in local windows; no installer ever runs in tests.' },
    { key: 'vscode-api', prompt: 'DIMENSION: VS Code integration for engines ^1.90 — the walkthrough contribution schema (steps, media, completionEvents onContext), when clauses, the openWalkthrough command id and argument format (extension id#walkthrough id), viewsWelcome order and context keys, the terminal API on each platform, cancellation of downloads, disposables, the media files in the VSIX.' },
    { key: 'ux-texts', prompt: 'DIMENSION: user experience and texts — the offer next to the sign-in button, the step texts (license note of Docker Desktop, what gets installed from where, admin password), plain language (NFR-02), at most one action besides Show details (6.5), states after install (installed but not running, running, signed in).' },
    { key: 'regressions', prompt: 'DIMENSION: regressions against HEAD — behavior changes not asked for (Docker start, the dockerNotInstalled handling, the sidebar), deleted or weakened tests, new code without tests. Run npx tsc --noEmit and npx vitest run.' },
    { key: 'docs', prompt: 'DIMENSION: documentation accuracy — concept (6.1, 6.5, 7.3, section 9), implementation notes (3, 6), README against the code.' },
  ],
  areas: [
    { key: 'core-docker', re: /^src\/core\/docker\//, scope: 'src/core/docker/**' },
    { key: 'core-other', re: /^src\/(core|monitor)\//, scope: 'other src/core/**, src/monitor/**' },
    { key: 'vscode', re: /^src\/vscode\//, scope: 'src/vscode/**' },
    { key: 'docs-manifest', re: /.*/, scope: 'docs/**, README.md, package.json, resources/walkthrough/**, test/docker/**' },
  ],
})

phase('Final')
const final = await finalCheck(CONTEXT + REPORTS, 'final:3')
return { unit: '3', partA, partB, review, final }
