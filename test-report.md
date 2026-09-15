# Test Report — Phase 11: UI polish (English-only slice)

Test-stage artifact for the Phase 11 English-only localization diff
(build commit `96731ee`, intent `dba16dc`, spec `251410e` — §4
English-only, §10 step 1). Verified on local `main` @ `96731ee`.

This report covers the **English-only localization slice** (spec §10 step 1),
the lead deliverable of Phase 11. The remaining build steps (§10 steps 2–5:
`nextRunAt`/`recentFires` projection, new surfaces, polished surfaces,
responsive pass) are committed and reported in subsequent Test-stage reports.

## 1. What the slice changes

The user directive: *"in step make sure all are english remove all chinese
from any of ui."* The UI must render **English only**.

The Harness locale seat (`@deepseek-ai/dsh-client-locale`) has
`LOCALE_IDS: readonly ["zh", "en"]` and its `register(ns, dicts)` requires a
dictionary for **both** locale ids — an `{ en }`-only registration is a type
error. So the English-only guarantee is achieved by making the `zh` dictionary
an **English mirror** of `en` (byte-identical values). `en` is the source of
truth; no CJK text exists in any dictionary value, so the UI renders English
under *either* locale id even if a user selects the `zh` preference.

- `src/client/locales.ts` — `zh` is now an English mirror of `en` (747 keys
  each, exact parity, 0 CJK). `en` is the source of truth
  (`satisfies Record<string, string>`); `DashboardLocaleKey = keyof typeof en`
  is defined after `en` (avoids the circular `TS2456`).
- `src/client/i18n.tsx` — `DashboardLocale = 'en'`; the standalone fallback and
  the translator are English (`createDashboardTranslator` always returns the
  `en` translator).
- `src/client/index.tsx` — the locale seat registers `{ zh, en }` (both English).
- `src/client/dev.tsx` — the dev harness uses the English translator.
- `src/client/fixture.ts` — all fixture data translated to English (9 strings).
- 14 UI test suites — Chinese selectors / assertions / labels / fixture strings
  translated to English (regex matchers, `getByText`, `toContain`, aria names).
- `tests/dashboard-english-only.test.tsx` (new) — the English-only guard.

## 2. Test inventory

| File | Cases | Scope |
| --- | --- | --- |
| `tests/dashboard-english-only.test.tsx` (new, jsdom) | 5 | The **English-only guard**. (1) the `en` dictionary values contain no CJK; (2) the `zh` mirror is byte-identical to `en` (key parity + value parity); (3) a rendered `DashboardSurface` contains no CJK text; (4) the standalone `en` translator output contains no CJK; (5) the client source files (`locales`/`fixture`/`controller`/`styles`/`i18n`/`errors`/`dev`/`index`) contain no CJK. CJK is detected with `/\p{Script=Han}/u`. |
| `tests/dashboard-*.test.tsx` (14 files, jsdom) | 107 | The existing UI suites, translated to English. Every Chinese selector / assertion / label / fixture string was translated to its `en`-dictionary equivalent (cross-checked against `locales.ts` and the render code in `Dashboard.tsx`). Test logic, structure, imports, and variable names are unchanged — only string literals. The `i18n-regressions` suite's locale parameter is now `'en'`-only (both locale ids render the same English, so the former zh/en-differ assertions collapse to the English text). |

**Total: 643 tests — 640 passed / 3 failed.** The 3 failures are the
documented pre-existing `project-catalog` macOS `tmpdir()` symlink cases (§4) —
untouched by this diff. **5 new tests** (the English-only guard), all green.
All 15 Dashboard UI test files pass (verified in isolation and in small groups;
under full-suite parallel load a handful of jsdom cases occasionally hit the
5000ms `testTimeout` — a pre-existing load characteristic, not a regression;
each passes in isolation).

## 3. Acceptance criteria (spec §4) — verified

1. **The UI renders English only.** → `dashboard-english-only.test.tsx`
   (1, 3, 4): the `en` dictionary, a rendered `DashboardSurface`, and the
   standalone translator output contain no CJK.
2. **No CJK under either locale id.** → `dashboard-english-only.test.tsx`
   (2): the `zh` dictionary is byte-identical to `en`, so selecting the `zh`
   preference still renders English.
3. **The client source ships no CJK.** → `dashboard-english-only.test.tsx`
   (5): a source scan over `locales`/`fixture`/`controller`/`styles`/`i18n`/
   `errors`/`dev`/`index` reports 0 CJK.
4. **The locale seat contract is satisfied.** → `index.tsx` registers
   `{ zh, en }` (both `LOCALE_IDS` present), so the `register(ns, dicts)`
   `Record<LocaleId, …>` requirement type-checks (typecheck exit 0).
5. **The repo stays green.** → `pnpm run typecheck` (exit 0),
   `pnpm run build` (exit 0 — client 492.50 kB / host 460.59 kB; the client
   grows ~0.64 kB from the English `zh` mirror), full `pnpm vitest run`
   (640/3 of 643, the 3 modulo the documented pre-existing environment
   failures, §4).

## 4. Known pre-existing failures (carried, documented)

`tests/project-catalog.test.ts` — 3 of 6 cases fail on this host because
`tmpdir()` yields `/var/folders/…` while the catalog canonicalizes paths to
`/private/var/folders/…` (macOS symlink). Present since Phase 3 (baseline then
295/3 of 298; … Phase 9 611/5 of 616; Phase 10 635/3 of 638). The
fix-vs-document decision is open in `maintain.md`. **Unchanged by Phase 11**
(`project-catalog` is exactly 3/6 in isolation; all 5 new English-only tests
pass).

`tests/integration-strategy.test.ts` + `tests/task-service.test.ts` — the
git-worktree cases are flaky **under full-suite load** (temp-dir / worktree
contention); they pass in isolation. Not introduced by Phase 11 (the diff does
not touch the merge strategy or the task service).
