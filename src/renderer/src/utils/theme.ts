export function applyTheme(theme: string): void {
  if (theme && theme !== 'carbon') {
    document.documentElement.dataset.theme = theme
  } else {
    delete document.documentElement.dataset.theme
  }
}

export const THEMES = [
  {
    id:      'carbon',
    label:   'Темная тема',
    desc:    'Глубокий премиум',
    accent:  '#d6dbe5',
    preview: 'radial-gradient(ellipse at 18% 0%, rgba(92,98,112,0.36), transparent 55%), linear-gradient(145deg, #020203 0%, #07080a 48%, #111318 100%)'
  },
  {
    id:      'pearl',
    label:   'Светлая',
    desc:    'Чистый светлый',
    accent:  '#3b82f6',
    preview: 'linear-gradient(145deg, #f6f7f9 0%, #e4ecf8 60%, #3b82f618 100%)'
  }
] as const
