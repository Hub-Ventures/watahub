import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // node.ts is the process entry point (boot banner + serve); types/ holds declarations only
      exclude: ['src/node.ts', 'src/types/**'],
      reporter: ['text', 'json-summary'],
    },
  },
})
