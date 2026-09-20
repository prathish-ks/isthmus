/**
 * Coverage-uplift tests for templates/skills.ts (no sibling test file
 * previously existed for this module) — validateSkill's remaining
 * rejection branches: SKILL.md as a symlink/non-regular-file, a missing
 * closing frontmatter delimiter, invalid YAML, and non-mapping frontmatter.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPluginSkills } from './skills.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-cov-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function skillDir(name: string): string {
  const d = path.join(dir, 'skills', name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe('readPluginSkills / validateSkill', () => {
  it('accepts a well-formed skill', () => {
    const d = skillDir('good-skill');
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: good-skill\ndescription: does a thing\n---\nBody.\n');
    const { skills, report } = readPluginSkills(dir);
    expect(skills).toEqual([{ name: 'good-skill', srcDir: d }]);
    expect(report).toEqual([]);
  });

  it('skips when skills/ does not exist', () => {
    expect(readPluginSkills(dir)).toEqual({ skills: [], report: [] });
  });

  it('reports when skills/ exists but is not a directory', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills'), 'not a directory');
    const { skills, report } = readPluginSkills(dir);
    expect(skills).toEqual([]);
    expect(report).toEqual(['skills: not a directory; skills component skipped']);
  });

  it('skips a symlinked skill entry and reports it', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-target-'));
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.symlinkSync(realDir, path.join(dir, 'skills', 'linked-skill'));
    const { skills, report } = readPluginSkills(dir);
    expect(skills).toEqual([]);
    expect(report).toEqual(['skills/linked-skill: skipped: symlinks are not allowed in plugins']);
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('ignores a stray regular file in skills/', () => {
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'README.md'), 'not a skill dir');
    const { skills, report } = readPluginSkills(dir);
    expect(skills).toEqual([]);
    expect(report).toEqual([]);
  });

  it('rejects a skill directory with no SKILL.md', () => {
    skillDir('no-md');
    const { report } = readPluginSkills(dir);
    expect(report).toEqual(['skills/no-md: skipped: no SKILL.md']);
  });

  it('rejects a symlinked SKILL.md', () => {
    const d = skillDir('symlinked-md');
    const target = path.join(dir, 'real-skill-md.md');
    fs.writeFileSync(target, '---\nname: x\ndescription: y\n---\n');
    fs.symlinkSync(target, path.join(d, 'SKILL.md'));
    const { report } = readPluginSkills(dir);
    expect(report).toEqual(['skills/symlinked-md: skipped: SKILL.md is not a regular file']);
  });

  it('rejects a SKILL.md missing YAML frontmatter entirely', () => {
    const d = skillDir('no-frontmatter');
    fs.writeFileSync(path.join(d, 'SKILL.md'), 'Just prose, no frontmatter.\n');
    const { report } = readPluginSkills(dir);
    expect(report).toEqual(['skills/no-frontmatter: skipped: SKILL.md is missing YAML frontmatter']);
  });

  it('rejects a SKILL.md whose frontmatter never closes', () => {
    const d = skillDir('unclosed');
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: x\ndescription: y\n');
    const { report } = readPluginSkills(dir);
    expect(report).toEqual(['skills/unclosed: skipped: SKILL.md frontmatter is missing the closing ---']);
  });

  it('rejects invalid YAML frontmatter', () => {
    const d = skillDir('bad-yaml');
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: [unterminated\n---\nBody\n');
    const { report } = readPluginSkills(dir);
    expect(report).toEqual(['skills/bad-yaml: skipped: SKILL.md frontmatter is not valid YAML']);
  });

  it('rejects frontmatter that is not a YAML mapping (a scalar)', () => {
    const d = skillDir('scalar-frontmatter');
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\njust a string\n---\nBody\n');
    const { report } = readPluginSkills(dir);
    expect(report).toEqual(['skills/scalar-frontmatter: skipped: SKILL.md frontmatter must be a YAML mapping']);
  });

  it('rejects frontmatter that is a YAML sequence, not a mapping', () => {
    const d = skillDir('array-frontmatter');
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\n- one\n- two\n---\nBody\n');
    const { report } = readPluginSkills(dir);
    expect(report).toEqual(['skills/array-frontmatter: skipped: SKILL.md frontmatter must be a YAML mapping']);
  });

  it('rejects frontmatter missing the required name/description fields', () => {
    const d = skillDir('missing-desc');
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: missing-desc\n---\nBody\n');
    const { report } = readPluginSkills(dir);
    expect(report).toEqual(['skills/missing-desc: skipped: SKILL.md frontmatter is missing "description"']);
  });
});
