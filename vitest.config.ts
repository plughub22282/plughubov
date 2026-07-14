import { defineConfig } from 'vitest/config'

// Подэтап 1: минимальный зелёный baseline.
// Тесты не поднимают Electron и не ходят в сеть — только чистые ядра (сейчас tasteScore).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Детерминизм: каждый тест стартует с восстановленными моками/шпионами.
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      // Покрываем только исходники приложения; сборку/конфиги/генерат исключаем.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/*.selfcheck.ts',
        'src/renderer/src/main.tsx',
        'out/**',
        'dist/**',
        'coverage/**',
        '**/*.config.*',
        'test/**'
      ]
      // Порог намеренно не задан: на этом подэтапе coverage — отчёт, а не quality gate.
    }
  }
})
