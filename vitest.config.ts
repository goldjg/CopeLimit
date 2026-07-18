import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['netlify/functions/lib/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    env: {
      TZ: 'UTC',
    },
  }
})
