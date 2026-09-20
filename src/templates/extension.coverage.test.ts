/**
 * Coverage-uplift tests for templates/extension.ts (no sibling test file
 * previously existed for this module): the full readNanoclawExtension
 * happy path, the non-object `extensions["ai.nanoco.nanoclaw"]` report
 * branch, the unrecognized-key report branch, the invalid agentName report
 * branch, and instructions.md-must-be-a-regular-file guard.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NANOCLAW_EXTENSION_NS, readNanoclawExtension } from './extension.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-extension-cov-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readNanoclawExtension', () => {
  it('returns a minimal, empty extension when nothing is present', () => {
    const ext = readNanoclawExtension(dir, {});
    expect(ext).toEqual({ contextExtras: [], tasks: [], report: [] });
  });

  it('reads agentName, instructions, and context extras on the happy path', () => {
    const extDir = path.join(dir, NANOCLAW_EXTENSION_NS, 'context');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'instructions.md'), 'You are helpful.\n\n');
    fs.mkdirSync(path.join(extDir, 'extra'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'extra', 'faq.md'), '# FAQ');

    const ext = readNanoclawExtension(dir, { [NANOCLAW_EXTENSION_NS]: { agentName: '  Andy  ' } });

    expect(ext.agentName).toBe('Andy');
    expect(ext.instructions).toBe('You are helpful.');
    expect(ext.contextExtras).toEqual([{ name: 'extra/faq.md', content: '# FAQ' }]);
    expect(ext.report).toEqual([]);
  });

  it('reports when the extension value is not an object', () => {
    const ext = readNanoclawExtension(dir, { [NANOCLAW_EXTENSION_NS]: 'not-an-object' });
    expect(ext.report).toEqual([`plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"] is not an object; ignored`]);
    expect(ext.agentName).toBeUndefined();
  });

  it('reports an invalid (empty/non-string) agentName without throwing', () => {
    const ext = readNanoclawExtension(dir, { [NANOCLAW_EXTENSION_NS]: { agentName: '   ' } });
    expect(ext.report).toEqual([
      `plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"].agentName must be a nonempty string; ignored`,
    ]);
    expect(ext.agentName).toBeUndefined();
  });

  it('reports unrecognized keys alongside a valid agentName', () => {
    const ext = readNanoclawExtension(dir, {
      [NANOCLAW_EXTENSION_NS]: { agentName: 'Andy', bogusKey: 1 },
    });
    expect(ext.agentName).toBe('Andy');
    expect(ext.report).toEqual([
      `plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"].bogusKey is not recognized; ignored`,
    ]);
  });

  it('throws when instructions.md exists but is not a regular file', () => {
    const contextDir = path.join(dir, NANOCLAW_EXTENSION_NS, 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.mkdirSync(path.join(contextDir, 'instructions.md')); // a directory, not a file
    expect(() => readNanoclawExtension(dir, {})).toThrow(
      `${NANOCLAW_EXTENSION_NS}/context/instructions.md must be a regular file`,
    );
  });
});
