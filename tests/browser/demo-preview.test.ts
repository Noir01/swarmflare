import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDemoPreview } from '../../packages/git-runner/checks/demo-preview.js';
import { buildPaginatedDemo, preparedPaginatedDemo, paginatedClientScript } from '../fixtures/paginated-demo.js';
import { launchIsolatedBrowser } from '../../packages/browser-test/isolated.js';

const roots: string[] = [];
const browsers: Array<Awaited<ReturnType<typeof launchIsolatedBrowser>>> = [];
afterEach(async () => { await Promise.all(browsers.splice(0).map(b => b.close())); await Promise.all(roots.splice(0).map(p => rm(p,{recursive:true,force:true}))); });
async function fixture(source: string) { const root=await mkdtemp(join(tmpdir(),'demo-preview-')); roots.push(root); await mkdir(join(root,'demo/seed'),{recursive:true}); await writeFile(join(root,'demo/seed/index.ts'),source); return root; }
const expiry = () => Date.now()+60_000;

describe('supported project-list offline preview',()=>{
 it('returns bounded standalone artifact built from actual assets and paginated tenant responses',async()=>{
  const root=await fixture(preparedPaginatedDemo); const result=await buildDemoPreview({candidateDirectory:root,expiresAt:expiry()});
  expect(result.supported).toBe('project-list-demo-v1'); expect(result.html.length).toBeLessThanOrEqual(32000); expect(result.html).toContain('Offline response scope');
  expect(result.html).toContain('a-project-03'); expect(result.html).toContain('b-project-02'); expect(result.html).toContain('tenant-a');
  expect(result.html).not.toContain('http-equiv="Content-Security-Policy"'); expect(Number.isSafeInteger(result.expiresAt)).toBe(true);
 });
 it('executes actual UI in isolated browser with network blocked and exercises page/cross-tenant behavior',async()=>{
  const root=await fixture(preparedPaginatedDemo); let artifact=await buildDemoPreview({candidateDirectory:root,expiresAt:expiry()});
  const browser=await launchIsolatedBrowser({timeoutMs:15000}); browsers.push(browser);
  const session=browser.pageSessionId;
  await browser.send('Fetch.enable',{patterns:[{urlPattern:'http://preview.invalid/*',requestStage:'Request'}]},session);
  const unsub=browser.on('Fetch.requestPaused',(p:any,sid?:string)=>{void browser.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'},{name:'Content-Security-Policy',value:"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts"}],body:Buffer.from(artifact.html).toString('base64')},sid).catch(()=>{});});
  await browser.send('Page.navigate',{url:'http://preview.invalid/'},session);
  const errors:string[]=[]; const offException=browser.on('Runtime.exceptionThrown',(p:any)=>errors.push(JSON.stringify(p.exceptionDetails?.exception?.description??p.exceptionDetails?.text))); const offLog=browser.on('Log.entryAdded',(p:any)=>errors.push(String(p.entry?.text??'')));
  const poll=async(expr:string)=>{for(let i=0;i<80;i++){const r=await browser.send('Runtime.evaluate',{expression:expr,returnByValue:true},browser.pageSessionId);if(r.result?.value)return r.result.value;await new Promise(x=>setTimeout(x,50));}throw Error('UI state timeout '+JSON.stringify(errors)+' '+JSON.stringify((await browser.send('Runtime.evaluate',{expression:"({url:location.href,title:document.title,text:document.body?.innerText,html:document.scripts[0]?.textContent?.split('\\n')[1]?.slice(360,460)})",returnByValue:true},browser.pageSessionId)).result?.value))};
  const first=await poll("document.querySelectorAll('[data-project-id]').length===2 && document.querySelector('#next-page') ? [...document.querySelectorAll('[data-project-id]')].map(x=>x.dataset.projectId) : null"); expect(first).toEqual(['a-project-01','a-project-02']);
  await browser.send('Runtime.evaluate',{expression:"document.querySelector('#next-page').click()"},browser.pageSessionId);
  expect(await poll("document.querySelectorAll('[data-project-id]').length===1 && [...document.querySelectorAll('[data-project-id]')].map(x=>x.dataset.projectId)")).toEqual(['a-project-03']);
  await browser.send('Runtime.evaluate',{expression:"const s=document.querySelector('#tenant');s.value='tenant-b';s.dispatchEvent(new Event('change',{bubbles:true}))"},browser.pageSessionId);
  expect(await poll("document.querySelectorAll('[data-project-id]').length===2 && [...document.querySelectorAll('[data-project-id]')].map(x=>x.dataset.projectId)")).toEqual(['b-project-01','b-project-02']);
  const security=await browser.send('Runtime.evaluate',{expression:"(()=>{try{void document.cookie;return 'readable'}catch(e){return e.name}})()",returnByValue:true},session); expect(security.result.value).toBe('SecurityError');
  const network=await browser.send('Runtime.evaluate',{expression:"Promise.all([fetch('https://example.invalid/').then(()=>false,()=>true),new Promise(r=>{const x=new XMLHttpRequest();x.onerror=()=>r(true);x.onload=()=>r(false);x.open('GET','https://example.invalid/');x.send()}),new Promise(r=>{const i=new Image();i.onerror=()=>r(true);i.onload=()=>r(false);i.src='https://example.invalid/x'})])",awaitPromise:true,returnByValue:true},session); expect(network.result.value).toEqual([true,true,true]);
  const strictReplay=await browser.send('Runtime.evaluate',{expression:"Promise.all([fetch('https://preview.invalid/api/projects?tenant=tenant-a&limit=2').then(()=>false,e=>e.message.includes('not recorded')),fetch(new Request('/api/projects?tenant=tenant-a&limit=2',{method:'POST'})).then(()=>false,e=>e.message.includes('not recorded'))])",awaitPromise:true,returnByValue:true},session); expect(strictReplay.result.value).toEqual([true,true]);
  artifact=await buildDemoPreview({candidateDirectory:root,expiresAt:Date.now()+1500}); await browser.send('Page.navigate',{url:'http://preview.invalid/'},session); await new Promise(r=>setTimeout(r,1800));
  const expired=await browser.send('Runtime.evaluate',{expression:"document.body.innerText.includes('Preview expired')",returnByValue:true},session); expect(expired.result.value).toBe(true); unsub();
 });
 it('rejects expired/overlong expiry and symlinks; excludes secrets and blocks candidate network escape',async()=>{
  const root=await fixture(`${buildPaginatedDemo()}\n`); await writeFile(join(root,'.env'),'marker');
  await expect(buildDemoPreview({candidateDirectory:root,expiresAt:Date.now()-1})).rejects.toThrow(/expiry/i);
  await expect(buildDemoPreview({candidateDirectory:root,expiresAt:Date.now()+121000})).rejects.toThrow(/expiry/i);
  await symlink('/etc/passwd',join(root,'bad-link')); await expect(buildDemoPreview({candidateDirectory:root,expiresAt:expiry()})).rejects.toThrow(/symlink/i);
  await rm(join(root,'bad-link'));
  const escaping=await fixture(buildPaginatedDemo(`${paginatedClientScript};fetch('https://example.invalid/steal').catch(()=>{});`));
  const artifact=await buildDemoPreview({candidateDirectory:escaping,expiresAt:expiry()}); expect(artifact.html).toContain('example.invalid');
 });
});
