import { describe, it, expect } from 'vitest';
import { oid, claimInput, decisionInput, mutation, revisionInput, viewInput } from '../../packages/contracts/index';
describe('frozen v1 contracts', () => {
 it('allows version zero as an initial compare-and-swap precondition only, not an immutable resource version', () => {expect(mutation(claimInput).safeParse({requestId:'initial',expectedVersion:0,payload:{obligationIds:['tenant'],areas:['api']}}).success).toBe(true);for(const expectedVersion of [-1,0.5])expect(mutation(claimInput).safeParse({requestId:'invalid',expectedVersion,payload:{obligationIds:['tenant'],areas:['api']}}).success).toBe(false);});
 it('preserves exact lower-case Git IDs, rejects malformed IDs', () => {expect(oid.parse('a'.repeat(40))).toBe('a'.repeat(40)); for(const value of ['A'.repeat(40), 'a'.repeat(39), ' '+ 'a'.repeat(40)]) expect(oid.safeParse(value).success).toBe(false);});
 it('rejects author spoofing and missing obligations', () => {expect(claimInput.safeParse({obligationIds:[],areas:['api']}).success).toBe(false);expect(claimInput.safeParse({obligationIds:['tenant'],areas:['api'],owner:'human'}).success).toBe(false);});
 it('requires explicit decision participants', () => {expect(decisionInput.safeParse({question:'shape?',obligationIds:['legacy'],participants:[]}).success).toBe(false);});
 it('validates immutable revisions and mutation envelope', () => {expect(mutation(revisionInput).safeParse({requestId:'r1',payload:{baseCommitOid:'a'.repeat(40),commitOid:'b'.repeat(40),treeOid:'c'.repeat(40),obligationIds:['legacy'],decisionRevisions:[],dependencies:[]}}).success).toBe(true);});
 it('rejects latest aliases in view inputs', () => {expect(viewInput.safeParse({baseVersion:1,baseCommitOid:'latest',contractVersion:1,policyVersion:1,orderedRevisions:[],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1}).success).toBe(false);});
});
