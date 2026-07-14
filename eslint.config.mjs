import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

// Flat config, ESLint 9. Подэтап 1: baseline без type-aware linting (быстрее, проще;
// проектную программу можно подключить отдельным изменением при необходимости).
//
// Философия «храповика»: legacy-код (renderer, main) в этом подэтапе не трогаем
// (это запрещено scope'ом). Поэтому реальные legacy-находки держим как warn —
// видимый backlog, не блокер CI. Новый код (test/, config) — строго error.
export default tseslint.config(
  {
    // Игнор: зависимости, сборка, покрытие, генерат, чужие рантаймы.
    // supabase/** — Deno Edge Functions (другой рантайм/тулчейн, вне scope).
    // web/** — отдельный CommonJS-пакет со своим lint (вне scope этого подэтапа).
    ignores: ['node_modules/**', 'out/**', 'dist/**', 'coverage/**', 'web/**', 'supabase/**', '**/*.d.ts']
  },

  // Базовые наборы для всего TS/TSX. typescript-eslint сам отключает core no-undef
  // для .ts (типы проверяет компилятор), поэтому глобали для TS задавать не нужно.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Renderer: React 17+ JSX-transform (jsx: react-jsx) — react-in-jsx-scope выключаем
  // официальным пресетом jsx-runtime (это исправление, а не подавление правила).
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    settings: { react: { version: 'detect' } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...react.configs.flat['jsx-runtime']
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Под jsx-runtime `import React` в некоторых legacy-компонентах стал мёртвым.
      // Эти файлы вне scope Подэтапа 1 — разрешаем ровно неиспользуемый React,
      // не ослабляя no-unused-vars для любых других переменных.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^React$' }],
      // Renderer — legacy, вне scope Подэтапа 1. Экспериментальные правила
      // eslint-plugin-react-hooks@7 (RC) держим как warn: это видимый backlog для
      // будущего этапа, но не блокер. rules-of-hooks остаётся error (из recommended).
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  // Корневые CommonJS-файлы конфигурации (tailwind/postcss) и .cjs-хелперы:
  // module.exports/require — легитимны, задаём Node-глобали и sourceType commonjs.
  {
    files: ['**/*.cjs', '*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly'
      }
    },
    rules: {
      // CommonJS-файл: require() здесь корректен.
      '@typescript-eslint/no-require-imports': 'off'
    }
  },

  // src/main/index.ts — legacy вне scope Подэтапа 1. Единственная находка: тернарный
  // оператор как выражение-стейтмент (index.ts:1757). allowTernary разрешает этот идиом,
  // не ослабляя правило для присваиваний/вызовов. Override сужен до одного файла, чтобы
  // остальной main-код держал строгий no-unused-expressions. Код main здесь не меняем.
  {
    files: ['src/main/index.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }]
    }
  },

  // Строгие правила гарантированно для НОВЫХ test/config файлов (операционализация правила 7).
  {
    files: ['test/**/*.ts', '*.config.{ts,mts}', 'eslint.config.mjs', 'vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-empty': 'error'
    }
  }
)
