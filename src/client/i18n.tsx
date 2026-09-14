/** React bridge for the Harness locale seat plus deterministic standalone rendering. */

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DASHBOARD_LOCALE_NS, en } from './locales.ts'

export type DashboardLocale = 'en'
export type DashboardTranslate = TranslateNS<typeof DASHBOARD_LOCALE_NS>

const fallbackTranslate = createDashboardTranslator('en')
const DashboardI18nContext = createContext<DashboardTranslate>(fallbackTranslate)

/** Supply the Harness-bound translator to every Dashboard-owned component. */
export function DashboardI18nProvider({ t, children }: {
  readonly t: DashboardTranslate
  readonly children: ReactNode
}) {
  return <DashboardI18nContext.Provider value={t}>{children}</DashboardI18nContext.Provider>
}

/** Read the current Dashboard translator; standalone surfaces fall back to English. */
export function useDashboardTranslation(): DashboardTranslate {
  return useContext(DashboardI18nContext)
}

/** Create the Dashboard's English dictionary translator (the UI renders English only). */
export function createDashboardTranslator(_locale: DashboardLocale): DashboardTranslate {
  const dictionary = en
  return (key, params) => {
    const template = key in dictionary ? dictionary[key as keyof typeof dictionary] : key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
}
