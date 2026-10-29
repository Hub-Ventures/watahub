import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // .claude/ holds Claude Code worktrees: full copies of the repo whose tests must not run here
    exclude: [...configDefaults.exclude, '.claude/**', '.dev.vars*'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // node.ts is the process entry point (boot banner + serve); the others hold type declarations only
      exclude: ['src/node.ts', 'src/types/**', 'src/http/outcome.ts'],
      reporter: ['text', 'json-summary'],
      // Floor, not target: a drop below these fails `pnpm test:coverage` and `pnpm check`
      thresholds: { statements: 95, lines: 95, functions: 95, branches: 90 },
    },
  },
})
