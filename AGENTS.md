# Repository Guidelines

## Project Structure

`src/index.ts` routes requests to the Cloudflare Worker handlers. Keep the Hono API, admin routes, and authentication in `src/main/`. The artifact-host gateway and file responses live in `src/content/`. Shared storage, access checks, and other helpers live in `src/lib/`. Scheduled cleanup runs from `src/cron.ts`.

The admin UI and share viewer are browser modules and static assets in `web/`. Use `web/i18n.js` for shared UI translations. Put D1 schema changes in a new numbered SQL file under `migrations/`. See [the design notes](docs/DESIGN.md) for architecture and API details.

## Local Development and Build

- Run `npm ci` to install the locked dependencies.
- Copy `wrangler.toml.example` to `wrangler.toml` and `.dev.vars.example` to `.dev.vars`. Run `npm run db:migrate:local` to prepare the local database.
- Run `npm run dev` to prepare browser dependencies and start Wrangler. Use `http://share.localhost:8787` for the admin UI and `http://<uuid>-share.localhost:8787` for artifact content.
- Run `npm run typecheck` to check TypeScript and `npm test` to run the full suite. To verify packaging locally, run `npm run vendor` and then `npx wrangler deploy --dry-run`.

## Coding Style

Match nearby code. Use two-space indentation, single quotes, semicolons, and ES module imports. Use camelCase for functions and variables, PascalCase for types, and snake_case for existing SQL and API fields. Keep Worker code in TypeScript and browser modules in JavaScript.

## Testing

Vitest runs with the Cloudflare Workers plugin and applies the D1 migrations during setup. Name tests `*.test.ts` under `test/`. Add focused regression coverage for changes to publishing, permissions, or host routing. Run `npm test -- test/api.test.ts` for API and gateway integration tests.

## Commits and Pull Requests

Follow the imperative subjects in Git history, such as `Harden artifact publishing, access control, and downloads`. In PRs, describe the behavior change and checks run, note migration or configuration changes, and link any relevant issue. Include screenshots for visible UI changes. Keep credentials and generated files such as `.dev.vars`, `wrangler.toml`, and `web/vendor/` out of commits.
