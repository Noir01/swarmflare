import { z } from 'zod';
import { version } from './index';

export const decisionResolutionInput = z.object({
  kind: z.enum(['clarification', 'contract-update']),
  contractVersion: version,
  note: z.string().trim().min(1).max(4000),
}).strict();