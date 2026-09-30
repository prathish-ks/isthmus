import { expect, it } from 'vitest';
import { normalizeGatewayApprovalSummary } from './gateway-approval-summary.js';

const request = (method: string) => ({ agent: 'Nano', method, host: 'api.example.test', path: '/repos?token=secret' });

it('uses the caller-supplied action when present', () => {
  const summary = normalizeGatewayApprovalSummary(request('POST'), { action: 'Post a comment' });
  expect(summary.action).toBe('Post a comment');
});

it('falls back to a read description for GET/HEAD requests with no supplied action', () => {
  const summary = normalizeGatewayApprovalSummary(request('GET'), {});
  expect(summary.action).toBe('Read from an external service');
});

it('falls back to a write description for other methods with no supplied action', () => {
  const summary = normalizeGatewayApprovalSummary(request('POST'), {});
  expect(summary.action).toBe('Send a request that may change external data');
});

it('falls back to a write description when no summary object is supplied at all', () => {
  const summary = normalizeGatewayApprovalSummary(request('DELETE'));
  expect(summary.action).toBe('Send a request that may change external data');
});
