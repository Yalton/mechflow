import { defineConfig } from 'vitest/config';
import { workerCount } from './vitest.workers';

/**
 * Route vitest's module-fetch temp writes off `/tmp`.
 *
 * `/tmp` is a 32GB tmpfs at ~80% with `usrquota`; the `fetch` RPC writes temp
 * module files there and was being rejected with ENOSPC (-122) during config
 * resolution, which starved the whole suite. This points `tmpDir` at a writable
 * nvme path in the repo so the suite can run. Remove if `/tmp` quota is freed.
 */
export default defineConfig({
  test: {
    tmpDir: '.vitesttmp',
    // jsdom env for the React-rendering tests. Without it vitest defaults to
    // `node`, and `render(<App />)` crashes with `document is not defined`.
    environment: 'jsdom',
    // Inject globals (expect/vi/describe/it...). The sibling `vite.config.ts`
    // also sets `globals: true`, but its `test` block is not carried into the
    // injected environment, so tests that use global `expect` (e.g. the
    // `_probe*` diagnostics) throw `ReferenceError: expect is not defined`.
    globals: true,
    setupFiles: ['./test/setupAfterEnv.ts'],
    maxWorkers: workerCount(),
    minWorkers: 1,
  },
});
