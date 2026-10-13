import { expect, it, vi } from 'vitest';
import { isRecoveryClaimable, parseRepairConfig, runPhase } from '../../demo/cloud/repair.js';

const smoke={baseUrl:'https://git-collaboration-demo-c29.sriva140.workers.dev',projectId:'demo-project',runnerToken:'runner-secret',contributorToken:'contributor-secret',seedRepository:'/tmp/seed',revisionRepository:'/tmp/revision',remote:'/tmp/cache.git',workspaceRoot:'/tmp/work',receiptPath:'/tmp/original-smoke.json',approvedOrigin:'https://git-collaboration-demo-c29.sriva140.workers.dev'};
const raw={...smoke,receiptPath:'/tmp/repair.json',repairRepository:'/tmp/repair-repo',findingId:'finding_1',originalViewId:'view_1',repairChangeId:'change_1',repairRevisionId:'revision_1'};
it('requires distinct repair receipt and all explicit repair identifiers',()=>{
 const c=parseRepairConfig(JSON.stringify(raw));expect(c.receiptPath).toBe('/tmp/repair.json');
 expect(()=>parseRepairConfig(JSON.stringify({...raw,extra:'x'}))).toThrow(/exactly/);
});
it('rejects unknown phases before API activity',async()=>{
 const c=parseRepairConfig(JSON.stringify(raw));const fetch=vi.spyOn(globalThis,'fetch');
 await expect(runPhase('accept' as never,c)).rejects.toThrow(/phase must be/);expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
});
it('allows queued and expired leases, but never an active lease or failed job',()=>{
 const now=Date.now();
 expect(isRecoveryClaimable({data:{status:'queued',leaseExpiresAt:null}})).toBe(true);
 expect(isRecoveryClaimable({data:{status:'leased',leaseExpiresAt:now-1}})).toBe(true);
 expect(isRecoveryClaimable({data:{status:'leased',leaseExpiresAt:now+60_000}})).toBe(false);
 expect(isRecoveryClaimable({data:{status:'failed',leaseExpiresAt:null}})).toBe(false);
});
