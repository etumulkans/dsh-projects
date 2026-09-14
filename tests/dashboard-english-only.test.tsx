/** Phase 11 (spec §4.6): the Dashboard UI is English-only.
 *
 * Guards the user directive "remove all Chinese from any of the UI":
 *  - the `en` dictionary (the source of truth) carries no CJK text;
 *  - the `zh` mirror is byte-identical to `en` (so no Chinese renders under
 *    either locale id, even if a user selects the `zh` preference);
 *  - a fully rendered Dashboard surface contains no CJK text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import { createDashboardTranslator } from '../src/client/i18n.tsx'
import { en, zh } from '../src/client/locales.ts'

const CJK = /\p{Script=Han}/u

const catalogCallbacks = {
  onSwitchProject: async () => {},
  onAddDiscoveryRoot: async () => {},
  onRemoveDiscoveryRoot: async () => {},
  onScanProjects: async () => ({ root: fixtureSnapshot.catalog.discoveryRoots[0]!, candidates: [], truncated: false }),
  onRegisterProjectCandidate: async () => {},
  onRegisterProject: async () => {},
}

describe('Dashboard English-only localization', () => {
  it('keeps the `en` dictionary free of CJK text', () => {
    const offenders = Object.entries(en)
      .filter(([, value]) => CJK.test(value))
      .map(([key]) => key)
    expect(offenders, `en dictionary values containing CJK: ${offenders.join(', ')}`).toEqual([])
  })

  it('keeps the `zh` mirror identical to `en` (no Chinese under either locale id)', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(zhKeys, 'zh mirror must carry the same keys as en').toEqual(enKeys)
    const divergent = Object.entries(en)
      .filter(([key, value]) => zh[key as keyof typeof zh] !== value)
      .map(([key]) => key)
    expect(divergent, `zh mirror values diverging from en: ${divergent.join(', ')}`).toEqual([])
  })

  it('renders a Dashboard surface with no CJK text', () => {
    const markup = renderToStaticMarkup(
      <DashboardSurface
        {...catalogCallbacks}
        snapshot={fixtureSnapshot}
        initialSelectedKey="linear:ENG:issue-238"
        onRefresh={async () => {}}
        onPause={async () => {}}
        onStop={async () => {}}
        onCreateTask={async () => {}}
        onUpdateTask={async () => {}}
        onDeleteTask={async () => {}}
        onOpenSession={() => {}}
      />,
    )
    const match = markup.match(CJK)
    expect(match, `rendered Dashboard contains CJK: ${match ? JSON.stringify(markup.slice(Math.max(0, (match.index ?? 0) - 24), (match.index ?? 0) + 24)) : ''}`).toBeNull()
  })

  it('renders the standalone English translator with no CJK fallback', () => {
    const t = createDashboardTranslator('en')
    const values = Object.keys(en).map((key) => t(key as keyof typeof en))
    const offenders = values.filter((value) => CJK.test(value))
    expect(offenders, `standalone translator produced CJK: ${offenders.join(', ')}`).toEqual([])
  })

  it('ships no CJK literals in the client source (locales, fixture, controller, styles, i18n, errors, dev, index)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const files = ['locales.ts', 'fixture.ts', 'controller.ts', 'styles.ts', 'i18n.tsx', 'errors.ts', 'dev.tsx', 'index.tsx']
    const offenders = files
      .map((name) => ({ name, text: readFileSync(`${root}/src/client/${name}`, 'utf8') }))
      .flatMap(({ name, text }) =>
        text.split('\n')
          .map((line, i) => ({ line: i + 1, text: line }))
          .filter(({ text }) => CJK.test(text))
          .map(({ line, text }) => `${name}:${line}: ${text.trim().slice(0, 60)}`),
      )
    expect(offenders, `client source contains CJK:\n${offenders.join('\n')}`).toEqual([])
  })
})
