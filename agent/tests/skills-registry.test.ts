import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry } from '../src/skills/index.js';

async function makeSkill(root: string, name: string, body: string, revision = '1.0.0'): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} method\nrevision: ${revision}\n---\n${body}\n`);
  return dir;
}

test('scope precedence and immutable snapshot content survive a refresh', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dangoo-skills-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const builtin = path.join(root, 'builtin');
  const user = path.join(root, 'user');
  await makeSkill(builtin, 'draw', 'builtin body');
  await makeSkill(user, 'draw', 'user body');
  const registry = new SkillRegistry({ roots: [{ path: builtin, scope: 'builtin' }, { path: user, scope: 'user' }] });
  const first = (await registry.discover()).snapshot;
  assert.equal(await registry.read('draw', first), 'user body\n');
  // User scope has higher priority once both roots use distinct packages.
  await writeFile(path.join(user, 'draw', 'SKILL.md'), '---\nname: draw\ndescription: user method\nrevision: 1.0.0\n---\nuser body\n');
  await registry.discover();
  assert.equal(await registry.read('draw'), 'user body\n');
  assert.equal(await registry.read('draw', first), 'user body\n');
});

test('metadata, progressive resources and portable resource paths are enforced', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dangoo-skills-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const skillDir = await makeSkill(root, 'collage', 'collage body');
  await mkdir(path.join(skillDir, 'docs'));
  await writeFile(path.join(skillDir, 'docs', 'guide.md'), 'guide');
  const registry = new SkillRegistry({ roots: [{ path: root, scope: 'workspace' }] });
  const result = await registry.discover();
  assert.equal(await registry.resource('collage', 'docs/guide.md', result.snapshot), 'guide');
  for (const escapedPath of ['../outside', '..\\outside', 'C:\\outside', '\\\\server\\share', 'C:outside']) {
    await assert.rejects(() => registry.resource('collage', escapedPath, result.snapshot), /escapes|relative/);
  }
  assert.match(registry.catalog(result.snapshot), /collage/);
});

if (process.platform !== 'win32') {
  test('file symlink resources cannot escape their package', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dangoo-skills-file-symlink-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const skillDir = await makeSkill(root, 'collage', 'collage body');
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, path.join(skillDir, 'escape.txt'), 'file');
    const registry = new SkillRegistry({ roots: [{ path: root, scope: 'workspace' }] });
    const result = await registry.discover();
    assert.equal(result.errors.some((error) => error.message.includes('symlink')), true);
    await assert.rejects(() => registry.resource('collage', 'escape.txt', result.snapshot), /symlink|resource|path/);
  });
}

test('directory links cannot escape their package', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dangoo-skills-directory-link-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const skillDir = await makeSkill(root, 'collage', 'collage body');
  const outside = path.join(root, 'outside-dir');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(outside, path.join(skillDir, 'escape-dir'), linkType);
  const registry = new SkillRegistry({ roots: [{ path: root, scope: 'workspace' }] });
  const result = await registry.discover();
  assert.equal(result.errors.some((error) => error.message.includes('symlink')), true);
  await assert.rejects(() => registry.resource('collage', 'escape-dir/secret.txt', result.snapshot), /symlink|resource|path/);
});

test('implicit selection excludes explicitly disabled or non-implicit skills', () => {
  const registry = new SkillRegistry([
    { name: 'manual', description: 'manual', revision: '1', implicit: false, content: 'manual', scope: 'workspace' },
    { name: 'disabled', description: 'disabled', revision: '1', enabled: false, content: 'disabled', scope: 'workspace' },
  ]);
  assert.throws(() => registry.resolve('manual', { implicit: true }), /not found|unavailable/);
  assert.throws(() => registry.resolve('disabled'), /disabled|unavailable/);
  assert.equal(registry.resolve('manual').name, 'manual');
});
