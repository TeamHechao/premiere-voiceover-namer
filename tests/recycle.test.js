const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/core.js');
const Policy = require('../src/recycle-policy.js');
const Recycler = require('../src/recycle.js');
const Host = require('../src/recycle-host.js');
const Auth = require('../src/recycle-auth.js');
const normalize = Core.normalizePathForComparison;
const id = 'a'.repeat(32);
const target = `E:\\demo\\Adobe Premiere Pro Captured and Generated\\demo-${id}.wav`;
const record = { recordingId: id, projectItemId: 'item', targetPath: target };
const snapshot = (used = false) => ({ complete: true, ids: new Set(used ? ['item'] : []), paths: new Set(), items: [] });

test('recording signature matches standard HMAC-SHA256 including Unicode paths', () => {
  const crypto = require('node:crypto');
  const input = { ...record, projectPath: 'E:\\中文😀\\工程.prproj' };
  const token = 'ab'.repeat(32);
  assert.equal(Auth.sign(input, token), crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(Auth.payload(input)).digest('hex'));
  assert.notEqual(Auth.sign(input, token), Auth.sign({ ...input, size: 123 }, token));
});

test('recycling never sweeps unused recordings merely by opening a project', () => {
  const policy = Policy.createPolicy(normalize);
  assert.deepEqual(policy.observe([record], snapshot(), 1), []);
  assert.deepEqual(policy.observe([record], snapshot(), 999999), []);
});
test('last reference removal requires 30 seconds, undo resets the entire grace period', () => {
  const policy = Policy.createPolicy(normalize);
  policy.observe([record], snapshot(true), 1);
  assert.deepEqual(policy.observe([record], snapshot(), 100), []);
  assert.deepEqual(policy.observe([record], snapshot(), 30099), []);
  policy.observe([record], snapshot(true), 30100);
  assert.deepEqual(policy.observe([record], snapshot(), 60000), []);
  assert.deepEqual(policy.observe([record], snapshot(), 90000), [record]);
});
test('another item using the same media path protects the recording', () => {
  const policy = Policy.createPolicy(normalize);
  const shared = snapshot();
  shared.paths.add(normalize(target));
  policy.arm(record);
  policy.observe([record], snapshot(), 0);
  assert.deepEqual(policy.observe([record], shared, 30001), []);
});
test('incomplete scans reset the grace and cannot establish zero references', () => {
  const policy = Policy.createPolicy(normalize);
  policy.arm(record);
  policy.observe([record], snapshot(), 0);
  policy.observe([record], { complete: false }, 30000);
  assert.deepEqual(policy.observe([record], snapshot(), 40000), []);
});

function harness() {
  const files = new Map();
  const logs = [];
  const launched = [];
  const removed = [];
  const context = { identity: 'project', statePath: 'E:\\demo\\demo.voiceover-namer.json', project: { path: 'E:\\demo\\demo.prproj' } };
  let clock = 1;
  let view = snapshot(true);
  let valid = true;
  const stat = { size: 44, birthtimeMs: 100, mtimeMs: 100 };
  files.set(target, 'wave');
  const fs = {
    async lstat(path) { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return stat; },
    async readdir(path) { return [...files.keys()].filter(key => key.startsWith(path + '\\')).map(key => key.slice(path.length + 1)); },
    async readFile(path) { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path); },
    async writeFile(path, data, options) {
      if (options.flag === 'wx' && files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(path, data);
    },
  };
  const options = {
    fs, context, now: () => clock, randomSource: require('node:crypto').webcrypto,
    signature: value => String(value.size), hashFile: async () => ({ size: 44, digest: 'b'.repeat(64) }),
    ensureFolder: async path => files.set(path, 'directory'), validate: async () => { if (!valid) throw new Error('project changed'); },
    snapshot: async () => view, bridge: async () => ({ directory: 'E:\\bridge', token: 'c'.repeat(64) }),
    launch: async uri => launched.push(uri), removeItem: async entry => removed.push(entry), log: (level, message) => logs.push(message),
  };
  const controller = Recycler.create(options);
  const register = () => controller.register({ targetPath: target, recordingId: id }, { projectItemId: 'item', trackItems: [{}] });
  return { files, logs, launched, removed, controller, options, register,
    time: value => { clock = value; }, view: value => { view = value; }, valid: value => { valid = value; },
    job() {
      const uri = launched.at(-1);
      const jobId = uri.slice(uri.lastIndexOf('/') + 1);
      return { id: jobId, path: 'E:\\bridge\\' + jobId };
    },
    async ready() {
      await register();
      view = snapshot();
      await controller.tick();
      clock = 30001;
      await controller.tick();
      const job = this.job();
      files.set(job.path + '.ready.json', JSON.stringify({ id: job.id, token: 'c'.repeat(64) }));
      return job;
    },
  };
}
test('recycle controller waits for helper readiness and a final scan before commit', async () => {
  const h = harness();
  const job = await h.ready();
  assert.equal(h.files.has(job.path + '.commit.json'), false);
  assert.equal(h.removed.length, 0);
  await h.controller.tick();
  assert.equal(h.files.has(job.path + '.commit.json'), true);
  assert.equal([...h.files.keys()].some(path => path.endsWith('.issued')), true);
  assert.equal(h.removed.length, 0);
  h.view({ ...snapshot(), items: [{ id: 'item', path: target }] });
  h.files.delete(target);
  h.files.set(job.path + '.result.json', JSON.stringify({ id: job.id, status: 'recycled', token: 'c'.repeat(64) }));
  await h.controller.tick();
  assert.equal(h.removed.length, 1);
});
test('forged results or a surviving disk file cannot remove the Premiere item', async () => {
  for (const token of ['forged', 'c'.repeat(64)]) {
    const h = harness();
    const job = await h.ready();
    await h.controller.tick();
    h.files.set(job.path + '.result.json', JSON.stringify({ id: job.id, status: 'recycled', token }));
    await h.controller.tick();
    assert.equal(h.removed.length, 0);
    assert.match(h.logs.at(-1), /暂停/);
  }
});
test('undo while the helper prepares prevents commit and leaves the project item', async () => {
  const h = harness();
  const job = await h.ready();
  h.view(snapshot(true));
  await h.controller.tick();
  assert.equal(h.files.has(job.path + '.commit.json'), false);
  assert.equal(h.removed.length, 0);
});
test('project switching prevents the final commit', async () => {
  const h = harness();
  const job = await h.ready();
  h.valid(false);
  await h.controller.tick();
  assert.equal(h.files.has(job.path + '.commit.json'), false);
  assert.match(h.logs.at(-1), /暂停/);
});
test('relinked or duplicated project items cannot authorize removal of the disk file', async () => {
  const h = harness();
  const job = await h.ready();
  h.view({ ...snapshot(), items: [{ id: 'item', path: 'E:\\elsewhere.wav' }] });
  await h.controller.tick();
  assert.equal(h.files.has(job.path + '.commit.json'), false);
});
test('timed out committed requests are not replayed after reopening the project', async () => {
  const h = harness();
  await h.ready();
  await h.controller.tick();
  h.time(99999);
  await h.controller.tick();
  const reopened = Recycler.create(h.options);
  h.view(snapshot(true));
  await reopened.tick();
  h.view(snapshot());
  h.time(199999);
  await reopened.tick();
  assert.equal(h.launched.length, 1);
});
test('an uncertain commit write remains committed and refresh polls its result instead of replaying', async () => {
  const h = harness();
  const job = await h.ready();
  const original = h.options.fs.writeFile;
  h.options.fs.writeFile = async (path, value, options) => {
    await original(path, value, options);
    if (path.endsWith('.commit.json')) throw new Error('uncertain write');
  };
  await h.controller.tick();
  h.files.delete(target);
  h.files.set(job.path + '.result.json', JSON.stringify({ id: job.id, status: 'recycled', token: 'c'.repeat(64) }));
  h.controller.retry();
  await h.controller.tick();
  assert.equal(h.launched.length, 1);
  assert.match(h.logs.at(-1), /已移入系统回收站/);
});
test('registration write failure never authorizes automatic recycling', async () => {
  const h = harness();
  h.options.fs.writeFile = async () => { throw new Error('disk full'); };
  await assert.rejects(h.register(), /disk full/);
  h.view(snapshot());
  h.time(99999);
  await h.controller.tick();
  assert.equal(h.launched.length, 0);
});
test('foreign installation signatures are protected without blocking newly registered recordings', async () => {
  const h = harness();
  await h.register();
  h.options.bridge = async () => ({ directory: 'E:\\bridge', token: 'd'.repeat(64) });
  const next = Recycler.create(h.options);
  const newId = 'e'.repeat(32);
  const newPath = target.replace(id, newId);
  h.files.set(newPath, 'wave');
  await next.register({ recordingId: newId, targetPath: newPath }, { projectItemId: 'new', trackItems: [{}] });
  assert.equal([...h.files.keys()].filter(path => path.endsWith('.json')).length, 2);
  assert.match(h.logs.at(-1), /旧登记/);
});
test('registry does not use the 200-entry history as ownership evidence', async () => {
  const h = harness();
  for (let n = 0; n < 205; n++) {
    const key = n.toString(16).padStart(32, '0');
    const path = target.replace(id, key);
    h.files.set(path, 'wave');
    await h.controller.register({ targetPath: path, recordingId: key }, { projectItemId: `item-${n}`, trackItems: [{}] });
  }
  assert.equal([...h.files.keys()].filter(path => path.endsWith('.json')).length, 205);
});

function hostHarness() {
  const views = require('./helpers/premiere-item-views.js').createItemViews();
  const clip = views.register({ isSequence: async () => false, getMediaFilePath: async () => target }, 'clip');
  const track = { getTrackItems: async () => [{ getProjectItem: async () => views.base(clip) }] };
  const seq = { guid: 'seq', getAudioTrackCount: async () => 1, getVideoTrackCount: async () => 0, getAudioTrack: async () => track };
  const root = views.register({ getItems: async () => [views.base(clip)] }, 'root');
  const project = { getSequences: async () => [seq], getRootItem: async () => root };
  return { project, ppro: views.ppro, clip, seq, track, root, views };
}

test('recycle scan handles distinct root, nested folder and media wrappers', async () => {
  const h = hostHarness();
  const bin = h.views.register({ getItems: async () => [h.views.base(h.clip)] }, 'bin');
  h.root.getItems = async () => [h.views.base(bin)];
  assert.equal(typeof h.root.getId, 'undefined');
  assert.equal(typeof bin.getId, 'undefined');
  assert.equal(typeof h.clip.getId, 'undefined');
  const result = await Host.snapshot(h.project, h.ppro, normalize, async () => {});
  assert.equal(result.complete, true);
  assert.equal(result.paths.has(normalize(target)), true);
  assert.equal(result.ids.has('clip'), true);
  assert.equal(result.items[0].id, 'clip');
  assert.equal(result.items[0].raw, h.views.base(h.clip));
  assert.equal(result.items[0].parent, bin);
});
test('recycle traversal does not require a ProjectItem identity for the root container', async () => {
  for (const ProjectItem of [undefined, {}, { cast: () => null }, { cast: () => ({}) },
    { cast: () => { throw new Error('unsupported wrapper'); } }]) {
    const h = hostHarness();
    const bin = h.views.register({ getItems: async () => [h.views.base(h.clip)] }, 'bin');
    h.project.getRootItem = async () => ({ getItems: async () => [h.views.base(bin)] });
    h.ppro.ProjectItem = ProjectItem;
    const result = await Host.snapshot(h.project, h.ppro, normalize, async () => {});
    assert.equal(result.complete, true);
    assert.equal(result.ids.has('clip'), true);
    assert.equal(result.items[0].id, 'clip');
  }
});
test('unreadable child bin identity prevents recycling and identifies the bin', async () => {
  for (const getId of [undefined, () => '', () => { throw new Error('host busy'); }]) {
    const h = hostHarness();
    let reads = 0;
    const bin = h.views.register({ name: '旧录音', getItems: async () => { reads++; return []; } }, 'bin');
    h.views.base(bin).getId = getId;
    h.root.getItems = async () => [h.views.base(bin)];
    await assert.rejects(Host.snapshot(h.project, h.ppro, normalize, async () => {}), error => {
      assert.match(error.message, /素材身份不可读/);
      assert.match(error.message, /旧录音/);
      assert.match(error.message, /原因/);
      return true;
    });
    assert.equal(reads, 0);
  }
});
test('recycle scan preserves used references with safe numeric IDs', async () => {
  const h = hostHarness();
  h.views.base(h.clip).getId = () => 0;
  const result = await Host.snapshot(h.project, h.ppro, normalize, async () => {});
  assert.equal(result.ids.has('0'), true);
  assert.equal(result.items[0].id, '0');
  assert.equal(result.paths.has(normalize(target)), true);
});
test('invalid media identity cannot establish zero references for recycling', async () => {
  for (const id of [undefined, null, '', '   ', 'undefined', 'null', {}, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const h = hostHarness();
    h.views.base(h.clip).getId = () => id;
    await assert.rejects(Host.snapshot(h.project, h.ppro, normalize, async () => {}), /素材身份不可读/);
  }
});
test('duplicate bin identities and root cycles cannot produce a complete recycle scan', async () => {
  const h = hostHarness();
  const bin = h.views.register({ getItems: async () => [] }, 'bin');
  h.root.getItems = async () => [h.views.base(bin), h.views.base(bin)];
  await assert.rejects(Host.snapshot(h.project, h.ppro, normalize, async () => {}), /结构重复/);
  h.root.getItems = async () => [h.views.base(h.root)];
  await assert.rejects(Host.snapshot(h.project, h.ppro, normalize, async () => {}), /结构重复/);
});

test('recycle traversal accepts asynchronous folder and clip casts', async () => {
  const h = hostHarness();
  const folderCast = h.ppro.FolderItem.cast, clipCast = h.ppro.ClipProjectItem.cast;
  h.ppro.FolderItem = { cast: async raw => folderCast(raw) };
  h.ppro.ClipProjectItem = { cast: async raw => clipCast(raw) };
  assert.equal((await Host.snapshot(h.project, h.ppro, normalize, async () => {})).ids.has('clip'), true);
});
test('full-project scan follows nested sequences from project items and deduplicates cycles', async () => {
  const h = hostHarness();
  const nested = { ...h.seq, guid: 'nested' };
  const nestedItem = h.views.register({ isSequence: async () => true, getSequence: async () => nested }, 'nested-item');
  h.project.getSequences = async () => [];
  h.root.getItems = async () => [h.views.base(nestedItem)];
  const result = await Host.snapshot(h.project, h.ppro, normalize, async () => {});
  assert.equal(result.complete, true);
  assert.equal(result.paths.has(normalize(target)), true);
});
test('video track references are protected too', async () => {
  const h = hostHarness();
  h.seq.getAudioTrackCount = async () => 0;
  h.seq.getVideoTrackCount = async () => 1;
  h.seq.getVideoTrack = async () => h.track;
  const result = await Host.snapshot(h.project, h.ppro, normalize, async () => {});
  assert.equal(result.ids.has('clip'), true);
});
test('any track read failure aborts the full scan instead of reporting zero references', async () => {
  const h = hostHarness();
  h.track.getTrackItems = async () => { throw new Error('host busy'); };
  await assert.rejects(Host.snapshot(h.project, h.ppro, normalize, async () => {}), /host busy/);
});
test('unresolved and merged sources cannot hide dependencies from the recycle scan', async () => {
  const unresolved = hostHarness();
  unresolved.clip.getMediaFilePath = async () => '';
  await assert.rejects(Host.snapshot(unresolved.project, unresolved.ppro, normalize, async () => {}), /不可确认/);
  const merged = hostHarness();
  merged.clip.isMergedClip = async () => true;
  await assert.rejects(Host.snapshot(merged.project, merged.ppro, normalize, async () => {}), /合并素材/);
});
test('project item removal checks executeTransaction even when lockedAccess returns void', async () => {
  const project = { lockedAccess(callback) { callback(); }, executeTransaction() { return false; } };
  await assert.rejects(Host.removeUnusedItem(project, {}), /移除失败/);
  project.executeTransaction = callback => { callback({ addAction() {} }); return true; };
  await Host.removeUnusedItem(project, { parent: { createRemoveItemAction: () => ({}) }, raw: {} });
});
