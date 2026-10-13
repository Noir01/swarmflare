import { Project } from './project/index';
import { route } from './http/router';
import { dashboard } from './http/dashboard';

type DemoEnv = Env & {
  AUTH_CREDENTIALS?: string;
  DASHBOARD_SESSION_KEY?: string;
  DEMO_EXPIRES_AT?: string;
};

const expired = (env: DemoEnv): boolean => {
  if (typeof env.DEMO_EXPIRES_AT !== 'string' || !/^[1-9]\d*$/.test(env.DEMO_EXPIRES_AT)) return true;
  const deadline = Number(env.DEMO_EXPIRES_AT);
  return !Number.isFinite(deadline) || deadline <= Date.now();
};

export { Project };
export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    if (expired(env)) return Response.json({ code: 'DEMO_EXPIRED', message: 'Demo unavailable' }, { status: 410 });
    if (new URL(request.url).pathname.startsWith('/dashboard')) return dashboard(request, env);
    return route(request, env);
  },
} satisfies ExportedHandler<DemoEnv>;