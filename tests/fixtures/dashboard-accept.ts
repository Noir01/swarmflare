import { launchLocalBrowser } from '../../packages/browser-test/index';

export async function waitForValue(evaluate: (expression: string) => Promise<unknown>, condition: string, timeoutMs = 8000): Promise<unknown> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const observed = await evaluate(condition);
    if (observed) return observed;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Dashboard timed out waiting for: ${condition}`);
}

export async function acceptDashboardView(options: { baseUrl: string; projectId: string; humanToken: string; viewId: string }): Promise<{ status: string }> {
  const browser = await launchLocalBrowser({ timeoutMs: 20_000 });
  try {
    await browser.send('Page.enable', {}, browser.pageSessionId);
    await browser.send('Page.navigate', { url: new URL('/dashboard', new URL(options.baseUrl).origin).toString() }, browser.pageSessionId);
    const evaluate = async (expression: string) => (await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, browser.pageSessionId)).result.value;
    const waitFor = (condition: string) => waitForValue(evaluate, condition);
    await waitFor(`!!document.getElementById('login-form') && document.getElementById('login-submit').disabled===false`);
    await evaluate(`document.getElementById('project-id').value=${JSON.stringify(options.projectId)};document.getElementById('human-token').value=${JSON.stringify(options.humanToken)};document.getElementById('login-form').requestSubmit()`);
    await waitFor(`!document.getElementById('workspace').classList.contains('hidden')`);
    await evaluate(`document.getElementById('view-id').value=${JSON.stringify(options.viewId)};document.getElementById('inspect-view').click()`);
    await waitFor(`document.getElementById('confirmation-button').disabled===false`);
    await evaluate(`document.getElementById('confirmation-button').click()`);
    await waitFor(`document.getElementById('accept-button').disabled===false`);
    await evaluate(`document.getElementById('accept-button').click()`);
    const status = await waitFor(`(()=>{const status=document.getElementById('status')?.textContent||'';return status.includes('Accepted and verified exact baseline tuple')?status:''})()`);
    return { status: String(status) };
  } finally { await browser.close(); }
}
