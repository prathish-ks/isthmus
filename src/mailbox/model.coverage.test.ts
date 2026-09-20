/**
 * Coverage-uplift tests for mailbox/model.ts targeting branches the
 * pre-existing model.test.ts suite doesn't reach: parseIsoTimestamp's
 * type-guard, strictRecord's non-object guard, the various optional/nullable
 * field helpers' undefined-vs-absent branches, parseDeliveryRecord,
 * parseStateRecord, and the parseMailboxRecord dispatch switch (every kind).
 */
import { describe, expect, it } from 'vitest';

import {
  createOutboundRecord,
  parseContainerRecord,
  parseDeliveryRecord,
  parseDestinationRecord,
  parseInboundRecord,
  parseIsoTimestamp,
  parseMailboxRecord,
  parseOutboundDelivery,
  parseOutboundRecord,
  parseOutboundWrite,
  parseProcessingAckRecord,
  parseSessionRoutingRecord,
  parseStateRecord,
  parseTaskRecord,
} from './model.js';

const ISO = '2026-01-01T00:00:00.000Z';

describe('parseIsoTimestamp', () => {
  it('rejects a non-string value', () => {
    expect(() => parseIsoTimestamp(12345)).toThrow('invalid ISO-8601 UTC timestamp');
  });

  it('rejects a string that is not a valid ISO-8601 round-trip', () => {
    expect(() => parseIsoTimestamp('not-a-date')).toThrow('invalid ISO-8601 UTC timestamp');
    // Valid Date.parse but not the canonical toISOString() representation.
    expect(() => parseIsoTimestamp('2026-01-01')).toThrow('invalid ISO-8601 UTC timestamp');
  });

  it('accepts a canonical ISO-8601 timestamp', () => {
    expect(parseIsoTimestamp(ISO)).toBe(ISO);
  });
});

describe('strictRecord non-object guard (via parseInboundRecord)', () => {
  it('rejects a non-object value', () => {
    expect(() => parseInboundRecord('not an object')).toThrow('expected object');
    expect(() => parseInboundRecord(null)).toThrow('expected object');
    expect(() => parseInboundRecord(['array'])).toThrow('expected object');
  });
});

const baseInbound = {
  id: 'm-1',
  sequence: 1,
  kind: 'chat' as const,
  timestamp: ISO,
  status: 'pending' as const,
  processAfter: null,
  recurrence: null,
  seriesId: null,
  tries: 0,
  trigger: true,
  platformId: null,
  channelType: null,
  threadId: null,
  content: '{}',
  sourceSessionId: null,
  onWake: false,
};

describe('nullableText / optionalNullableText branches', () => {
  it('rejects a non-string, non-null value for a nullable field', () => {
    expect(() => parseInboundRecord({ ...baseInbound, platformId: 42 })).toThrow('expected string or null');
  });

  it('optionalNullableText: an explicit undefined value on an optional key parses to undefined', () => {
    const write = parseOutboundWrite({ id: 'o-1', kind: 'chat', content: '{}', inReplyTo: undefined });
    expect(write.inReplyTo).toBeUndefined();
  });

  it('optionalNullableText: a present nullable string value is kept', () => {
    const write = parseOutboundWrite({ id: 'o-1', kind: 'chat', content: '{}', inReplyTo: 'orig-1' });
    expect(write.inReplyTo).toBe('orig-1');
  });
});

describe('optionalNullableTimestamp branches', () => {
  it('an explicit undefined value on deliverAfter parses to undefined', () => {
    const write = parseOutboundWrite({ id: 'o-1', kind: 'chat', content: '{}', deliverAfter: undefined });
    expect(write.deliverAfter).toBeUndefined();
  });

  it('a present deliverAfter timestamp is parsed', () => {
    const write = parseOutboundWrite({ id: 'o-1', kind: 'chat', content: '{}', deliverAfter: ISO });
    expect(write.deliverAfter).toBe(ISO);
  });
});

describe('optionalBoolean branches (via parseInboundRecord/Write trigger and onWake)', () => {
  it('a key absent from the record resolves to undefined (createOutboundRecord defaults still apply upstream)', () => {
    // parseInboundRecord requires trigger/onWake to be present (non-optional
    // in the *Record* shape), so exercise the absent-key branch through the
    // optional field on InboundWrite via createInboundRecord's caller path
    // instead — parseOutboundWrite's optional fields cover the "not in record" branch.
    const write = parseOutboundWrite({ id: 'o-1', kind: 'chat', content: '{}' });
    expect(write).not.toHaveProperty('inReplyTo');
    expect(write).not.toHaveProperty('recurrence');
  });

  it('rejects a non-boolean trigger value', () => {
    expect(() => parseInboundRecord({ ...baseInbound, trigger: 'yes' })).toThrow('expected boolean');
  });
});

describe('parseDeliveryRecord', () => {
  it('parses a delivered record', () => {
    const rec = parseDeliveryRecord({
      messageOutId: 'o-1',
      platformMessageId: 'pm-1',
      status: 'delivered',
      deliveredAt: ISO,
    });
    expect(rec).toEqual({ messageOutId: 'o-1', platformMessageId: 'pm-1', status: 'delivered', deliveredAt: ISO });
  });

  it('rejects an unknown status value', () => {
    expect(() =>
      parseDeliveryRecord({ messageOutId: 'o-1', platformMessageId: null, status: 'bogus', deliveredAt: ISO }),
    ).toThrow('unexpected value');
  });
});

describe('parseStateRecord', () => {
  it('parses a state record', () => {
    const rec = parseStateRecord({ key: 'k', value: 'v', updatedAt: ISO });
    expect(rec).toEqual({ key: 'k', value: 'v', updatedAt: ISO });
  });

  it('rejects a non-string value field', () => {
    expect(() => parseStateRecord({ key: 'k', value: 42, updatedAt: ISO })).toThrow('expected string');
  });
});

describe('parseMailboxRecord dispatch', () => {
  const outboundBase = {
    id: 'o-1',
    sequence: 1,
    inReplyTo: null,
    timestamp: ISO,
    deliverAfter: null,
    recurrence: null,
    kind: 'chat',
    platformId: null,
    channelType: null,
    threadId: null,
    content: '{}',
  };

  it('dispatches inbound', () => {
    expect(parseMailboxRecord('inbound', baseInbound)).toEqual(parseInboundRecord(baseInbound));
  });

  it('dispatches outbound', () => {
    expect(parseMailboxRecord('outbound', outboundBase)).toEqual(parseOutboundRecord(outboundBase));
  });

  it('dispatches processingAck', () => {
    const value = { messageId: 'm-1', status: 'processing', statusChanged: ISO };
    expect(parseMailboxRecord('processingAck', value)).toEqual(parseProcessingAckRecord(value));
  });

  it('dispatches delivery', () => {
    const value = { messageOutId: 'o-1', platformMessageId: null, status: 'failed', deliveredAt: ISO };
    expect(parseMailboxRecord('delivery', value)).toEqual(parseDeliveryRecord(value));
  });

  it('dispatches destination', () => {
    const value = {
      name: 'buddy',
      displayName: null,
      type: 'agent',
      channelType: null,
      platformId: null,
      agentGroupId: 'ag-1',
    };
    expect(parseMailboxRecord('destination', value)).toEqual(parseDestinationRecord(value));
  });

  it('dispatches sessionRouting', () => {
    const value = { channelType: 'telegram', platformId: 'telegram:1', threadId: null };
    expect(parseMailboxRecord('sessionRouting', value)).toEqual(parseSessionRoutingRecord(value));
  });

  it('dispatches state', () => {
    const value = { key: 'k', value: 'v', updatedAt: ISO };
    expect(parseMailboxRecord('state', value)).toEqual(parseStateRecord(value));
  });

  it('dispatches container', () => {
    const value = { currentTool: null, toolDeclaredTimeoutMs: null, toolStartedAt: null, updatedAt: ISO };
    expect(parseMailboxRecord('container', value)).toEqual(parseContainerRecord(value));
  });
});

describe('createOutboundRecord / outboundDelivery round trip (sanity for parseOutboundDelivery)', () => {
  it('round-trips through outboundDelivery', () => {
    const record = createOutboundRecord({ id: 'o-1', kind: 'chat', content: '{"text":"hi"}' }, 1, ISO);
    const delivery = parseOutboundDelivery({
      id: record.id,
      kind: record.kind,
      platformId: record.platformId,
      channelType: record.channelType,
      threadId: record.threadId,
      content: record.content,
      inReplyTo: record.inReplyTo,
    });
    expect(delivery.id).toBe('o-1');
  });
});

describe('parseTaskRecord', () => {
  it('parses a full task record', () => {
    const rec = parseTaskRecord({
      id: 't-1',
      seriesId: 's-1',
      status: 'pending',
      processAfter: null,
      recurrence: null,
      content: '{}',
      timestamp: ISO,
      tries: 0,
      sequence: 1,
    });
    expect(rec.id).toBe('t-1');
  });
});
