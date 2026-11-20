import { handleContent, pageCtx } from './content/gateway';
import { errorPage } from './content/pages';
import { runCleanup } from './cron';
import type { Env } from './env';
import { classifyHost, hostname } from './lib/hosts';
import { app } from './main/app';

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const host = classifyHost(env, hostname(req));
    switch (host.kind) {
      case 'main':
        return app.fetch(req, env, ctx);
      case 'content':
        try {
          return await handleContent(req, env, ctx, host.id);
        } catch (e) {
          console.error(e);
          return errorPage(pageCtx(env, req), 500, 'internal');
        }
      default:
        return new Response('Not found', { status: 404 });
    }
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<Env>;
