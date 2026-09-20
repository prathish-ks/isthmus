/**
 * Approvals module root — import-time wiring.
 *
 * Importing the module must (1) register the approvals response handler,
 * (2) start the OneCLI handler once the delivery adapter is bound, and
 * (3) stop it from the host shutdown path. The OneCLI handler itself is
 * stubbed; the lifecycle registries are real.
 */
import { describe, expect, it, vi } from 'vitest';

import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { getHostShutdownCallbacks } from '../../host-lifecycle.js';
import { getResponseHandlers } from '../../response-registry.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';
import { handleApprovalsResponse } from './response-handler.js';
import * as approvals from './index.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./onecli-approvals.js', () => ({
  ONECLI_ACTION: 'onecli_credential',
  resolveOneCLIApproval: vi.fn(),
  startOneCLIApprovalHandler: vi.fn(),
  stopOneCLIApprovalHandler: vi.fn(),
}));

describe('approvals module wiring', () => {
  it('re-exports the public primitive API', () => {
    expect(typeof approvals.requestApproval).toBe('function');
    expect(typeof approvals.registerApprovalHandler).toBe('function');
    expect(typeof approvals.notifyAgent).toBe('function');
    expect(typeof approvals.sweepAwaitingReasonRejects).toBe('function');
  });

  it('registers the approvals response handler with core', () => {
    expect(getResponseHandlers()).toContain(handleApprovalsResponse);
  });

  it('starts the OneCLI handler once the delivery adapter is bound', async () => {
    const adapter: ChannelDeliveryAdapter = {
      async deliver(): Promise<string | undefined> {
        return undefined;
      },
    };
    setDeliveryAdapter(adapter);
    await vi.waitFor(() => {
      expect(startOneCLIApprovalHandler).toHaveBeenCalledWith(adapter);
    });
  });

  it('stops the OneCLI handler from the host shutdown path', async () => {
    const callbacks = getHostShutdownCallbacks();
    expect(callbacks.length).toBeGreaterThan(0);
    for (const cb of callbacks) await cb();
    expect(stopOneCLIApprovalHandler).toHaveBeenCalled();
  });
});
