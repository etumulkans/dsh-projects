/**
 * DSH Projects Phase 9 — pure goal-template renderer (spec §5.3).
 *
 * `renderGoalTemplate` replaces each `{{placeholder}}` in the template with the
 * event's data value. An absent placeholder renders as the empty string. The
 * renderer is pure (no clock, no I/O) and exported for tests.
 */

/**
 * Render a goal template with the event's data. Each `{{key}}` is replaced with
 * `data[key] ?? ''`. Whitespace around the placeholder name is trimmed
 * (`{{ key }}` works). A template with no placeholders is returned as-is.
 */
export function renderGoalTemplate(template: string, data: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/gu, (match, key: string) => {
    const value = data[key]
    return value === undefined ? '' : value
  })
}
