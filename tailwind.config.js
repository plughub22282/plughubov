/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/index.html'],
  theme: {
    extend: {
      colors: {
        app: {
          bg:              'rgb(var(--bg)    / <alpha-value>)',
          panel:           'rgb(var(--panel) / <alpha-value>)',
          card:            'rgb(var(--card)  / <alpha-value>)',
          border:          'rgb(var(--bdr)   / <alpha-value>)',
          'border-active': 'rgb(var(--bdr-a) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'rgb(var(--ac)   / <alpha-value>)',
          hover:   'rgb(var(--ac-h) / <alpha-value>)',
          muted:   'rgb(var(--ac-m) / <alpha-value>)',
          cyan:    'rgb(var(--ac2)  / <alpha-value>)',
          hot:     'rgb(var(--ac3)  / <alpha-value>)'
        },
        txt: {
          primary:   'rgb(var(--tx1) / <alpha-value>)',
          secondary: 'rgb(var(--tx2) / <alpha-value>)',
          muted:     'rgb(var(--tx3) / <alpha-value>)'
        },
        status: {
          success: '#4ade80',
          error:   '#f87171',
          warning: '#fbbf24',
          info:    '#60a5fa'
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace']
      },
      boxShadow: {
        card:         'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)'
      },
      opacity: {
        '3':  '0.03',
        '8':  '0.08',
        '12': '0.12',
        '15': '0.15'
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.25rem'
      }
    }
  },
  plugins: []
}
