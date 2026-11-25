import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { copyFileSync, existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * wrangler.toml is local-only (gitignored). Without it (fresh clone / CI), test against the committed
 * example; wrangler infers the format from the extension, so it is copied to a .toml name first.
 */
function wranglerConfig(): string {
  if (existsSync('./wrangler.toml')) return './wrangler.toml';
  copyFileSync('./wrangler.toml.example', './wrangler.test.toml');
  return './wrangler.test.toml';
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: wranglerConfig() },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Pin production hosts so a local .dev.vars cannot change them.
            MAIN_HOST: 'share.example.com',
            CONTENT_ZONE: 'example-content.com',
            CONTENT_HOST_SUFFIX: '-share',
            // Also pinned (to "unset"), so a developer's local .dev.vars can't change login behaviour under test.
            ADMIN_USERNAME: '',
            TURNSTILE_SITE_KEY: '',
            TURNSTILE_SECRET_KEY: '',
            CF_ACCOUNT_ID: '',
            CF_API_TOKEN: '',
            ANALYTICS_DATASET: '',
            SECRET_KEY: 'test-secret-key-0123456789abcdef',
            ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-pass',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
