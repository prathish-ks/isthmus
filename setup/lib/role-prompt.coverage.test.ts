import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ brightSelect: vi.fn(async () => 'owner') }));
vi.mock('./bright-select.js', () => ({ brightSelect: h.brightSelect }));
vi.mock('./runner.js', () => ({ ensureAnswer: (v: unknown) => v }));

import { askOperatorRole } from './role-prompt.js';

describe('askOperatorRole', () => {
  it('prompts with the three roles, owner as the default, and returns the pick', async () => {
    h.brightSelect.mockResolvedValueOnce('admin');
    const role = await askOperatorRole('Telegram');
    expect(role).toBe('admin');
    expect(h.brightSelect).toHaveBeenCalledWith({
      message: 'How should this Telegram account be registered?',
      initialValue: 'owner',
      options: [
        { value: 'owner', label: 'Owner', hint: 'full access — recommended for your own account' },
        { value: 'admin', label: 'Admin', hint: 'can manage the agent for this channel' },
        { value: 'member', label: 'Member', hint: 'can chat with the agent but nothing more' },
      ],
    });
  });

  it('defaulting (Enter) resolves to owner', async () => {
    h.brightSelect.mockResolvedValueOnce('owner');
    expect(await askOperatorRole('Slack')).toBe('owner');
  });
});
