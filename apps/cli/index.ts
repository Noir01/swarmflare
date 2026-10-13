import { WorkspaceClient } from '../../packages/client/index';

const commands = `Commands (one JSON argument where shown):
  context | events [JSON] | contract {"version":1}
  claim {"requestId":"...","payload":{...}} | claim-update {"id":"...","mutation":{"requestId":"...","payload":{...}}}
  overlap-ack {"id":"...","mutation":{"requestId":"...","payload":{...}}}
  decision {"requestId":"...","payload":{...}} | decision-response {"id":"...","mutation":{"requestId":"...","payload":{...}}}
  decision-agree {"id":"...","mutation":{"requestId":"...","payload":{...}}}
  resolve-decision {"id":"...","mutation":{"requestId":"...","payload":{"kind":"clarification|contract-update","contractVersion":1,"note":"..."}}}
  proposal {"requestId":"...","payload":{...}} | approve-proposal {"id":"...","mutation":{"requestId":"...","payload":{}}} (human only)
  baseline-initialize {"requestId":"...","payload":{...}} | baseline
  change-create {"requestId":"...","payload":{...}} | change {"id":"..."} | revision-publish {"id":"...","mutation":{"requestId":"...","payload":{...}}} | revision {"id":"..."}
  view-create {"requestId":"...","payload":{...}} | view {"id":"..."} | view-updates {"id":"..."} | checks {"id":"..."} | readiness {"id":"..."} | reviews {"id":"..."}
  findings | finding {"id":"..."} | finding-create {"mutation":{"requestId":"...","payload":{...}}} | finding-owner {"id":"...","mutation":{"requestId":"...","expectedVersion":1,"payload":{"nextOwner":"...","note":"..."}}} | finding-repair {"id":"...","mutation":{"requestId":"...","payload":{...}}} | finding-resolve {"id":"...","mutation":{"requestId":"...","payload":{...}}}
  review {"id":"...","mutation":{"requestId":"...","payload":{...}}}
  policy | configure-policy {"requestId":"...","expectedVersion":0,"payload":{"contractVersion":1,"checkSuiteDigest":"...","harnessVersion":"json-oracle-v1","checks":[{"id":"...","obligationIds":["..."]}],"requireIndependentReview":true,"sourceBackend":"local-git"}}
  confirm-view {"id":"...","mutation":{"requestId":"...","payload":{"applicability":{...},"expectedBaselineVersion":1,"expectedBaselineCommitOid":"...","readinessSequence":1,"confirm":true}}} (human only)
  accept-view {"mutation":{"requestId":"...","payload":{"confirmationId":"...","applicability":{...},"expectedBaselineVersion":1,"expectedBaselineCommitOid":"...","readinessSequence":1}}} (human only)
  acceptance {"id":"..."} | source-verification {"id":"..."} (read-only)
  source-job-claim {"requestId":"...","payload":{...}} | source-job-complete {"id":"...","mutation":{"requestId":"...","payload":{...}}} | source-job {"id":"..."}
  get {"path":"/frozen/read/path"} | mutate {"method":"POST|PATCH","path":"/frozen/mutation/path","body":{"requestId":"...","payload":{...}}}

Mutation envelope: {"requestId":"stable-retry-key","expectedVersion":1,"payload":{...}} (expectedVersion only when required).
Set WORKSPACE_BASE_URL, WORKSPACE_PROJECT_ID, WORKSPACE_TOKEN in the environment. The bearer token determines identity and role; enforcement is server-side. Human-only commands need a human identity. Never pass human credentials/secrets to agents.`;

function usage(): void { process.stdout.write(`${commands}\n`); }
async function main(): Promise<void> {
  const [command, raw] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') { usage(); return; }
  const baseUrl=process.env.WORKSPACE_BASE_URL, projectId=process.env.WORKSPACE_PROJECT_ID, token=process.env.WORKSPACE_TOKEN;
  if(!baseUrl||!projectId||!token) throw new Error('WORKSPACE_BASE_URL, WORKSPACE_PROJECT_ID and WORKSPACE_TOKEN are required');
  let input: any = {};
  if(raw!==undefined) { try { input=JSON.parse(raw); } catch { throw new Error('argument must be valid JSON'); } }
  const client=new WorkspaceClient({baseUrl,projectId,token,maxRequests:100,deadline:30_000});
  let result: unknown;
  switch(command) {
    case 'context': result=await client.context(); break;
    case 'events': result=await client.events(input); break;
    case 'contract': result=await client.contract(input.version); break;
    case 'claim': result=await client.createClaim(input); break;
    case 'claim-update': result=await client.updateClaim(input.id,input.mutation); break;
    case 'overlap-ack': result=await client.acknowledgeOverlap(input.id,input.mutation); break;
    case 'decision': result=await client.createDecision(input); break;
    case 'decision-response': result=await client.respondDecision(input.id,input.mutation); break;
    case 'decision-agree': result=await client.agreeDecision(input.id,input.mutation); break;
    case 'resolve-decision': result=await client.resolveDecision(input.id,input.mutation); break;
    case 'proposal': result=await client.createProposal(input); break;
    case 'approve-proposal': result=await client.approveProposal(input.id,input.mutation); break;
    case 'baseline-initialize': result=await client.initializeBaseline(input); break;
    case 'baseline': result=await client.baseline(); break;
    case 'change-create': result=await client.createChange(input); break;
    case 'change': result=await client.change(input.id); break;
    case 'revision-publish': result=await client.publishRevision(input.id,input.mutation); break;
    case 'revision': result=await client.revision(input.id); break;
    case 'view-create': result=await client.createView(input); break;
    case 'view': result=await client.view(input.id); break;
    case 'view-updates': result=await client.viewUpdates(input.id); break;
    case 'checks': result=await client.checks(input.id); break;
    case 'findings': result=await client.findings(); break;
    case 'finding': result=await client.finding(input.id); break;
    case 'finding-create': result=await client.createFinding(input.mutation); break;
    case 'finding-owner': result=await client.assignFindingOwner(input.id,input.mutation); break;
    case 'finding-repair': result=await client.proposeRepair(input.id,input.mutation); break;
    case 'finding-resolve': result=await client.resolveFinding(input.id,input.mutation); break;
    case 'review': result=await client.reviewView(input.id,input.mutation); break;
    case 'readiness': result=await client.readiness(input.id); break;
    case 'reviews': result=await client.reviews(input.id); break;
    case 'policy': result=await client.policy(); break;
    case 'configure-policy': result=await client.configurePolicy(input); break;
    case 'confirm-view': result=await client.confirmView(input.id,input.mutation); break;
    case 'accept-view': result=await client.acceptView(input.mutation); break;
    case 'acceptance': result=await client.acceptance(input.id); break;
    case 'source-verification': result=await client.sourceVerification(input.id); break;
    case 'source-job-claim': result=await client.claimSourceJob(input); break;
    case 'source-job-complete': result=await client.completeSourceJob(input.id,input.mutation); break;
    case 'source-job': result=await client.sourceJob(input.id); break;
    case 'get': result=await client.get(input.path); break;
    case 'mutate': result=await client.mutate(input.method,input.path,input.body); break;
    default: throw new Error(`unknown command: ${command}; use --help`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch((error: unknown) => {
  const token=process.env.WORKSPACE_TOKEN ?? '';
  let message=error instanceof Error?error.message:'request failed';
  if(token) message=message.split(token).join('[REDACTED]');
  process.stderr.write(`${JSON.stringify({error:message})}\n`); process.exitCode=1;
});