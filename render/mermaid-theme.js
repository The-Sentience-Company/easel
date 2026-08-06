/* Stock gantt bars fail AA (2.95:1, 4.0:1); two text colours cover four states. */
const THEMES = {
  light: {
    text: '#fcfcfc',
    outside: '#544941',
    plain: '#645850',
    done: '#038149',
    active: '#a44c1d',
    crit: '#cc272e',
    edge: '#ded8cf',
    section: ['#fcf9f2', '#f4f0e7'],
    title: '#291f19',
  },
  dark: {
    text: '#120f08',
    outside: '#c8bda3',
    plain: '#a39982',
    done: '#4ebe7d',
    active: '#dd8852',
    crit: '#f66d67',
    edge: '#35312a',
    section: ['#0c0a06', '#1a1711'],
    title: '#f6ecd4',
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
