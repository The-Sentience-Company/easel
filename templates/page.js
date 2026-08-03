/* page template — hand-authored HTML escape hatch. Passes body-inner HTML
   through untouched so the same shell, chrome, and design system apply. */

import { requireObject, requireString, fail } from './_html.js'

export const name = 'page'

const FORBIDDEN = [
  [/<\s*(html|head|body)\b/i, 'page.html must be body-inner HTML only — no <html>, <head>, or <body> tags'],
  [/\sdata-sid\s*=/i, 'page.html must not set data-sid — the daemon assigns stable node ids at publish'],
  // The empty alternative catches the unquoted form, class=sf-queue.
  [/\sclass\s*=\s*("[^"]*|'[^']*|)\bsf-/i, 'page.html must not use sf- classes — that prefix is reserved for the chrome'],
]

export function render(data) {
  requireObject(data, 'page')
  const html = data.html
  if (typeof html !== 'string') fail('page.html must be a string of body-inner HTML')
  if (html.trim() === '') fail('page.html must not be empty')

  for (const [pattern, message] of FORBIDDEN) {
    if (pattern.test(html)) fail(message)
  }

  if (data.title !== undefined) requireString(data.title, 'page.title')

  return html
}
