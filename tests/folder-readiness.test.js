const test = require('node:test');
const assert = require('node:assert/strict');

const folderReadiness = require('../src/folder-readiness.js');

function entryStorage({ existing = null, createError = null, race = false } = {}) {
  const calls = [];
  let child = existing;
  const parent = {
    isFolder: true,
    async getEntry(name) {
      calls.push(['getEntry', name]);
      if (!child) throw new Error('entry missing');
      return child;
    },
    async createFolder(name) {
      calls.push(['createFolder', name]);
      if (!createError || race) child = { isFolder: true };
      if (createError) throw createError;
      return child;
    },
  };
  return { calls, async getEntryWithUrl(url) { calls.push(['url', url]); return parent; } };
}

for (const [target, parent] of [
  ['E:\\节目\\Adobe Premiere Pro Captured and Generated', 'file:/E:/节目'],
  ['E:\\Adobe Premiere Pro Captured and Generated', 'file:/E:/'],
  ['/Volumes/Edit/节目/Adobe Premiere Pro Captured and Generated', 'file:/Volumes/Edit/节目'],
  ['/Adobe Premiere Pro Captured and Generated', 'file:/'],
  ['\\\\server\\share\\Adobe Premiere Pro Captured and Generated', 'file://server/share'],
]) {
  test(`UXP entry API creates only the requested child: ${target}`, async () => {
    const storage = entryStorage();
    const result = await folderReadiness.ensure({
      async mkdir() { throw new Error('unsupported host fs call'); },
    }, target, storage);
    assert.deepEqual(result, { valid: true, created: true, problem: '' });
    assert.deepEqual(storage.calls, [
      ['url', parent],
      ['getEntry', 'Adobe Premiere Pro Captured and Generated'],
      ['createFolder', 'Adobe Premiere Pro Captured and Generated'],
      ['getEntry', 'Adobe Premiere Pro Captured and Generated'],
    ]);
  });
}

test('UXP entry API reuses existing folder without creating it', async () => {
  const storage = entryStorage({ existing: { isFolder: true } });
  const result = await folderReadiness.ensure({}, 'E:\\project\\media', storage);
  assert.equal(result.valid, true);
  assert.equal(result.created, false);
  assert.equal(storage.calls.some(call => call[0] === 'createFolder'), false);
});

test('UXP entry API verifies concurrent creation despite uncoded error', async () => {
  const storage = entryStorage({ createError: new Error('host error'), race: true });
  assert.deepEqual(await folderReadiness.ensure({}, 'E:\\project\\media', storage),
    { valid: true, created: false, problem: '' });
});

test('UXP failures keep both API diagnostics and never overwrite a file', async () => {
  const storage = entryStorage({ existing: { isFolder: false } });
  const result = await folderReadiness.ensure({
    async lstat() { return { isDirectory: () => false }; },
    async mkdir() { throw new Error('host mkdir failure'); },
  }, 'E:\\project\\media', storage);
  assert.equal(result.valid, false);
  assert.match(result.problem, /同名文件/);
  assert.match(result.problem, /host mkdir failure/);
  assert.equal(storage.calls.some(call => call[0] === 'createFolder'), false);
});

test('fs remains a fallback when UXP entry creation is unavailable', async () => {
  let present = false;
  const storage = entryStorage({ createError: new Error('entry unsupported') });
  const result = await folderReadiness.ensure({
    async lstat() { if (!present) throw new Error('missing'); return { isDirectory: () => true }; },
    async mkdir() { present = true; },
  }, 'E:\\project\\media', storage);
  assert.deepEqual(result, { valid: true, created: true, problem: '' });
});

test('production wires native entry storage into every directory creation', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main.js'), 'utf8');
  const calls = source.match(/FolderReadiness\.ensure\([^;\n]+/g);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.includes('uxp.storage.localFileSystem')));
});

test('panel version matches the manifest version', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../plugin/manifest.json'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '../plugin/index.html'), 'utf8');
  assert.ok(html.includes('<div class="version">' + manifest.version + '</div>'));
});

test('extended Windows project paths resolve to the same ordinary destination', () => {
  const core = require('../src/core.js');
  const plain = 'E:\\节目\\工程.prproj';
  const extended = '\\\\?\\' + plain;
  assert.equal(core.recordingDirectoryFromProjectPath(extended), core.recordingDirectoryFromProjectPath(plain));
  assert.equal(core.sameNativePath(extended, plain), true);
  assert.equal(core.plainNativePath('\\\\?\\UNC\\server\\share\\a'), '\\\\server\\share\\a');
  assert.equal(core.plainNativePath('/Volumes/Edit/a'), '/Volumes/Edit/a');
});

test('folder readiness keeps an unselected path incomplete without an error', async () => {
  const result = await folderReadiness.inspect({}, '');
  assert.deepEqual(result, { valid: false, problem: '' });
});

test('folder readiness accepts a directory', async () => {
  const result = await folderReadiness.inspect({
    lstat: async () => ({ isDirectory: () => true }),
  }, 'D:\\Captured Audio');
  assert.deepEqual(result, { valid: true, problem: '' });
});

test('folder readiness rejects a file path with a specific recovery message', async () => {
  const result = await folderReadiness.inspect({
    lstat: async () => ({ isDirectory: () => false }),
  }, 'D:\\Captured Audio\\recording.wav');
  assert.equal(result.valid, false);
  assert.match(result.problem, /文件/);
  assert.match(result.problem, /重新选择/);
});

test('folder readiness rejects missing or inaccessible directories', async () => {
  const result = await folderReadiness.inspect({
    lstat: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  }, 'D:\\Missing');
  assert.equal(result.valid, false);
  assert.match(result.problem, /不存在或无法访问/);
});

test('folder readiness fails closed when filesystem metadata cannot identify a directory', async () => {
  const result = await folderReadiness.inspect({
    lstat: async () => ({}),
  }, 'D:\\Unknown');
  assert.equal(result.valid, false);
  assert.match(result.problem, /无法确认/);
});

test('folder readiness creates and verifies a missing project recording directory', async () => {
  let present = false;
  const calls = [];
  const result = await folderReadiness.ensure({
    async lstat(path) {
      calls.push(['lstat', path]);
      if (!present) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return { isDirectory: () => true };
    },
    async mkdir(path) {
      calls.push(['mkdir', path]);
      present = true;
    },
  }, 'E:\\节目\\Adobe Premiere Pro Captured and Generated');

  assert.deepEqual(result, { valid: true, created: true, problem: '' });
  assert.deepEqual(calls, [
    ['lstat', 'E:\\节目\\Adobe Premiere Pro Captured and Generated'],
    ['mkdir', 'E:\\节目\\Adobe Premiere Pro Captured and Generated'],
    ['lstat', 'E:\\节目\\Adobe Premiere Pro Captured and Generated'],
  ]);
});

test('folder readiness reuses an existing project recording directory without mkdir', async () => {
  let mkdirCalls = 0;
  const result = await folderReadiness.ensure({
    async lstat() { return { isDirectory: () => true }; },
    async mkdir() { mkdirCalls += 1; },
  }, '/Volumes/Edit/节目/Adobe Premiere Pro Captured and Generated');

  assert.deepEqual(result, { valid: true, created: false, problem: '' });
  assert.equal(mkdirCalls, 0);
});

test('folder readiness reports a project recording directory creation failure', async () => {
  const result = await folderReadiness.ensure({
    async lstat() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    async mkdir() {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  }, 'E:\\节目\\Adobe Premiere Pro Captured and Generated');

  assert.equal(result.valid, false);
  assert.equal(result.created, false);
  assert.match(result.problem, /无法创建工程媒体目录/);
  assert.match(result.problem, /没有写入权限/);
  assert.doesNotMatch(result.problem, /permission denied/i);
});
