/**
 * Coverage-uplift tests for templates/tasks.ts (no sibling test file
 * previously existed for this module): prepareTemplateTasks' empty-slug
 * throw, and parseTaskFile's empty-name / missing-closing-frontmatter /
 * non-mapping-frontmatter throws, plus the happy path (including an
 * optional `script` field).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareTemplateTasks, readTasks } from './tasks.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-template-tasks-cov-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTask(filename: string, content: string): void {
  // Test-only helper: `filename` is always a literal from this same file,
  // and `dir` is a freshly mkdtemp'd temp directory — never external input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  fs.writeFileSync(path.join(dir, filename), content);
}

describe('readTasks / parseTaskFile', () => {
  it('returns an empty list when the directory does not exist', () => {
    expect(readTasks(path.join(dir, 'no-such-dir'), 'src')).toEqual([]);
  });

  it('parses a well-formed task with a prompt, schedule, and optional script', () => {
    writeTask('daily.md', '---\nschedule: "0 9 * * *"\nscript: echo hi\n---\nDo the daily thing.\n');
    const tasks = readTasks(dir, 'ext/tasks');
    expect(tasks).toEqual([
      {
        name: 'daily',
        schedule: '0 9 * * *',
        script: 'echo hi',
        prompt: 'Do the daily thing.',
        source: 'ext/tasks/daily.md',
      },
    ]);
  });

  it('throws when the file has no task name (literally ".md")', () => {
    writeTask('.md', '---\nschedule: "* * * * *"\n---\nHi.\n');
    expect(() => readTasks(dir, 'src')).toThrow('has no task name');
  });

  it('throws when frontmatter never closes', () => {
    writeTask('unclosed.md', '---\nschedule: "* * * * *"\n');
    expect(() => readTasks(dir, 'src')).toThrow('is missing the closing ---');
  });

  it('throws when frontmatter is not a YAML mapping', () => {
    writeTask('scalar.md', '---\njust text\n---\nBody\n');
    expect(() => readTasks(dir, 'src')).toThrow('frontmatter must be a YAML mapping');
  });

  it('throws on invalid YAML frontmatter', () => {
    writeTask('badyaml.md', '---\nschedule: [unterminated\n---\nBody\n');
    expect(() => readTasks(dir, 'src')).toThrow('has invalid YAML frontmatter');
  });

  it('throws when frontmatter carries an unrecognized field', () => {
    writeTask('extra.md', '---\nschedule: "* * * * *"\nbogus: 1\n---\nBody\n');
    expect(() => readTasks(dir, 'src')).toThrow('accepts only schedule and script');
  });

  it('throws when schedule is missing or empty', () => {
    writeTask('noschedule.md', '---\nscript: echo hi\n---\nBody\n');
    expect(() => readTasks(dir, 'src')).toThrow('schedule must be a nonempty string');
  });

  it('throws when script is present but empty', () => {
    writeTask('emptyscript.md', '---\nschedule: "* * * * *"\nscript: "   "\n---\nBody\n');
    expect(() => readTasks(dir, 'src')).toThrow('script must be a nonempty string');
  });

  it('throws when the prompt body is empty', () => {
    writeTask('noprompt.md', '---\nschedule: "* * * * *"\n---\n\n');
    expect(() => readTasks(dir, 'src')).toThrow('prompt is required');
  });

  it('ignores non-.md files and sorts by filename', () => {
    writeTask('b.md', '---\nschedule: "* * * * *"\n---\nB.\n');
    writeTask('a.md', '---\nschedule: "* * * * *"\n---\nA.\n');
    writeTask('notes.txt', 'ignore me');
    const tasks = readTasks(dir, 'src');
    expect(tasks.map((t) => t.name)).toEqual(['a', 'b']);
  });
});

describe('prepareTemplateTasks', () => {
  it('throws when a task name produces an empty id slug', () => {
    expect(() =>
      prepareTemplateTasks([{ name: '!!!', schedule: '* * * * *', prompt: 'hi', source: 'x/y.md' }], 'UTC'),
    ).toThrow(/produces an empty id slug/);
  });

  it('throws when two task names collide on the same id slug', () => {
    const tasks = [
      { name: 'Daily Report!', schedule: '* * * * *', prompt: 'a', source: 'x/1.md' },
      { name: 'daily report', schedule: '* * * * *', prompt: 'b', source: 'x/2.md' },
    ];
    expect(() => prepareTemplateTasks(tasks, 'UTC')).toThrow(/collide on id slug/);
  });

  it('prepares valid tasks keyed by name', () => {
    const tasks = [{ name: 'daily', schedule: '0 9 * * *', prompt: 'do it', source: 'x/daily.md' }];
    const prepared = prepareTemplateTasks(tasks, 'UTC');
    expect(prepared.has('daily')).toBe(true);
  });

  it('wraps a prepareScheduledTask validation failure with the source location', () => {
    const tasks = [{ name: 'bad-schedule', schedule: 'not a cron expression', prompt: 'x', source: 'x/bad.md' }];
    expect(() => prepareTemplateTasks(tasks, 'UTC')).toThrow(/Invalid template task x\/bad\.md/);
  });
});
