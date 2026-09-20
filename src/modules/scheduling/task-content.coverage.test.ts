/** Coverage tests for the task content envelope decoder. */
import { describe, expect, it } from 'vitest';

import { parseTaskContent } from './task-content.js';

describe('parseTaskContent', () => {
  it('decodes a full JSON envelope', () => {
    expect(
      parseTaskContent(JSON.stringify({ prompt: 'daily digest', script: 'check.sh', originSessionId: 'sess-1' })),
    ).toEqual({ prompt: 'daily digest', script: 'check.sh', originSessionId: 'sess-1' });
  });

  it('defaults missing or mistyped fields', () => {
    expect(parseTaskContent(JSON.stringify({ prompt: 42, script: 7, originSessionId: false }))).toEqual({
      prompt: '',
      script: null,
      originSessionId: null,
    });
    expect(parseTaskContent('{}')).toEqual({ prompt: '', script: null, originSessionId: null });
  });

  it('treats non-JSON legacy content as the bare prompt', () => {
    expect(parseTaskContent('remind me to stretch')).toEqual({
      prompt: 'remind me to stretch',
      script: null,
      originSessionId: null,
    });
  });
});
