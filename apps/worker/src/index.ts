export { Project } from './project/index';
export { Platform } from './platform/index';
import { route } from './http/router';
import { dashboard } from './http/dashboard';
import { site } from './http/site';
import { platformProjectRoute } from './http/platform-project';
import { repositoryBaseline } from './http/repository-baseline';
type HttpEnv=Env & {AUTH_CREDENTIALS?:string;DASHBOARD_SESSION_KEY?:string;PLATFORM?:DurableObjectNamespace};
export default {async fetch(request:Request,env:HttpEnv):Promise<Response>{
 const path=new URL(request.url).pathname;
 if(path.startsWith('/dashboard'))return dashboard(request,env);
 if(env.PLATFORM){const response=await repositoryBaseline(request,env as Parameters<typeof repositoryBaseline>[1]);if(response)return response;}
 if(path.startsWith('/api/v1/projects/')){
  if(env.PLATFORM){const response=await platformProjectRoute(request,env as HttpEnv & {PLATFORM:DurableObjectNamespace});if(response)return response;}
  return route(request,env);
 }
 return site(request,env as Parameters<typeof site>[1]);
}} satisfies ExportedHandler<HttpEnv>;
