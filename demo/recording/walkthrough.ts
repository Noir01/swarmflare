import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchLocalBrowser } from '../../packages/browser-test/index';

export const SLIDE_SECONDS = 40;
export const VIDEO_SECONDS = 320;
export const inputPaths = [
  'reports/evaluation/continuous30-final-readiness.json', 'reports/evaluation/continuous30-final-reviews.json',
  'reports/evaluation/continuous30-final-finding.json', 'reports/evaluation/continuous30-final-baseline.json',
  'reports/evaluation/continuous32-original-race.json', 'reports/evaluation/continuous32-final-finding.json',
  'reports/evaluation/continuous32-owner-correction-readback.json', 'reports/evaluation/continuous33-remote-composed-commit.json',
  'reports/evaluation/continuous33-checks.json', 'reports/evaluation/continuous33-final-reviews.json',
  'reports/evaluation/continuous33-final-finding.json', 'reports/evaluation/continuous33-final-readiness.json',
  'reports/evaluation/continuous33-final-baseline.json', 'reports/evaluation/continuous33-composed-race.json',
  'reports/evaluation/review-fixture/capture.json',
] as const;
const fixtureDir = 'reports/evaluation/review-fixture';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const need: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw new Error(message); };
const safeCaptureName = (name: string) => typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && basename(name) === name && !name.includes('/') && !name.includes('\\');
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function validateEvidence(data: Record<string, any>) {
  const [r30, reviews30, finding30, baseline30, race32, finding32, correction32, commit, checks, reviews, finding, ready, baseline, composedRace, capture] = inputPaths.map(p => data[p]);
  need(r30?.ready === false && reviews30?.[0]?.data?.verdict === 'failed', 'continuous30 failed candidate/review receipts mismatch');
  need(race32?.passed === false && race32?.cases?.[0]?.passed === false, 'continuous32 original race is not a failing reproduction');
  need(finding32?.id === correction32?.id && finding32?.data?.status === 'repair-proposed' && correction32?.data?.status === 'open', 'continuous32 finding/correction identity mismatch');
  need(commit?.hash && commit?.treeHash && ready?.ready === true && ready?.blockers?.length === 0, 'composed commit/readiness missing or blocked');
  const app = ready.applicability;
  need(app?.viewId === ready.viewId && app.composedCommitOid === commit.hash && app.treeOid === commit.treeHash, 'readiness does not match exact commit/tree/View');
  need(checks?.phase === 'checks' && checks.replacementViewId === ready.viewId && checks.baselineUnchanged === true, 'checks do not target replacement View or baseline is changed');
  need(checks.checks?.length === 2 && checks.checks.every((c: any) => c.result === 'passed') && checks.checks[0].checkId === 'mandatory-demo-api' && checks.checks[1].checkId === 'mandatory-demo-ui', 'mandatory check results mismatch');
  need(composedRace?.passed === true && composedRace.commitOid === commit.hash && composedRace.treeOid === commit.treeHash && composedRace.cases?.length > 0 && composedRace.cases.every((c: any) => c.passed === true), 'composed race probe missing, failed, or mismatched');
  need(reviews?.length > 0 && reviews[0].data?.verdict === 'passed' && reviews[0].data.viewId === ready.viewId && reviews[0].data.composedCommitOid === commit.hash && reviews[0].data.treeOid === commit.treeHash && reviews[0].data.manifestDigest === app.manifestDigest && reviews[0].data.checkSuiteDigest === app.checkSuiteDigest, 'review applicability does not match readiness tuple');
  need(ready.reviewIds?.includes(reviews[0].id) && checks.reviewArtifactId, 'review/check artifact linkage missing');
  const originalAnchor = ['viewId', 'manifestDigest', 'composedCommitOid', 'treeOid', 'contractVersion', 'policyVersion'];
  need(finding?.id === finding32.id && finding.data.status === 'resolved' && finding.data.repairs?.length > 0 && originalAnchor.every(k => finding.data[k] === finding32.data[k] && finding.data[k] === correction32.data[k]), 'original finding anchor changed or resolution records mismatch');
  const resolution = finding.data.resolutionEvidence?.applicability;
  need(resolution && JSON.stringify(resolution) === JSON.stringify(app) && finding.data.resolutionEvidence.reviewIds?.some((id: string) => ready.reviewIds?.includes(id)) && finding.data.resolutionEvidence.checkIds?.length > 0, 'resolution evidence does not match ready/review applicability');
  need(ready.findingIds?.length === 0 && baseline?.commitOid && baseline?.treeOid && baseline.version === 1 && baseline.commitOid === baseline.receipt?.commitOid && baseline.treeOid === baseline.receipt?.treeOid, 'baseline receipt inconsistent');
  need(baseline30?.commitOid === baseline.commitOid && baseline30?.treeOid === baseline.treeOid && baseline30?.version === baseline.version, 'original and replacement baseline changed');
  need(capture?.label?.includes('AUTOMATED LOCAL FIXTURE') && capture.captures?.length === 5, 'fixture capture identity mismatch');
  const names = new Set<string>();
  const files = new Set<string>();
  for (const c of capture.captures) {
    need(safeCaptureName(c.file), 'unsafe fixture capture path');
    need(!files.has(c.file), 'duplicate fixture capture filename');
    files.add(c.file);
    need(typeof c.name === 'string' && !names.has(c.name), 'duplicate fixture capture name');
    names.add(c.name);
    need(typeof c.sha256 === 'string' && /^[a-f0-9]{64}$/.test(c.sha256), 'invalid fixture capture hash');
  }
  need(names.has('task') && names.has('candidate') && names.has('evidence') && names.has('preview') && names.has('feedback'), 'expected fixture capture names absent');
  return { r30, failedReview: reviews30[0], race: race32, originalFinding: finding32, correction32, commit, checks, reviews, finding, ready, baseline, composedRace, capture };
}

export function renderPage(title: string, body: string, tag: string, index: number, imageDataUri = '') {
  const image = imageDataUri ? `<img alt="Automated local fixture example" src="${escapeHtml(imageDataUri)}">` : '';
  return `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#f4f1ea;color:#202b35;font:30px/1.42 system-ui,sans-serif}.page{height:720px;padding:56px 76px;display:flex;flex-direction:column;justify-content:space-between}.eyebrow{font-size:18px;text-transform:uppercase;letter-spacing:.14em;color:#8a573b}h1{font:600 47px/1.1 Georgia,serif;margin:20px 0 12px;max-width:1100px}.body{font-size:27px;max-width:1100px}.tag{font-size:18px;color:#fff;background:#435d65;padding:10px 16px;display:inline-block;align-self:flex-start}img{position:absolute;right:58px;bottom:118px;width:400px;height:auto;border:1px solid #b8b2a8;box-shadow:0 8px 28px #26323833}.foot{font-size:16px;color:#69747b;border-top:1px solid #cbc6bc;padding-top:12px}</style><main class="page"><div><div class="eyebrow">Field notes / review evidence · ${String(index + 1).padStart(2, '0')}</div><h1>${escapeHtml(title)}</h1><div class="body">${escapeHtml(body)}</div>${image}</div><div><div class="tag">${escapeHtml(tag)}</div><div class="foot">DRAFT · historical receipts are not a live session · fixture is automated · no acceptance implied</div></div></main>`;
}

async function run() {
  const root = resolve(process.cwd());
  const out = resolve(process.argv[2] ?? 'reports/evaluation/continuous35-walkthrough');
  need(out === root || out.startsWith(root + sep), 'output directory must remain inside repository');
  const frozenDir = join(out, 'inputs');
  await mkdir(frozenDir, { recursive: true });
  const inputRecords: Record<string, { sourcePath: string; frozenPath: string; sha256: string }> = {};
  for (const sourcePath of inputPaths) {
    const b = await readFile(join(root, sourcePath));
    const frozenPath = join(frozenDir, sourcePath.replaceAll('/', '__'));
    await writeFile(frozenPath, b);
    inputRecords[sourcePath] = { sourcePath, frozenPath: `inputs/${basename(frozenPath)}`, sha256: sha(b) };
  }
  for (const c of JSON.parse(await readFile(join(frozenDir, 'reports__evaluation__review-fixture__capture.json'), 'utf8')).captures) {
    need(safeCaptureName(c.file), 'unsafe fixture capture path');
    const sourcePath = `${fixtureDir}/${c.file}`;
    const b = await readFile(join(root, sourcePath));
    need(sha(b) === c.sha256, `fixture screenshot hash mismatch: ${c.name}`);
    const frozenPath = join(frozenDir, `capture__${c.file}`);
    await writeFile(frozenPath, b);
    inputRecords[sourcePath] = { sourcePath, frozenPath: `inputs/${basename(frozenPath)}`, sha256: sha(b) };
  }
  const data: Record<string, any> = {};
  for (const p of inputPaths) data[p] = JSON.parse(await readFile(join(frozenDir, p.replaceAll('/', '__')), 'utf8'));
  const evidence = validateEvidence(data);
  const lessons = [
    ['Scope & provenance', 'A local evidence walkthrough, not a live product session. Historical cloud evidence below comes from saved receipts; the UI images are an automated local fixture. No voiceover or network calls.', 'Scope'],
    ['The first candidate did not pass review', `Continuous 30 recorded ready=false. The independent review verdict was ${evidence.failedReview.data.verdict}; its finding described stale asynchronous tenant responses. Passing recorded checks did not clear that review blocker.`, `Historical cloud evidence · candidate ${evidence.r30.applicability.composedCommitOid}`],
    ['Race reproduced; ownership corrected', `Continuous 32 race receipt: passed=${evidence.race.passed}. The observed tenant was ${evidence.race.cases[0].observed.tenant} while IDs included ${evidence.race.cases[0].observed.ids.join(', ')}. Owner correction readback preserves the finding and corrects routing; it does not itself resolve the defect.`, `Historical cloud evidence · finding ${evidence.originalFinding.id}`],
    ['Composed repair and exact source', `Continuous 33 composed commit ${evidence.commit.hash}; tree ${evidence.commit.treeHash}. Commit message: “${evidence.commit.message}”. The review receipt ties the candidate to the replacement View and source tuple.`, `Historical cloud evidence · replacement View ${evidence.ready.viewId}`],
    ['Checks and review evidence', `Recorded mandatory API check: ${evidence.checks.checks[0].result}; UI check: ${evidence.checks.checks[1].result}. Independent review verdict: ${evidence.reviews[0].data.verdict}. Isolated race probe: passed on this exact composed commit/tree. Broader pagination/delayed-body cases were source-reviewed, not separately runtime-probed.`, 'Historical cloud evidence · no human acceptance'],
    ['Finding resolved; baseline unchanged', `Finding status: ${evidence.finding.data.status}. Readiness: ${evidence.ready.ready}; blockers: ${evidence.ready.blockers.length}. Baseline remains ${evidence.baseline.commitOid} / ${evidence.baseline.treeOid}, version ${evidence.baseline.version}. Ready is not acceptance.`, 'Historical cloud evidence · continuous 33'],
    ['What a reviewer can see', `Fixture identity: ${evidence.capture.label}. This is an example review UX only—not real human feedback or a cloud session. Task, candidate, evidence, preview and request-changes images are hash-verified automated fixture captures.`, 'AUTOMATED LOCAL UI FIXTURE — not human/cloud session'],
    ['What remains reserved', 'This walkthrough does not substitute for the reserved human review session or a final live-product recording. No human signoff, acceptance, publication, or recording of a live cloud session is claimed.', 'Draft · local rendered slides · captions only'],
  ] as const;
  need(lessons.length * SLIDE_SECONDS === VIDEO_SECONDS, 'chapter plan does not total explicit video duration');
  const browser = await launchLocalBrowser({ timeoutMs: 60000 });
  const concatLines: string[] = [];
  try {
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, browser.pageSessionId);
    for (let i = 0; i < lessons.length; i++) {
      const [title, body, tag] = lessons[i];
      let image = '';
      if (i === 6) {
        const c = evidence.capture.captures.find((x: any) => x.name === 'task');
        const png = await readFile(join(frozenDir, `capture__${c.file}`));
        image = `data:image/png;base64,${png.toString('base64')}`;
      }
      const html = renderPage(title, body, tag, i, image);
      const page = join(out, `story-${String(i + 1).padStart(2, '0')}.html`);
      const pngPath = join(out, `frame-${String(i + 1).padStart(2, '0')}.png`);
      await writeFile(page, html);
      await browser.send('Page.navigate', { url: pathToFileURL(page).href }, browser.pageSessionId);
      await new Promise(r => setTimeout(r, 700));
      const shot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, browser.pageSessionId);
      await writeFile(pngPath, Buffer.from(shot.data, 'base64'));
      concatLines.push(`file '${basename(pngPath)}'\nduration ${SLIDE_SECONDS}\n`);
    }
  } finally { await browser.close(); }
  await writeFile(join(out, 'frames.ffconcat'), `ffconcat version 1.0\n${concatLines.join('')}file 'frame-08.png'\n`);
  const chapters = lessons.map(([title], i) => ({ title, startSeconds: i * SLIDE_SECONDS, durationSeconds: SLIDE_SECONDS }));
  const manifest = { kind: 'reproducible local draft evidence walkthrough', label: 'HISTORICAL CLOUD EVIDENCE / AUTOMATED LOCAL UI FIXTURE — NOT HUMAN/CLOUD SESSION', durationSeconds: VIDEO_SECONDS, chapters, inputs: inputRecords, output: 'walkthrough.mp4', commands: ['node --import tsx demo/recording/walkthrough.ts reports/evaluation/continuous35-walkthrough', 'ffmpeg -y -loglevel error -f concat -safe 0 -i reports/evaluation/continuous35-walkthrough/frames.ffconcat -t 320 -vf scale=1280:720:flags=fast_bilinear,fps=2 -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p reports/evaluation/continuous35-walkthrough/walkthrough.mp4', 'ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of json reports/evaluation/continuous35-walkthrough/walkthrough.mp4'], notes: 'Captions only; explicit 320-second plan and ffmpeg limit; measured encoded duration must be checked separately. Human session and final live product recording remain reserved.' };
  await writeFile(join(out, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  const frozenManifest = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
  for (const record of Object.values(frozenManifest.inputs) as Array<{ frozenPath: string; sha256: string }>) {
    const b = await readFile(join(out, record.frozenPath));
    need(sha(b) === record.sha256, `frozen input hash mismatch: ${record.frozenPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(e => { console.error(e); process.exitCode = 1; });
}
