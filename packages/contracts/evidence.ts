import { z } from 'zod';
import { applicabilitySchema, digest, id, oid, version } from './index.js';

export const sandboxExecutionSchema = z.object({
  status: z.enum(['exited', 'timed-out', 'output-limit']),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(65536),
  stderr: z.string().max(65536),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  nodeVersion: z.string().min(1).max(100), stdoutDigest: digest, stderrDigest: digest,
}).strict();

export const checkReceiptSchema = z.object({
  kind: z.literal('recorded-check'), checkId: id,
  obligationIds: z.array(id).min(1).max(100).refine(xs => new Set(xs).size === xs.length),
  applicability: applicabilitySchema, harnessVersion: z.literal('json-oracle-v1'),
  result: z.enum(['passed', 'failed']),
  execution: sandboxExecutionSchema,
}).strict().superRefine((receipt, ctx) => {
  if (Date.parse(receipt.execution.finishedAt) < Date.parse(receipt.execution.startedAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['execution', 'finishedAt'], message: 'Execution must finish at or after it starts' });
  if (receipt.result === 'passed' && (receipt.execution.status !== 'exited' || receipt.execution.exitCode !== 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Passed receipts require normal exit code zero' });
});

export const checkResourceSchema = z.object({ id, version, owner: id, data: checkReceiptSchema }).strict();
export const checksListSchema = z.array(checkResourceSchema);
export type CheckResource = z.infer<typeof checkResourceSchema>;
