import { expect, it } from 'vitest';
import { linkRepairOnce } from '../../demo/cloud/candidate-cursor.js';
import type { FindingResource } from '../../packages/contracts/feedback.js';
const ref={changeId:'change',revisionId:'revision'};
function fixture(){return {id:'finding',version:4,owner:'reviewer',data:{status:'repair-proposed',repairs:[{changeId:'change',revisionId:'old'}]}} as unknown as FindingResource;}
it('reads already-linked exact repair without replaying a mutated expectedVersion',async()=>{
 const finding=fixture();finding.data.repairs.push(ref);let writes=0,keys=0;
 await linkRepairOnce({finding:async()=>finding,proposeRepair:async()=>{writes++;return finding;}},'finding',ref,async()=>{keys++;return 'unused';});expect(writes).toBe(0);expect(keys).toBe(0);
});
it('pins a new repair intent to the resource version and reads its exact effect back',async()=>{
 let finding=fixture();let received:any;let reserved='';
 await linkRepairOnce({finding:async()=>finding,proposeRepair:async(_id,input)=>{received=input;finding={...finding,version:5,data:{...finding.data,repairs:[...finding.data.repairs,ref]}};return finding;}},'finding',ref,async n=>{reserved=n;return 'new-request';});
 expect(reserved).toBe('repair-finding-v4');expect(received).toEqual({requestId:'new-request',expectedVersion:4,payload:{revisions:[ref]}});expect(finding.data.repairs).toContainEqual(ref);
});
it('refuses missing repair readback instead of reporting an accepted write as success',async()=>{
 const finding=fixture();await expect(linkRepairOnce({finding:async()=>finding,proposeRepair:async()=>({...finding,version:5,data:{...finding.data,repairs:[ref]}})},'finding',ref,async()=> 'new-request')).rejects.toThrow('REPAIR_READBACK');
});
