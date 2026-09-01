import { defineConfig } from 'vitest/config';

// Standalone test config — pure logic modules (parser, weights, resolution
// engine) run in Node, with no dev-server proxy or DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
