import { expect, it } from 'vitest';
import { waitForValue } from '../fixtures/dashboard-accept';

it('returns the truthy value observed by the successful poll without rereading', async () => {
  const reads = ['Accepted and verified exact baseline tuple', 'Context refreshed'];
  const evaluate = async () => reads.shift() ?? '';

  await expect(waitForValue(evaluate, 'status')).resolves.toBe('Accepted and verified exact baseline tuple');
  expect(reads).toEqual(['Context refreshed']);
});