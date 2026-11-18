/* Stock gantt bars fail AA (2.95:1, 4.0:1); two text colours cover four states. */
const THEMES = {
  light: {
    text: '#fcfcfc',
    outside: '#383d47',
    plain: '#555b66',
    done: '#038149',
    active: '#3259d1',
    crit: '#cc272e',
    edge: '#dde0e5',
    section: ['#ffffff', '#f5f6f8'],
    title: '#161921',
  },
  dark: {
    text: '#0f1217',
    outside: '#c5c9d1',
    plain: '#9da3af',
    done: '#4ebe7d',
    active: '#88a7fd',
    crit: '#f66d67',
    edge: '#2d3038',
    section: ['#0e1015', '#17191f'],
    title: '#ebedf1',
  },
}

/** Every value is a shipped easel.css token, resolved to hex. */
export function ganttThemeVariables(theme) {
  const t = THEMES[theme === 'dark' ? 'dark' : 'light']
  return {
    taskTextColor: t.text,
    taskTextDarkColor: t.text,
    taskTextLightColor: t.text,
    taskTextOutsideColor: t.outside,
    taskBkgColor: t.plain,
    taskBorderColor: t.edge,
    doneTaskBkgColor: t.done,
    doneTaskBorderColor: t.edge,
    activeTaskBkgColor: t.active,
    activeTaskBorderColor: t.edge,
    critBkgColor: t.crit,
    critBorderColor: t.edge,
    gridColor: t.edge,
    todayLineColor: t.active,
    sectionBkgColor: t.section[0],
    altSectionBkgColor: t.section[1],
    sectionBkgColor2: t.section[0],
    titleColor: t.title,
  }
}

/* Front matter, init directives and comments may all precede the keyword. */
export function isGantt(source) {
  const body = String(source)
    .replace(/^\s*---[\s\S]*?---\s*/, '')
    .replace(/^\s*(?:%%\{[\s\S]*?\}%%\s*)+/, '')
  const first = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%'))
  return /^gantt\b/i.test(first ?? '')
}
