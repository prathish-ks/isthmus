import { registerResource } from '../crud.js';

// unknown_sender_<policy> covers every UnknownSenderPolicy (src/types.ts) the
// host actually writes a drop for — strict, request_approval, decline_notify.
// 'public' is excluded on purpose: setAccessGate (src/modules/permissions/
// index.ts) admits every sender on a public group before handleUnknownSender
// ever runs, so the host never records unknown_sender_public.
registerResource({
  name: 'dropped-message',
  plural: 'dropped-messages',
  table: 'unregistered_senders',
  description:
    "Dropped message log — tracks messages that were dropped by the router or access gate. Aggregates by (channel_type, platform_id) with a running count. Reasons include: no_agent_wired (no wiring exists), no_agent_engaged (wiring exists but engage rules didn't fire), unknown_sender_<policy> (sender not recognized; the suffix is the messaging group's unknown_sender_policy: unknown_sender_strict, unknown_sender_request_approval, unknown_sender_decline_notify; a public group admits every sender, so it never records a drop).",
  idColumn: 'channel_type',
  listOrder: 'last_seen DESC, channel_type, platform_id',
  columns: [
    { name: 'channel_type', type: 'string', description: 'Channel adapter type of the dropped message.' },
    { name: 'platform_id', type: 'string', description: 'Platform chat ID where the message was dropped.' },
    { name: 'user_id', type: 'string', description: 'Sender user ID if resolved, null otherwise.' },
    { name: 'sender_name', type: 'string', description: 'Sender display name if available.' },
    {
      name: 'reason',
      type: 'string',
      description: 'Why the message was dropped.',
      enum: [
        'no_agent_wired',
        'no_agent_engaged',
        'unknown_sender_strict',
        'unknown_sender_request_approval',
        'unknown_sender_decline_notify',
      ],
    },
    { name: 'messaging_group_id', type: 'string', description: 'Messaging group ID if resolved.' },
    { name: 'agent_group_id', type: 'string', description: 'Target agent group ID if resolved.' },
    { name: 'message_count', type: 'number', description: 'Number of dropped messages from this sender on this chat.' },
    { name: 'first_seen', type: 'string', description: 'First drop timestamp.' },
    { name: 'last_seen', type: 'string', description: 'Most recent drop timestamp.' },
  ],
  operations: { list: 'open' },
});
