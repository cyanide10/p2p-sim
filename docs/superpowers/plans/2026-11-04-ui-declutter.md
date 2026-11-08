# UI declutter and enhancement: implementation plan

> For agentic workers: execute task by task; each task ends with its tests green and a commit. Steps use checkboxes.

**Goal:** reduce information duplication and control overload across the p2p-sim GUI, extract genuinely shared UI into components, and leave every page with one authoritative place per fact and a consistent visual system.

**Scope:** `web/src` only. No gateway or node changes; API shapes are untouched, so nothing needs re-verification against the gateway.

**Architecture:** keep the hash-router SPA structure (`App.tsx` routes). Add a `web/src/components/` layer of shared primitives (page heading, notices, stat strip, panels, empty state, chart scaffolds, run widgets), then migrate each page onto them while deleting page-local duplicates. CSS moves toward design tokens while class names stay stable where possible to minimize churn.

**Reference audit:** `file:line` references in this plan came from a code audit on 2026-11-04 against the current tree; re-check line numbers before acting — refactors shift them.

## Global constraints

- No file under `gateway/`, `node/`, `sim/` or `config/` changes.
- No new runtime dependency. Charts stay hand-rolled SVG, now behind shared primitives instead of per-page copies.
- Behavior preserved: same routes, polling intervals, mock scenarios, resubmit flow. This is a declutter pass, not a redesign — no page loses a capability (things get grouped/collapsed instead of deleted).
- Every task must keep `npm run typecheck`, `npm run test`, `npm run build` green.
- Pure helpers extracted from pages get unit tests (match existing `web/src/lib/*.test.ts` style).
- Accessibility: fixes must not regress what already works (peer matrix table, `role="img"` chart labels, `aria-live` summary strips).

## Review focus

1. Deduplication must not drop meaning: a fact removed from one place must still be visible in its authoritative place. Owned by every Task in Phase 3.
2. Structure-only merges (`PDESLiveView`/`AttackLiveView`, chart primitives) must produce byte-similar rendering per view. Owned by Task 8 and Task 6.
3. Collapsed "Advanced" sections must be header-clickable, keyboard-operable, and remember-open state within a page session where it matters (Network generator settings). Owned by Task 11.
4. CSS consolidation (5 stat-strip variants) must keep each page's visual identity until Phase 5 unifies spacing/tokens deliberately. Owned by Task 5.
5. Removing dead UI (History-SOON, placeholder `TaskGrid`, map `GRID:` label) must not break navigation or tests that assert their presence. Owned by Task 1.

## File map

```
web/src/App.tsx                            sidebar/topbar cleanup, ClusterPage dedupe
web/src/pages/LaunchPage.tsx               advanced knobs grouping, jargon pass
web/src/pages/LivePage.tsx                 merge PDES/Attack live views, metric dedupe
web/src/pages/ReportPage.tsx               metric card simplification, parameters details
web/src/pages/NetworkPage.tsx              single seed input, advanced generator panel, zone demotion
web/src/pages/TrafficPage.tsx              stat dedupe, reuse SharedStateBadge, chart migration
web/src/pages/AttackPage.tsx               threat index once, rail merge, chart merge, debug label removal
web/src/pages/NetworkReport.tsx            heat-vs-table dedupe, CopyJsonButton, chart migration
web/src/pages/PDESReport.tsx               readable MetricTable, CopyJsonButton
web/src/pages/AttackReport.tsx             strip consolidation, CopyJsonButton
web/src/components/RunBits.tsx             extend: SharedStateBadge, ProgressBar reuse
web/src/components/PagePrimitives.tsx      PageHeading, SectionTitle/Panel, Notice, StatStrip, EmptyState (new)
web/src/components/PartitionTiming.tsx     partition timing stacked bars (new)
web/src/components/CopyJsonButton.tsx      copy-JSON button (new)
web/src/components/charts/AxisFrame.tsx    SVG axes, gridlines, hover+tooltip, legend (new)
web/src/components/charts/LineChart.tsx    time-series line/area on AxisFrame (new)
web/src/lib/chart.ts                       extend (domain, ticks, labels) with tests
web/src/style.css                          token block, retire 5 stat-strip variants, section-header unification
```

## Task list

### Phase 1 — Remove dead weight and fix naming

## Task 1: dead UI, copy drift, leftovers

- [x] Remove or consciously defer the disabled `History` nav item (`App.tsx:181`). Keep the route absent; `#/history` already falls through to the not-found state. If removed, delete the `Clock3` import if unused.
- [x] Update topbar copy (`App.tsx:186`): "Distributed queueing simulator" no longer describes the app (network lab, threat lab, PDES). Rewrite as product-neutral, e.g. "Node pool simulator harness". Right side keeps `LOCAL PREVIEW` / `GATEWAY`.
- [x] Align nav labels with page `<h1>`s: "Network lab" → Network (`NetworkPage.tsx:274`), "Threat lab" → Attack (`AttackPage.tsx:445`), "Live traffic" → Traffic (`TrafficPage.tsx:324`). Pick one naming scheme from: nav = page title. Sidebar caption "SIMULATION CONTROL" and footer stay.
- [x] Remove the `GRID: {MAP_CENTER.x}/{MAP_CENTER.y} · SEED {config.seed}` debug label (`AttackMap.tsx:282`). Seed already shows in the page header tag (`AttackPage.tsx:451`).
- [x] Hide the always-placeholder `TaskGrid` ("Per-replication view needs node API support", `RunBits.tsx:56-66`) behind the existing mock note (`RunBits.tsx:88`) or drop rendering when no per-replication data exists — Live pages must not show a structurally-empty grid.
- [x] Unify `mockEnabled` prop plumbing: `NetworkPage.tsx:62` declares it unused, `AttackPage.tsx:219` lacks it. Either thread it consistently (mock-designed pages show the dev scenario picker mismatch today) or document why each page opts out. Keep the dev-only scenario `<select>` gated on `import.meta.env.DEV` (`App.tsx:78-85`).
- [x] `npm run typecheck && npm run test && npm run build` → commit.

### Phase 2 — Shared primitives (structure only, no redesign)

## Task 2: PagePrimitives — headings, sections, panels, notices, empty state

- [x] Extract `PageHeading` (eyebrow + title + lede + `heading-actions` slot), used 10× across pages (e.g. `App.tsx:71-90`, `NetworkPage.tsx:274-280`, `AttackPage.tsx:445-453`).
- [x] Extract `SectionTitle` (`h2` + count/span, e.g. `App.tsx:108`, `127`) and `Panel` (+ `panel-title`) covering `pdes-panel-heading`, `attack-rail-title`, `attack-chart-head` variants — one DOM shape, allow tone via prop.
- [x] Extract `Notice` wrapping `notice notice-error|warning|info` (25+ call sites) and `EmptyState` (8 call sites) with standard icon/title/body/action slots.
- [x] No CSS redesign in this task: move the existing style blocks to share one rule set per component where they are currently near-copies.
- [x] `typecheck/test/build`, spot-check each page renders identically → commit.

## Task 3: StatStrip — one component, five variants retired

- [x] Inventory the five stat-strip sisters: `summary-strip` (`App.tsx:95-100`, `style.css:268`), `meta-strip` (LivePage), `traffic-tiles` (`TrafficPage.tsx:373-377+`), `pdes-summary-grid` (`PDESReport.tsx`, `AttackReport.tsx:103-120`), `attack-metrics` (`AttackPage.tsx:686-693`).
- [x] Extract `StatStrip`/`StatCard` supporting: plain number, `n/m` composite, theory comparison (`x vs y`), icon, live-clock value, `aria-live` region. Per-page variants become props, not new CSS classes.
- [x] Collapse the five CSS section variants into one `.stat-strip`/`.stat-card` pair plus minimal modifier classes. Visual diff acceptable only where duplication forces it; keep per-page sizing tones.
- [ ] `typecheck/test/build` → commit.

## Task 4: CopyJsonButton + PartitionTiming extraction

- [x] Extract `CopyJsonButton` from the 4 verbatim copies (`ReportPage.tsx:106-115`, `NetworkReport.tsx:92-95`, `PDESReport.tsx:37-43`, `AttackReport.tsx:63-67`): copied-state timer, label, payload prop.
- [x] Extract `PartitionTimingList` from the 4 near-identical stacked-bar copies (`LivePage.tsx:297-311`, `403-417`, `PDESReport.tsx:70-82`, `AttackReport.tsx:123-136`): props = partitions, timings, max/hue option. Pure scaling helper goes in `lib/` with a unit test.
- [x] Migrate all four call sites; delete local copies.
- [x] `typecheck/test/build` → commit.

## Task 5: chart primitives — AxisFrame and LineChart

- [x] Inventory of duplicated SVG scaffolding: `TrafficPage.tsx:110-221` (W=600/H=230, axes, `useHover`, tooltip) ≈ `NetworkReport.tsx:18-77` (W=640/H=240, same pattern); `AttackLoadChart`/`AttackImpactChart` (`AttackPage.tsx:73-131`, `133-189`) are ~60-line twins (pad/seek/grid/axis); dot-whisker `ReportPage.tsx:17-37`; `lib/chart.ts` holds only `chartDomain` + `niceScale` and is underused.
- [x] Add `AxisFrame` (viewBox, pad constants, x/y scale functions, gridlines, axis ticks + labels, hover crosshair + tooltip slot, keyboard-focusable tooltip when hover data is essential) and `LineChart`/`AreaLine` on top. Extend `lib/chart.ts` helpers with tests: scale mapping, tick generation, hover→data index, accessibility labels.
- [x] Migrate `_Traffic_` and `_NetworkReport_` time-series first (closest twins), then Attack twin charts (single `AttackChart` component, two datasets/captions), then ReportPage dot-whisker. Rendering per page must stay visually equivalent (constants preserved per instantiation).
- [x] Unique `id` props for gradients/markers — global SVG ids like `attack-area` (`AttackPage.tsx:101`) and `attack-target-glow` (`AttackMap.tsx:145-160`) collide if two charts mount. Fix with per-instance `useId()` prefixing while here; also fix AttackMap ids.
- [x] `typecheck/test/build` → commit.

### Phase 3 — Deduplicate displayed facts (one fact, one place)

## Task 6: LivePage — merge twin live views

- [x] Merge `PDESLiveView` (`LivePage.tsx:214-318`) and `AttackLiveView` (`:320-420`) into one `SpecializedLiveView`/composition: identical meta-strip, progress panel, stale/failed/coordinator_lost/complete notice ladder, rerun-on-survivors action, per-partition timing list (now `PartitionTimingList`). Differentiators (PDES windows, attack phases) become typed extra sections.
- [x] Dedupe "windows done/total" meta-stat vs progress-percentage panel (`:272` vs `:276-279`; attack equivalent `:378` vs `:382-386`): keep progress panel with counts inline; meta strip drops the duplicate.
- [x] Generic view: replace re-hand-rolled `.progress-track` markup (`:277-279`, `:383-385`, `TrafficPage.tsx:365`) with `RunBits.ProgressBar`.
- [x] Acceptance: a run screenshot before/after shows the same information, minus one redundant copy per view; both mock scenarios still complete on the mock timers.
- [x] `typecheck/test/build` → commit.

## Task 7: Cluster — one health story

- [x] Health is currently shown 4 ways (`App.tsx:97`, `:113`, `:118-121`, matrix `:127-143`). Keep per-node card state + the peer matrix, but: summary strip keeps only `Healthy n/m` as the aggregate; cards drop the redundant `Seen by X` when it duplicates the matrix's diagonal row (keep `SELF` marker); matrix gets collapsed behind a `SectionTitle`-attached `show/hide` disclosure by default on healthy clusters, auto-expanded when `disagreement` (`App.tsx:61-66`) is detected.
- [x] Replace jargon: "Peer views disagree" → "Nodes disagree about each other's health — possible partition"; `observer_id` phrasing → "Observed by / Self".
- [x] Keep `refreshKey` manual refresh, but have it also show "just checked" state so it isn't confused with the 3 s auto-poll (`:53`, `:86`, `:99`).
- [x] `typecheck/test/build` → commit.

## Task 8: ReportPage (M/M/1) — metric card simplification + parameters drawer

- [x] Each `MetricCard` shows the same metric 4 ways (`ReportPage.tsx:32-63`): chart with axis labels, verdict chips, and a 6-cell `metric-numbers` dl repeating mean/theory/CI/rel-error, where rel-error `% / tolerance%` also restates the check chip. Rationalize to: chart (authoritative) + one verdict line + numbers behind a `Details` disclosure on the card. Rel-error row duplicated by a chip is removed.
- [x] `Parameters` strip (`:230-241`): drop the batch id (already in lede behind the heading), group raw symbols (λ, μ, ρ, CI method, seed scheme) into a `Details` drawer labelled "Raw parameters", and put a human line above ("~2 requests/s, service ~4/s, ~50% loaded" style) computed in `lib/format` with a test.
- [x] Three stacked warning notices (`:14-22`) collapse into one `Notice` list section rendered only when anything applies (same DOM, visually one block).
- [x] `typecheck/test/build` → commit.

## Task 9: NetworkPage — one seed, one launch flow, advanced panel

- [x] Kill the duplicate seed input bound to the same state (`:297` runbar vs `:325` "Generator seed" in the PDES grid). Keep it only in the PDES generator grid labelled "Seed".
- [x] Merge the two parallel run flows in the `net-runbar` (`:281-306`): one primary action "Run", secondary "Run on all nodes", shared hint + error list. No behavior loss; both flows remain reachable.
- [x] Wrap the 12 rarely-used generator knobs (`:313-326`) in a collapsed "Advanced generator settings" disclosure (open by default only when a run is in flight). Partitions + run-length stay primary.
- [x] Demote the PDES panel visually below the editor canvas (DOM order after toolbar/canvas on desktop; verify mobile stacking stays sane) — the canvas is the page's subject, the panel should not outrank it.
- [x] `NumInput` (`:26-35`) gains a consistent validation hint mechanism (message text tied to `aria-invalid`; reuse `Notice` tone tokens).
- [x] Delete-key/Escape window listeners (`:151-159`) get scoped to canvas focus so they don't fight form fields.
- [x] `typecheck/test/build` → commit.

## Task 10: TrafficPage + AttackPage fact dedupe

- [x] Traffic: λ/μ are printed on the stage (`:88`, `:92`), ρ in the hint (`:354`), utilization tile compares against theory (`:375`), and the chart repeats the theory line — keep the tile (authoritative) plus chart theory line; drop the on-stage λ/μ labels and plummet hint duplicates to the essential ("work vs service rate").
- [x] Traffic: state badge (`:327`) switches to a shared `StateBadge` (from `RunBits`, also reused by `NetworkPlayer:121` and `AttackPage:560`, `:626` pills).
- [x] Attack: threat index shown twice (`HUD meter :607-611` and big rail number `:671-674`) → keep in the rail; HUD shows phase instead.
- [x] Attack: rail `attack-bars` (`:676-683`) and `attack-metrics` (`:686-693`) render the same four numbers twice (offered load, availability, containment/blocked, botnet/compromise) → one representation: bars with numeric values, text mode only on narrow breakpoints.
- [x] Attack: dual HTML legend (`:720-724`, `:731-734`) vs SVG legend (`:181-186`) → move legend into the new `AxisFrame` legend slot; map keeps its own map-specific legend (`AttackMap.tsx:274-279`) since it encodes map colors.
- [x] `typecheck/test/build` → commit.

### Phase 4 — Restructure the heavy pages

## Task 11: AttackPage — progressive disclosure

- [x] Current stack: 4 scenario cards + paragraph + 4 sliders + seed/reset + Execution section (3 mode radios + pool config + preview + plan summary + remote status) + HUD + map + inspector + phase strip + playback + right rail (posture, metrics, campaign log) + 2 charts + 6 footer stats + footnote (`AttackPage.tsx:445-753`, 756-line file). ~20 simultaneous controls.
- [x] Group into role-based zones with disclosure where secondary: "Configure" (scenarios, sliders, seed), "Execute" (mode, pool, run), "Watch" (map, HUD, playback), "Analyze" (charts, rail). Execution detail (plan summary, remote status) collapses once running.
- [x] Split file: `AttackConfigure.tsx`, `AttackRuntime.tsx` (map/HUD/playback), `AttackCharts.tsx` (now thin wrappers over `AxisFrame`); leave state hooks in `AttackPage.tsx`. Target: no file in `pages/` over ~400 lines.
- [x] 6 foot stats (`:744-748`) + footnote (`:750-753`) become part of the rail or a single `StatStrip`; footnote text trimmed.
- [ ] `typecheck/test/build`, verify each attack kind (ddos, synflood, worm, exfil) in mock → commit.

## Task 12: LaunchPage — advanced grouping + jargon

- [x] Form fields are split by awkward `fieldConfig.filter(...)` calls (`:214`, `:228`); replace with per-section field arrays keyed by section id (pure refactor, add a small test for the splitter if one exists in spirit).
- [x] Dedupe: coordinator echoed in section 01 (`:157`) and aside (`:253`) — aside keeps the brief badge only; replications shown in aside during resubmit (`:200`) only resubmit mode.
- [x] Advanced knobs (serial baseline toggle `:239`, seed-dice, tolerance) go into an "Advanced" disclosure; three numbered sections remain, but section 03 shrinks.
- [x] Jargon pass: λ/μ/ρ mentions (`:24-26`, `:249-250`) get human equivalents beside the symbols (e.g. "λ — arrival rate: requests/second each node receives"). Keep symbols for experts, don't lead with them.
- [ ] `typecheck/test/build`, all mock launch paths incl. resubmit (`#/launch?resubmit=`) → commit.

## Task 13: Report family — table/tooltip/wall-of-numbers

- [x] NetworkReport: heat map tooltips (`:86-87`) duplicate the Links/Routers tables (`:165-182`) — keep tables authoritative; heat map becomes a compact visual summary at top with count chips, or hides behind a toggle. Also migrate its time-series to `AxisFrame` (Task 5).
- [x] PDESReport: `MetricTable` renders raw snake-case columns ("loss rate", "mean delay", "ci95 …", `:8-34`) unstyled → column label map keyed to a small dictionary in `lib/format` (tested), right-aligned numerics, units inferable from header; separate CI columns visually grouped.
- [x] AttackReport: the three back-to-back `pdes-summary-grid` strips (`:103-110`, `:113-120`) merge into one `StatStrip` + one execution `Details`; partition timing already shared via Task 4.
- [x] Shared lede (batch id · coordinator · seed + ghost buttons) duplicated 4× → `ReportHeader` component.
- [ ] `typecheck/test/build` → commit.

### Phase 5 — System polish and enhancement

## Task 14: CSS design tokens

- [x] Add a token block at `style.css` top: spacing scale (matching common current gaps), type scale, color roles (surface, ink, accent, good/warn/bad tones), radius, shadow, z-index. Replace hard-coded values with `var(--…)` mechanically (search-and-replace audit, keep computed values identical).
- [ ] Retire the two section-header systems (`.section-title` vs `.panel-title`/`pdes-panel-heading`/`attack-rail-title`/`attack-chart-head`) in favor of `SectionTitle`/`Panel` classes; keep class names in markup stable where possible.
- [ ] Acceptance: no page's layout changes, but `grep 'px' style.css` shows literals only inside the token block and chart-internal geometry.
- [ ] `typecheck/test/build` + visual spot check → commit.

## Task 15: accessibility hardening

- [x] Chart hover tooltips built on `AxisFrame` are keyboard-reachable (focusable plot area, arrow keys step through sample indices, tooltip shown on focus) — hover-only tooltips today (`TrafficPage.tsx:110-221`) are unreachable.
- [x] Attack scenario cards (`:454-472`) use arrow-key movement or a plain `radiogroup` pattern consistent with WAI-ARIA; current `role="radio"` buttons lack tablist semantics.
- [x] AttackMap nodes are pointer-only (`AttackMap.tsx:220`): add keyboard focus + Enter/Space selection; inspector follows focus.
- [ ] Audit duplicate text alternatives, `sr-only` labels for the new disclosures, and `aria-live` on StatStrip regions (only where data changes matter — avoid shouting on every poll tick).
- [x] Responsive check at 360 px on every page after restructuring (GUI roadmap exit criterion), numbering the fixed offenders.
- [ ] `typecheck/test/build` → commit.

## Task 16: final sweep

- [x] Grep for leftovers: `ORG`/debug strings, unused lucide icons, unused CSS classes after component extraction, dead props.
- [x] Update `gui-roadmap.md` cross-reference: note the declutter plan landed, point at this file.
- [ ] Full run: `npm run typecheck && npm run test && npm run build`, manual pass over every route in mock mode (cluster, network, attack, traffic, launch, live, reports for all run types), plus one gateway-mode smoke test if available.
- [ ] Commit(s) with a clean final state.

## Suggested execution order

Tasks 1 → 2 → 3 → 4 → 5 are strictly ordered (primitives land before pages consume them). Tasks 6–10 depend on Phase 2 only and may proceed in any order per page. Task 11 (AttackPage restructure) is the biggest risk; it should follow Task 5 and Task 10 so it lands on consolidated components. Tasks 14–15 are sweeps that run after all page work. Task 16 closes.

Non-goal (deliberate): the History page itself. This plan removes its dead nav item; an actual history UI belongs to a later gateway task.

## Follow-up pass (2026-11-08): make the Network lab intuitive

Found by screenshotting every route at 1440 px and 360 px in mock mode. The Network page was 3,864 px tall on desktop and 4,526 px on a phone, because every flow and failure rendered its full editor.

- [x] Flows and failures collapse to one summary line each ("lab → web · steady 12 pkt/s", "70 s · a1c1 · DOWN"); one row opens at a time for editing; failures list in time order. Helpers `flowSummary` and `eventsByTime` in `lib/network.ts`, with tests.
- [x] Run bar says what each button does: "Watch live" (one copy, streamed) and "Run N copies on all nodes" (averaged), plus the run length, which replaces the separate "Run length" panel.
- [x] PDES panel runs the network on the canvas ("Split one copy across your nodes", 1. Preview split → 2. Run partitioned). The grid generator moves into its own disclosure with its own length field, so it no longer competes with the main run length, and no longer auto-opens when a plan is previewed.
- [x] Editor canvas grows to include nodes placed past the 1000×640 drawing area (the bottom row of the ISP sample was clipped); the canvas stays in view while the side panel scrolls on wide screens.
- [x] Cluster: every node showed "SELF" because each node reports its own health; the badge now appears only when an address answers with a different node ID.
- [x] Removed dead CSS (`accepted-*`, `back-link`, `net-live-head`, `net-clock*`, `net-stop`, `pdes-generator-primary`, `self-marker`). The Samples dropdown no longer overflows at 360 px.
- Result: Network page 2,292 px on desktop with a flow and a failure open, 2,831 px at 360 px; no horizontal overflow or console errors on any route at either width.

