/**
 * Coverage top-up for setup/uninstall/onecli-agents.ts (already 100% line
 * coverage per the sibling onecli-agents.test.ts). Fills in listVaultAgents'
 * per-entry defensive guards: a null/non-object entry in `data`, a
 * non-string `identifier`/`id`, and a missing/non-string `name` defaulting
 * to ''.
 */
import { describe, expect, it } from 'vitest';

import { listVaultAgents } from './onecli-agents.js';

describe('listVaultAgents — malformed vault entries', () => {
  it('skips null and non-object entries in the data array', () => {
    const payload = JSON.stringify({
      data: [null, 'a string entry', 42, { id: 'u-1', identifier: 'ag-good', name: 'Good', isDefault: false }],
    });
    const result = listVaultAgents(() => ({ status: 0, stdout: payload }));
    expect(result.available).toBe(true);
    expect(result.agents).toEqual([{ uuid: 'u-1', identifier: 'ag-good', name: 'Good' }]);
  });

  it('drops an entry whose identifier or id is not a string', () => {
    const payload = JSON.stringify({
      data: [
        { id: 'u-1', identifier: 42, name: 'Bad identifier', isDefault: false },
        { id: 99, identifier: 'ag-bad-id', name: 'Bad id', isDefault: false },
      ],
    });
    const result = listVaultAgents(() => ({ status: 0, stdout: payload }));
    expect(result.available).toBe(true);
    expect(result.agents).toEqual([]);
  });

  it('defaults name to "" when the field is missing or not a string', () => {
    const payload = JSON.stringify({
      data: [
        { id: 'u-1', identifier: 'ag-noname', isDefault: false },
        { id: 'u-2', identifier: 'ag-numname', name: 123, isDefault: false },
      ],
    });
    const result = listVaultAgents(() => ({ status: 0, stdout: payload }));
    expect(result.agents).toEqual([
      { uuid: 'u-1', identifier: 'ag-noname', name: '' },
      { uuid: 'u-2', identifier: 'ag-numname', name: '' },
    ]);
  });
});
