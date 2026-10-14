import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchLocalBrowser } from '../../packages/browser-test/index.js';

export const ORIGIN = 'https://git-collaboration-demo-c29.sriva140.workers.dev';
export const PROJECT_ID = 'fc34f086-87da-4067-a648-484af2297bd7';
export const VIEW_ID = 'b727454b-a7a1-4b8c-abe6-04a2459bd5ea';
export const COMMIT = 'f1e87cd12d5069d54ec23ec772a8031786fd95ef';
export const TREE = 'b3aa432744d82309c46308ea92784a8b6584da3d';
export const CHAPTER_SECONDS = 45;
export const CHAPTERS = ['landing', 'tutorial', 'repository-readme', 'task-failure-history', 'ready-checks-diff', 'preview', 'connect-agent'] as const;
export const CAPTURE_ORDER = ['preview', ...CHAPTERS.filter(x => x !== 'preview')];

export function validateScope(repo: any, candidate: any) {
  if (!repo || repo.id !== PROJECT_ID || repo.projectId !== PROJECT_ID || repo.status !== 'ready' ||
      !/^smoke-[a-f0-9]{20}$/.test(repo.owner) || !/^probe-[a-f0-9]{10}$/.test(repo.name) ||
      candidate?.projectId !== PROJECT_ID || candidate.viewId !== VIEW_ID ||
      candidate.source?.treeOid !== TREE || candidate.view?.treeOid !== TREE || candidate.view?.commitOid !== COMMIT ||
      candidate.view?.ref !== `refs/agent/views/${VIEW_ID}`) throw new Error('PUBLIC_FIXTURE_SCOPE_INVALID');
  return { owner: repo.owner, name: repo.name, projectId: PROJECT_ID, viewId: VIEW_ID, commitOid: COMMIT, treeOid: TREE };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

async function main() {
  const repoReport = JSON.parse(await readFile('reports/evaluation/continuous40-platform-smoke.json', 'utf8'));
  const candidate = JSON.parse(await readFile('reports/evaluation/continuous49-native-cursor.json', 'utf8'));
  const scope = validateScope(repoReport.created, candidate);
  const live = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT_ID}/views/${VIEW_ID}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!live.ok) throw new Error('PUBLIC_SOURCE_UNAVAILABLE');
  const published = (await live.json() as any).resource;
  if (published?.data.receipt?.commitOid !== COMMIT || published.data.receipt.treeOid !== TREE) throw new Error('PUBLIC_SOURCE_CHANGED');
  const base = `/${scope.owner}/${scope.name}`;
  const output = resolve('reports/evaluation/continuous51-recording');
  await mkdir(resolve(output, 'frames'), { recursive: true });
  let manifest: any = { provenance: 'Actual public deployed browser recording; no login, mutation, acceptance, or imported-code execution. Seven real 45-second chapters, preview-first capture and logical-order edit.', origin: ORIGIN, scope, chapterSeconds: CHAPTER_SECONDS, captureOrder: CAPTURE_ORDER, presentationOrder: CHAPTERS, chapters: [] };
  try{const saved=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'));if(JSON.stringify(saved.scope)!==JSON.stringify(scope)||saved.origin!==ORIGIN||!Array.isArray(saved.chapters))throw Error('RECORDING_RESUME_SCOPE');const names=new Set<string>();for(const c of saved.chapters){if(!CHAPTERS.includes(c.chapter)||names.has(c.chapter)||c.frames!==45||c.frameRecords?.length!==45)throw Error('RECORDING_RESUME_CHAPTER');names.add(c.chapter);for(let i=0;i<45;i++){if(c.frameRecords[i].file!==`frames/${safe(c.chapter)}-${String(i).padStart(3,'0')}.png`)throw Error('RECORDING_RESUME_FRAME');const bytes=await readFile(resolve(output,c.frameRecords[i].file));if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('RECORDING_RESUME_BYTES');}}manifest=saved;}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const urlFor = (name: string) => name === 'landing' ? '/' : name === 'tutorial' ? '/how-it-works' : name === 'connect-agent' ? `${base}/settings` : name === 'repository-readme' ? base : name === 'task-failure-history' ? `${base}/tasks` : `${base}/candidates/${VIEW_ID}${name === 'preview' ? '?tab=Preview' : '?tab=Checks'}`;

  for (const chapter of CAPTURE_ORDER) {
    if(manifest.chapters.some((c:any)=>c.chapter===chapter))continue;
    const started = Date.now();
    const browser = await launchLocalBrowser({ timeoutMs: 60_000 });
    try {
      const session = browser.pageSessionId;
      let previewContext: number | undefined;
      const send = (method: string, params: any = {}, sid = session) => browser.send(method, params, sid);
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await send('Page.bringToFront');
      const initial = chapter === 'connect-agent' ? `${base}/settings` : urlFor(chapter);
      if (chapter === 'connect-agent') {
        const repoPage = await fetch(`${ORIGIN}${base}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (!repoPage.ok) throw new Error(`PUBLIC_REPOSITORY_GET_${repoPage.status}`);
        const text = await repoPage.text();
        const settings = [...text.matchAll(/href=["']([^"']+)["'][^>]*>[^<]*(?:Settings|Connect agent)/gi)].map(m => m[1]).find(h => h.startsWith(base));
        if (!settings) throw new Error('FIRST_PARTY_SETTINGS_LINK_NOT_FOUND');
        await navigate(settings);
        const prompt = await evaluate("document.querySelector('pre.code')?.innerText");
        if (typeof prompt !== 'string' || !prompt.includes('/skills/swarmflare.md') || !prompt.includes(PROJECT_ID) || /Bearer [a-f0-9]{64}|sfr_[a-f0-9]{64}/.test(prompt)) throw new Error('PUBLIC_PROMPT_INVALID');
        await send('Page.bringToFront');
        await send('Browser.setPermission', { permission: { name: 'clipboard-read', allowWithoutSanitization: true }, setting: 'granted', origin: ORIGIN });
        await evaluate("document.querySelector('button.copy-prompt')?.click()");
        let copied = '';
        for (let attempt = 0; attempt < 40; attempt++) { copied = await evaluate('navigator.clipboard.readText()'); if (copied === prompt) break; await sleep(50); }
        if (copied !== prompt) throw new Error('FIRST_PARTY_PROMPT_COPY_FAILED');
      } else if (chapter === 'landing') await navigate('/');
      else if (chapter === 'tutorial') {
        await navigate('/');
        const tutorial = await evaluate("[...document.querySelectorAll('a')].find(a=>a.getAttribute('href')==='/how-it-works')?.getAttribute('href')");
        if (tutorial !== '/how-it-works') throw new Error('TUTORIAL_LINK_MISSING');
        await navigate(tutorial);
      } else await navigate(initial);

      async function evaluate(expression: string, sid?: string) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, ...(sid && previewContext ? {contextId:previewContext} : {}) }, sid);
        if (r.exceptionDetails) throw new Error(`PAGE_EVALUATION_FAILED:${r.exceptionDetails.text}`);
        return r.result?.value;
      }
      async function navigate(path: string) {
        if (path.startsWith('//') || !(path === '/' || path === '/how-it-works' || path.startsWith(base))) throw new Error('NAVIGATION_OUT_OF_SCOPE');
        await send('Page.navigate', { url: ORIGIN + path });
        const deadline = Date.now() + 9_000;
        while (Date.now() < deadline) {
          const ready = await evaluate(`document.readyState === "complete" && location.href===${JSON.stringify(ORIGIN+path)} && document.body?.innerText.includes('Swarmflare')`);
          if (ready) break;
          await sleep(100);
        }
        const state = await evaluate('({title:document.title,text:document.body?.innerText||"",href:location.href})');
        if (!state || state.href !== ORIGIN + path || /410|expired|not found/i.test(state.text.slice(0, 300))) throw new Error(`PAGE_UNAVAILABLE:${chapter}`);
        if (chapter !== 'landing' && chapter !== 'tutorial' && (!state.text.includes(scope.name) || !state.text.includes('Swarmflare'))) throw new Error(`EXPECTED_PUBLIC_UI_MISSING:${chapter}`);
        if (path==='/how-it-works' && !state.text.includes('How Swarmflare works')) throw new Error('TUTORIAL_CONTENT_MISSING');
        return state;
      }
      async function caption(text: string) {
        await evaluate(`(()=>{let e=document.getElementById('recording-commentary');if(!e){e=document.createElement('div');e.id='recording-commentary';e.style.cssText='position:fixed;z-index:2147483647;left:0;right:0;bottom:0;background:rgba(10,18,32,.94);color:white;padding:16px 28px;font:20px/1.35 sans-serif;box-sizing:border-box;border-top:3px solid #73a8ff';document.documentElement.append(e)}e.textContent='Recording commentary: '+${JSON.stringify(text)}})()`);
      }
      const descriptions: Record<string, string> = {
        landing: 'Illustrative landing-page example; activity shown here is not claimed as a live campaign.',
        tutorial: 'First-party tutorial and onboarding, viewed from the deployed public application.',
        'repository-readme': `Actual Artifacts-backed first-party README repository ${scope.owner}/${scope.name}. Imported source elsewhere is never executed.`,
        'task-failure-history': 'Existing task and failure history retained for review; no new work is submitted.',
        'ready-checks-diff': 'Ready means ready for human review, not accepted. Actual source diff and mandatory check evidence.',
        preview: 'Bounded captured-response preview: actual Next, Previous, and Tenant B UI states, not a general service.',
        'connect-agent': 'Actual public Copy prompt button and clipboard readback. Credentials are supplied separately; no human decision is taken.'
      };
      await caption(descriptions[chapter]);
      let previewSession: string | undefined;
      if (chapter === 'preview') {
        const targets = (await send('Target.getTargets')).targetInfos;
        const iframe = targets.find((x: any) => x.type === 'iframe' && x.url.startsWith(ORIGIN));
        if (!iframe) throw new Error('PREVIEW_FRAME_UNAVAILABLE');
        previewSession = (await send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })).sessionId;
        await send('Page.enable', {}, previewSession); await send('Runtime.enable', {}, previewSession);
        const tree = await send('Page.getFrameTree', {}, previewSession);
        const frame = tree.frameTree?.frame ?? tree.frameTree?.childFrames?.find((x: any) => x.frame.url.startsWith(ORIGIN))?.frame;
        if (!frame) throw new Error('PREVIEW_FRAME_TREE_UNAVAILABLE');
        previewContext = (await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'record-preview-observer' }, previewSession)).executionContextId;
        const rows = "[...document.querySelectorAll('[data-project-id]')].map(x=>x.dataset.projectId)";
        const inspect = () => evaluate(rows, previewSession);
        let first:any;for(let n=0;n<50;n++){first=await inspect();if(first?.[0]==='a-project-01')break;await sleep(40);}
        if (!Array.isArray(first) || first[0] !== 'a-project-01') throw new Error('PREVIEW_INITIAL_STATE_INVALID');

      }
      // Gentle scroll is real page interaction; frames sample the visible actual app at 1Hz.
      const frames: any[] = [];
      const sampleStart = Date.now();
      for (let index=0;index<CHAPTER_SECONDS;index++) {
        if (Date.now() - started > 54_000) throw new Error(`CHAPTER_BUDGET_EXCEEDED:${chapter}`);
        if(chapter==='preview'&&previewSession){
          const action=index===8?"document.querySelector('#next-page').click()":index===18?"document.querySelector('#previous-page').click()":index===28?"const e=document.querySelector('#tenant');e.value='tenant-b';e.dispatchEvent(new Event('change',{bubbles:true}))":null;
          if(action){await evaluate(action,previewSession);const expected=index===8?'a-project-03':index===18?'a-project-01':'b-project-01';let valid=false;for(let n=0;n<30;n++){const ids=await evaluate("[...document.querySelectorAll('[data-project-id]')].map(x=>x.dataset.projectId)",previewSession);if(ids?.[0]===expected){valid=true;break;}await sleep(40);}if(!valid)throw Error('PREVIEW_TRANSITION_INVALID');}
        }
        if(chapter==='task-failure-history'&&index===22){await navigate(`${base}/candidates/b44d6d61-b502-40b2-b254-17e1669edc5f`);await caption('Actual original candidate retains a failed independent review; the linked findings were resolved only against the replacement.');}
        if(chapter==='ready-checks-diff'&&(index===18||index===32)){const tab=index===18?'Files changed':'Conversation';const href=await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()===${JSON.stringify(tab)})?.getAttribute('href')`);if(!href)throw Error('CANDIDATE_TAB_MISSING');await navigate(href);await caption(descriptions[chapter]);}
        if(chapter==='tutorial'&&index===20)await evaluate("window.scrollTo({top:550,behavior:'smooth'})");
        const snap = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const filename = `frames/${safe(chapter)}-${String(index).padStart(3, '0')}.png`;
        await writeFile(resolve(output, filename), Buffer.from(snap.data, 'base64'));
        frames.push({ file: filename, elapsedMs: Date.now() - started, capturedAt: new Date().toISOString() });
        await sleep(Math.max(0, sampleStart+(index+1)*1000-Date.now()));
      }
      const entry = { chapter, captureIndex: CAPTURE_ORDER.indexOf(chapter), startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), url: urlFor(chapter), frames: frames.length, frameRecords: frames, actions: chapter === 'preview' ? ['Next -> A3', 'Previous -> A1/A2', 'select Tenant B -> B1/B2'] : chapter === 'connect-agent' ? ['read first-party public prompt', 'clipboard read permission and copy prompt'] : chapter==='tutorial'?['public tutorial navigation','scroll to lower tutorial steps']:chapter==='task-failure-history'?['public approved task','original failed-review Conversation']:chapter==='ready-checks-diff'?['Checks -> Files changed -> Conversation']:['public page navigation'], source: scope };
      manifest.chapters.push(entry);
      // Persist every completed chapter so interruptions never lose prior capture receipts.
      await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
    } finally { await browser.close(); }
  }
  // Encode only captured browser frames, concatenated in logical presentation order.
  const orderedFrames=CHAPTERS.flatMap(ch => manifest.chapters.find((x:any)=>x.chapter===ch)!.frameRecords);
  const concat = orderedFrames.map((f:any)=>`file '${resolve(output,f.file)}'\nduration 1`).join('\n')+`\nfile '${resolve(output,orderedFrames.at(-1).file)}'\n`;
  await writeFile(resolve(output, 'frames.txt'), concat);
  const { spawnSync } = await import('node:child_process');
  const ffmpeg = 'ffmpeg';
  const result = spawnSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', resolve(output, 'frames.txt'), '-t',String(orderedFrames.length),'-vf', 'fps=24,scale=1280:900:force_original_aspect_ratio=decrease,pad=1280:900:(ow-iw)/2:(oh-ih)/2,format=yuv420p', '-c:v', 'libx264','-threads','2','-preset','ultrafast', '-movflags', '+faststart', resolve(output, 'video.mp4')], { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`FFMPEG_FAILED:${result.stderr.slice(-2000)}`);
  manifest.video = 'video.mp4'; manifest.silent = true; manifest.logicalChapterOrder = CHAPTERS; manifest.editedCaptureOrder = CAPTURE_ORDER;
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ output, chapters: manifest.chapters.length, frames: manifest.chapters.reduce((n: number, c: any) => n + c.frames, 0), video: manifest.video }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
