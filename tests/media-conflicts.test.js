const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Conflicts = require('../src/media-conflicts.js');
const Rename = require('../src/media-rename.js');
const Panel = require('../src/media-panel.js');
const Core = require('../src/core.js');
const Policy = require('../src/monitoring-policy.js');
const { createItemViews } = require('./helpers/premiere-item-views.js');

let nextId = 0;
const views = createItemViews();
function clip(mediaPath, options = {}) {
  const item = {
    id: String(++nextId), name: path.basename(mediaPath), mediaPath,
    async getMediaFilePath() { return this.mediaPath; },
    async isSequence() { return false; },
    async isMergedClip() { return false; },
    async isMulticamClip() { return false; },
    async isOffline() { return false; },
    async canChangeMediaPath() { return true; },
    async hasProxy() { return false; },
    async refreshMedia() {},
    async changeMediaFilePath(p, override) { assert.equal(override, true); this.mediaPath = p; return true; },
    createSetNameAction(name) { return () => { this.name = name; }; },
    ...options,
  };
  return views.register(item, item.id);
}
function track(item, name = item.name) {
  return { name, async getName() { return this.name; }, async getProjectItem() { return views.base(item); },
    createSetNameAction(value) { return () => { this.name = value; }; } };
}
function folder(items) {
  return views.register({ async getItems() { return items.map(views.base); } }, String(++nextId));
}
function sequence(audio, video) {
  return { guid: 'seq-' + (++nextId),
    async getAudioTrackCount() { return audio.length; }, async getVideoTrackCount() { return video.length; },
    async getAudioTrack(n) { return { async getTrackItems() { return audio[n]; } }; },
    async getVideoTrack(n) { return { async getTrackItems() { return video[n]; } }; },
  };
}
function host(items, sequences = []) {
  const root = folder(items);
  return {
    project: { path: 'E:/测试/交接.prproj', async getRootItem() { return root; }, async getSequences() { return sequences; },
      lockedAccess(fn) { return fn(); },
      executeTransaction(fn) { const actions = []; fn({ addAction(action) { actions.push(action); } }); actions.forEach(action => action()); return true; } },
    ppro: { ...views.ppro },
  };
}
async function fixture(t, names = ['a/镜头.mp4', 'b/镜头.mp4']) {
  const root = path.resolve(__dirname, '../work');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'media-tests-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = [];
  for (const name of names) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'distinct-source-' + name);
    const time = new Date(Date.now() - 60000);
    await fs.utimes(file, time, time);
    files.push(file);
  }
  const items = files.map(file => clip(file));
  const timeline = items.map(item => track(item));
  const scene = host([folder(items)], [sequence([timeline], [])]);
  const opts = { ...scene, fs, randomSource: crypto, validate: async () => {}, delay: async () => {},
    // Node integration equivalent of UXP's no-overwrite move, without copying.
    move: async (from, to) => { await fs.link(from, to); await fs.unlink(from); } };
  return { dir, files, items, timeline, opts };
}
async function plansFor(opts) { return Conflicts.plan({ ...opts, snapshot: await Conflicts.snapshot(opts) }); }

// UXP lstat documents a subset of Node Stats. Omit unsupported link/identity
// fields instead of testing every host operation against a full Node object.
function uxpFileSystem() {
  return { ...fs, async lstat(file) {
    const stat = await fs.lstat(file);
    return {
      size: stat.size, mtime: stat.mtime, ctime: stat.ctime, birthtime: stat.birthtime,
      isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(),
    };
  } };
}

// exFAT/UXP may reassign directory-entry identity and creation time on every
// successful rename, including rollback. Keep real bytes on disk but model
// those observed host metadata changes instead of assuming NTFS hard links.
function exfatOptions(options, omitInode = false) {
  const identities = new Map();
  let generation = 0;
  return { ...options,
    fs: { ...fs, async lstat(file) {
      const stat = await fs.lstat(file), identity = identities.get(file) || {};
      const result = Object.assign(Object.create(stat), identity);
      if (omitInode) { result.ino = undefined; result.dev = undefined; }
      return result;
    } },
    move: async (from, to) => {
      await options.move(from, to);
      generation += 1;
      identities.delete(from);
      identities.set(to, { ino: 900000 + generation, birthtimeMs: Date.now() + generation, ctimeMs: Date.now() + generation });
    },
  };
}

test('exFAT changed inode and birthtime do not break rename or panel relinking', async t => {
  for (const omitInode of [false, true]) {
    const f = await fixture(t), opts = exfatOptions(f.opts, omitInode);
    const plan = (await plansFor(opts)).plans[0];
    const bytes = await fs.readFile(plan.sourcePath);
    const result = await Rename.execute({ ...opts, plan });
    assert.deepEqual(await fs.readFile(plan.targetPath), bytes);
    assert.equal(f.items[0].mediaPath, plan.targetPath);
    assert.equal(f.items[0].name, plan.targetName);
    assert.equal(result.fileProof.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.notEqual(result.fileProof.sourceSignature.birthtime, result.fileProof.movedSignature.birthtime);
    await assert.rejects(fs.lstat(plan.sourcePath), { code: 'ENOENT' });
  }
});

test('exFAT relink failure restores original file, media path and name despite another identity change', async t => {
  const f = await fixture(t), opts = exfatOptions(f.opts);
  const plan = (await plansFor(opts)).plans[0];
  const bytes = await fs.readFile(plan.sourcePath);
  f.items[0].changeMediaFilePath = async function (value) {
    if (value === plan.targetPath) throw new Error('host relink failed');
    this.mediaPath = value; return true;
  };
  await assert.rejects(Rename.execute({ ...opts, plan }), error => {
    assert.match(error.message, /host relink/);
    assert.deepEqual(error.rollbackWarnings, []);
    assert.equal(error.recoveryPath, plan.sourcePath);
    assert.ok(error.fileProof.restoredSignature);
    return true;
  });
  assert.deepEqual(await fs.readFile(plan.sourcePath), bytes);
  await assert.rejects(fs.lstat(plan.targetPath), { code: 'ENOENT' });
  assert.equal(f.items[0].mediaPath, plan.sourcePath);
  assert.equal(f.items[0].name, plan.entry.refs[0].name);
});

test('exFAT provider errors after forward and rollback moves still recover the original', async t => {
  const f = await fixture(t), opts = exfatOptions(f.opts, true);
  const plan = (await plansFor(opts)).plans[0], bytes = await fs.readFile(plan.sourcePath);
  await assert.rejects(Rename.execute({ ...opts, plan, move: async (from, to) => {
    await opts.move(from, to);
    throw new Error('provider response lost after move');
  } }), error => {
    assert.match(error.message, /provider response/);
    assert.deepEqual(error.rollbackWarnings, []);
    assert.equal(error.recoveryPath, plan.sourcePath);
    return true;
  });
  assert.deepEqual(await fs.readFile(plan.sourcePath), bytes);
  await assert.rejects(fs.lstat(plan.targetPath), { code: 'ENOENT' });
});

test('matching size and timestamps cannot authorize adopting different media content', async t => {
  const f = await fixture(t), opts = exfatOptions(f.opts);
  const plan = (await plansFor(opts)).plans[0], saved = path.join(f.dir, 'untouched-original.mp4');
  const bytes = await fs.readFile(plan.sourcePath);
  let moves = 0, relinks = 0;
  f.items[0].changeMediaFilePath = async () => { relinks += 1; return true; };
  const fakeStatFs = { ...opts.fs, async lstat(file) {
    const stat = await opts.fs.lstat(file);
    return file === plan.targetPath ? Object.assign(Object.create(stat), {
      size: plan.sourceSignature.size, mtimeMs: plan.sourceSignature.mtime,
      birthtimeMs: plan.sourceSignature.birthtime, ctimeMs: plan.sourceSignature.ctime,
      ino: plan.sourceSignature.ino, dev: plan.sourceSignature.dev,
    }) : stat;
  } };
  await assert.rejects(Rename.execute({ ...opts, fs: fakeStatFs, plan, move: async (from, to) => {
    moves += 1;
    await opts.move(from, to);
    await fs.rename(to, saved);
    await fs.writeFile(to, Buffer.alloc(bytes.length, 0x5a));
  } }), error => {
    assert.match(error.message, /内容验证失败/);
    assert.equal(error.needsRecovery, true);
    assert.equal(error.recoveryPath, '');
    assert.deepEqual(error.pathsToCheck, [plan.sourcePath, plan.targetPath]);
    return true;
  });
  assert.equal(moves, 1);
  assert.equal(relinks, 0);
  assert.deepEqual(await fs.readFile(saved), bytes);
  assert.deepEqual(await fs.readFile(plan.targetPath), Buffer.alloc(bytes.length, 0x5a));
});

test('changing the source during hashing or its host reference afterwards prevents disk mutation', async t => {
  for (const change of ['file', 'reference']) {
    const f = await fixture(t), plan = (await plansFor(f.opts)).plans[0];
    const original = await fs.readFile(plan.sourcePath);
    const changedFs = { ...fs, open: undefined, async readFile(file) {
      const bytes = await fs.readFile(file);
      if (change === 'file') await fs.writeFile(file, 'source changed while reading');
      else f.items[0].mediaPath = f.files[1];
      return bytes;
    } };
    await assert.rejects(Rename.execute({ ...f.opts, fs: changedFs, plan,
      move() { assert.fail('source/reference changed before rename'); },
    }), /变化/);
    await assert.rejects(fs.lstat(plan.targetPath), { code: 'ENOENT' });
    if (change === 'reference') assert.deepEqual(await fs.readFile(plan.sourcePath), original);
  }
});

test('manual media rejects large files before mutation if streaming reads are unavailable', async t => {
  const f = await fixture(t), plan = (await plansFor(f.opts)).plans[0];
  const limitedFs = { ...fs, open: undefined, readFile() { assert.fail('must not allocate the large file'); },
    async lstat(file) {
      const stat = await fs.lstat(file);
      return file === plan.sourcePath ? Object.assign(Object.create(stat), { size: 9 * 1024 * 1024 }) : stat;
    },
  };
  plan.sourceSignature = Conflicts.signature(await limitedFs.lstat(plan.sourcePath));
  await assert.rejects(Rename.execute({ ...f.opts, fs: limitedFs, plan,
    move() { assert.fail('no verified content'); },
  }), /分块校验能力/);
  assert.ok(await fs.lstat(plan.sourcePath));
});

test('a host edit during post-move hashing is not overwritten by relinking or name rollback', async t => {
  const f = await fixture(t), opts = exfatOptions(f.opts), plan = (await plansFor(opts)).plans[0];
  const bytes = await fs.readFile(plan.sourcePath);
  await assert.rejects(Rename.execute({ ...opts, plan, onStage(stage) {
    if (stage === 'verify-target') { f.items[0].mediaPath = f.files[1]; f.items[0].name = '用户刚改的名称'; }
  } }), error => {
    assert.match(error.message, /其他操作修改/);
    assert.ok(error.needsRecovery);
    assert.equal(error.recoveryPath, plan.sourcePath);
    return true;
  });
  assert.equal(f.items[0].mediaPath, f.files[1]);
  assert.equal(f.items[0].name, '用户刚改的名称');
  assert.deepEqual(await fs.readFile(plan.sourcePath), bytes);
  await assert.rejects(fs.lstat(plan.targetPath), { code: 'ENOENT' });
});

test('UXP Stats without isSymbolicLink supports ordinary directories through rename and relink', async t => {
  const f = await fixture(t);
  const opts = { ...f.opts, fs: uxpFileSystem() };
  const result = await plansFor(opts);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.plans.length, 2);
  const plan = result.plans[0];
  await Rename.execute({ ...opts, plan });
  assert.equal(f.items[0].name, plan.targetName);
  assert.equal(f.items[0].mediaPath, plan.targetPath);
  assert.ok(await fs.lstat(plan.targetPath));
  await assert.rejects(fs.lstat(plan.sourcePath), { code: 'ENOENT' });
});

test('UXP-style directory checks reject an actual junction without isSymbolicLink', async t => {
  const f = await fixture(t);
  const alias = path.join(f.dir, 'linked');
  await fs.symlink(path.join(f.dir, 'a'), alias, 'junction');
  await assert.rejects(Conflicts.inspectFile(uxpFileSystem(), path.join(alias, '镜头.mp4')), /目录不是普通文件夹/);
});

test('positive link metadata is rejected even when directory or file methods report a regular type', async t => {
  const f = await fixture(t), base = uxpFileSystem();
  for (const metadata of [{ isSymbolicLink: true }, { isSymbolicLink: () => true }, { mode: 0xa1ff }]) {
    const linkedDir = { ...base, async lstat(file) {
      const stat = await base.lstat(file);
      return file === path.dirname(f.files[0]) ? { ...stat, ...metadata } : stat;
    } };
    await assert.rejects(Conflicts.inspectFile(linkedDir, f.files[0]), /目录为链接/);
    const linkedFile = { ...base, async lstat(file) {
      const stat = await base.lstat(file);
      return file === f.files[0] ? { ...stat, ...metadata } : stat;
    } };
    await assert.rejects(Conflicts.inspectFile(linkedFile, f.files[0]), /不处理链接/);
  }
});

test('missing directory type and denied directory reads cannot authorize renaming', async t => {
  const f = await fixture(t), base = uxpFileSystem();
  for (const readParent of [() => ({}), () => ({ isDirectory: () => undefined }),
    () => { throw Object.assign(new Error('directory access denied'), { code: 'EACCES' }); }]) {
    const unknown = { ...base, async lstat(file) {
      if (file === path.dirname(f.files[0])) return readParent();
      return base.lstat(file);
    } };
    await assert.rejects(Conflicts.inspectFile(unknown, f.files[0]), /目录类型|普通文件夹|access denied/);
  }
  assert.ok(await fs.lstat(f.files[0]));
});

test('real UXP folder and clip wrappers scan through ProjectItem identities', async () => {
  const media = clip('E:/素材/镜头.mp4');
  const bin = folder([folder([media])]);
  const scene = host([bin], [sequence([], [[track(media)]])]);
  assert.equal(typeof bin.getId, 'undefined');
  assert.equal(typeof media.getId, 'undefined');
  const snap = await Conflicts.snapshot(scene);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].refs[0].id, views.base(media).getId());
  assert.equal(snap.entries[0].refs[0].tracks.length, 0);
});

test('project-panel scope never enters sequences or timeline-only graphics', async () => {
  const media = clip('E:/素材/镜头.mp4');
  const seqItem = clip('', { async isSequence() { return true; },
    async getSequence() { throw new Error('序列内容不在整理范围内'); } });
  const graphic = { async getProjectItem() { throw new Error('不应访问时间线图形'); } };
  const scene = host([folder([media, seqItem])], [sequence([], [[graphic]])]);
  scene.project.getSequences = async () => { throw new Error('不应枚举序列'); };
  const snap = await Conflicts.snapshot(scene);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].refs[0].tracks.length, 0);
  assert.equal(snap.folderCount, 2);
  assert.equal(snap.skippedSequenceCount, 1);
  assert.equal(snap.blockers.length, 0);
});

test('timeline-only sources are not project-panel rename candidates', async t => {
  const f = await fixture(t);
  const opts = { ...f.opts, ...host([f.items[0]], [sequence([], [[track(f.items[1])]])]) };
  const result = await plansFor(opts);
  assert.equal(result.fileCount, 1);
  assert.equal(result.groups, 0);
  assert.equal(result.plans.length, 0);
});

test('style project items alongside media are excluded without blocking the file scan', async t => {
  const f = await fixture(t);
  const styles = Array.from({ length: 6 }, (_, n) => views.register({ name: '文字样式 ' + n }, 'style-' + n, 'non-media'));
  const scene = host([styles[0], folder([...f.items, ...styles.slice(1)])]);
  scene.project.getSequences = async () => { throw new Error('只扫描项目面板'); };
  const opts = { ...f.opts, ...scene };
  const snap = await Conflicts.snapshot(opts);
  assert.equal(snap.entries.length, 2);
  assert.equal(snap.nonMediaItems.length, 6);
  assert.equal(snap.ignored, 6);
  assert.deepEqual(snap.blockers, []);
  const result = await Conflicts.plan({ ...opts, snapshot: snap });
  assert.equal(result.plans.length, 2);
  assert.equal(result.nonMediaItems.length, 6);
});

test('non-media classification uses the host cast, never the item display name', async t => {
  const f = await fixture(t, ['a/字幕样式.mp4', 'b/字幕样式.mp4']);
  const style = views.register({ name: '镜头.mp4' }, 'style', 'non-media');
  const opts = { ...f.opts, ...host([...f.items, style]) };
  for (const absent of [null, undefined]) {
    opts.ppro.ClipProjectItem = { cast: async raw => raw === views.base(style) ? absent : views.ppro.ClipProjectItem.cast(raw) };
    const plan = await plansFor(opts);
    assert.equal(plan.plans.length, 2);
    assert.deepEqual(plan.nonMediaItems.map(item => item.name), ['镜头.mp4']);
  }
});

test('throwing media casts and malformed clip views still fail instead of being skipped', async () => {
  for (const cast of [() => { throw new Error('host busy'); }, () => false, () => 0, () => ({})]) {
    const media = clip('E:/素材/镜头.mp4');
    const scene = host([media]);
    scene.ppro.ClipProjectItem = { cast };
    await assert.rejects(Conflicts.snapshot(scene), /host busy|宿主缺少/);
  }
});

test('a non-media item becoming another source reference invalidates the reviewed plan', async t => {
  const f = await fixture(t);
  const style = views.register({ name: '样式' }, 'style', 'non-media');
  const opts = { ...f.opts, ...host([...f.items, style]) };
  const plan = await plansFor(opts);
  const imported = clip(f.files[0], { name: '新素材引用' });
  opts.ppro.ClipProjectItem = { cast: raw => raw === views.base(style) ? imported : views.ppro.ClipProjectItem.cast(raw) };
  const fresh = await Conflicts.snapshot(opts);
  assert.throws(() => Conflicts.revalidatePlans(plan.plans, fresh), /重新扫描/);
});

test('root traversal and nested bins do not need reverse ProjectItem casts', async () => {
  for (const ProjectItem of [undefined, {}, { cast: () => null }, { cast: () => ({}) },
    { cast: () => { throw new Error('unsupported wrapper'); } }]) {
    const media = clip('E:/素材/镜头.mp4');
    const bin = folder([folder([media])]);
    const scene = host([bin]);
    // The root is a container, not a registered media ProjectItem.
    scene.project.getRootItem = async () => ({ getItems: async () => [views.base(bin)] });
    scene.ppro.ProjectItem = ProjectItem;
    const snap = await Conflicts.snapshot(scene);
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0].refs[0].id, views.base(media).getId());
  }
});

test('unreadable child bin identity aborts before reading its children with a useful location', async () => {
  for (const getId of [undefined, () => '', () => { throw new Error('host busy'); }]) {
    const bin = folder([]);
    bin.name = '片头素材';
    views.base(bin).getId = getId;
    const scene = host([bin]);
    let reads = 0;
    bin.getItems = async () => { reads++; return []; };
    await assert.rejects(Conflicts.snapshot(scene), error => {
      assert.match(error.message, /无法读取素材身份/);
      assert.match(error.message, /片头素材/);
      assert.match(error.message, /原因/);
      return true;
    });
    assert.equal(reads, 0);
  }
});

test('safe numeric media identities remain stable in the project panel', async () => {
  for (const id of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const media = clip('E:/素材/镜头.mp4');
    views.base(media).getId = () => id;
    const snap = await Conflicts.snapshot(host([media], [sequence([], [[track(media)]])]));
    assert.equal(snap.entries[0].refs.length, 1);
    assert.equal(snap.entries[0].refs[0].id, String(id));
    assert.equal(snap.entries[0].refs[0].tracks.length, 0);
  }
});

test('invalid media identity cannot silently omit a media reference', async () => {
  for (const id of [undefined, null, '', '   ', 'undefined', 'null', {}, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const media = clip('E:/素材/镜头.mp4');
    views.base(media).getId = () => id;
    await assert.rejects(Conflicts.snapshot(host([media])), /无法读取素材身份/);
  }
});

test('repeated bin identities and a root cycle abort the media scan', async () => {
  const bin = folder([]);
  await assert.rejects(Conflicts.snapshot(host([bin, bin])), /结构重复/);
  const scene = host([]), root = await scene.project.getRootItem();
  root.getItems = async () => [views.base(root)];
  await assert.rejects(Conflicts.snapshot(scene), /结构重复/);
});

test('media traversal accepts asynchronous folder and clip casts', async () => {
  const media = clip('E:/素材/镜头.mp4');
  const scene = host([folder([media])]);
  scene.ppro.FolderItem = { cast: async raw => views.ppro.FolderItem.cast(raw) };
  scene.ppro.ClipProjectItem = { cast: async raw => views.ppro.ClipProjectItem.cast(raw) };
  assert.equal((await Conflicts.snapshot(scene)).entries.length, 1);
});

test('scans all bins and unused media while excluding sequence contents', async t => {
  const f = await fixture(t, ['a/片段.mp4', 'b/片段.mp4', 'a/音乐.wav', 'b/音乐.wav', 'a/海报.png', 'b/海报.png']);
  const duplicateImport = clip(f.files[0]);
  const audio = track(f.items[2], '旁白片段');
  const video = track(f.items[0], '剪过的镜头');
  const nested = sequence([[audio]], [[video, track(duplicateImport)]]);
  const nestedItem = clip('', { async isSequence() { return true; }, async getSequence() { return nested; } });
  const outer = sequence([], [[track(nestedItem)]]);
  const scene = host([folder([...f.items, duplicateImport, nestedItem])], [outer, nested]);
  const snap = await Conflicts.snapshot({ ...f.opts, ...scene });
  assert.equal(snap.skippedSequenceCount, 1);
  assert.equal(snap.folderCount, 2);
  assert.equal(snap.entries.length, 6);
  const source = snap.entries.find(e => e.path === f.files[0]);
  assert.equal(source.refs.length, 2);
  assert.equal(source.refs.reduce((n, r) => n + r.tracks.length, 0), 0);
  const result = await Conflicts.plan({ ...f.opts, snapshot: snap });
  assert.equal(result.groups, 3);
  assert.equal(result.plans.length, 6);
  assert.equal(result.skipped.length, 0);
  for (const p of result.plans) assert.equal(path.dirname(p.targetPath), path.dirname(p.sourcePath));
});

test('same physical path referenced many times is not itself a duplicate', async t => {
  const f = await fixture(t, ['a/clip.mp4']);
  const second = clip(f.files[0]);
  const opts = { ...f.opts, ...host([f.items[0], second], [sequence([], [[track(second), ...f.timeline]])]) };
  assert.equal((await plansFor(opts)).plans.length, 0);
});

test('compares full names case-insensitively with Unicode normalization, preserves extension', async t => {
  const f = await fixture(t, ['a/镜头.MP4', 'b/镜头.mp4', 'c/镜头.mov', 'd/独有.mp3']);
  const result = await plansFor(f.opts);
  assert.equal(result.groups, 1);
  assert.equal(result.plans.length, 2);
  assert.ok(result.plans[0].targetName.endsWith('.MP4'));
  assert.equal(Conflicts.nameKey('cafe\u0301.png'), Conflicts.nameKey('café.png'));
});

test('general WAV naming cannot be mistaken for a recording or enrolled by native-name policy', async t => {
  const f = await fixture(t, ['a/音频 1.wav', 'b/音频 1.wav']);
  const p = (await plansFor(f.opts)).plans[0];
  assert.equal(Conflicts.isRenamedName(p.targetName), true);
  assert.equal(Core.isGlobalRecordingName(p.targetName), false);
  assert.equal(Policy.isNativeDefaultRecordingName(p.targetName), false);
  assert.equal(Core.parseManagedName(p.targetName), null);
});

test('offline, proxy sources and files used as another item’s proxy are protected', async t => {
  const f = await fixture(t, ['a/镜头.mp4', 'b/镜头.mp4', 'c/主素材.mov']);
  f.items[0].isOffline = async () => true;
  f.items[2].hasProxy = async () => true;
  f.items[2].getProxyPath = async () => f.files[1];
  const p = await plansFor(f.opts);
  assert.equal(p.plans.length, 0);
  assert.equal(p.skipped.length, 2);
  assert.match(p.skipped[1].reason, /代理/);
});

test('numbered images require explicit still metadata; sequences and layered PSDs are reported', async t => {
  const f = await fixture(t, ['a/IMG_0001.png', 'b/IMG_0001.png', 'a/设计.psd', 'b/设计.psd']);
  f.opts.ppro.Metadata = { async getXMPMetadata(item) { return item === views.base(f.items[0]) ? '<rdf:Description xmpDM:videoFrameRate="Still"/>' : '<xmpDM:videoFrameRate>25</xmpDM:videoFrameRate>'; } };
  const p = await plansFor(f.opts);
  assert.equal(p.plans.length, 1);
  assert.equal(p.skipped.length, 3);
  assert.match(p.skipped[0].reason, /图片序列/);
});

test('merged footage blocks the whole batch because underlying sources are not enumerable', async t => {
  const f = await fixture(t);
  f.items[0].isMergedClip = async () => true;
  const snap = await Conflicts.snapshot(f.opts);
  assert.equal(snap.blockers.length, 1);
  const p = await Conflicts.plan({ ...f.opts, snapshot: snap });
  assert.throws(() => Conflicts.revalidatePlans(p.plans, snap), /合并/);
});

test('incomplete project-panel scans fail instead of claiming no conflicts', async t => {
  const f = await fixture(t);
  f.opts.project.getRootItem = async () => ({ getItems: async () => null });
  await assert.rejects(Conflicts.snapshot(f.opts), /完整/);
});

test('project-panel name changes invalidate the reviewed preview', async t => {
  const f = await fixture(t);
  const p = await plansFor(f.opts);
  f.items[0].name = '用户新名称';
  const fresh = await Conflicts.snapshot(f.opts);
  assert.throws(() => Conflicts.revalidatePlans(p.plans, fresh), /重新扫描/);
});

test('timeline edits do not invalidate a project-panel-only preview', async t => {
  const f = await fixture(t);
  const p = await plansFor(f.opts);
  f.timeline[0].name = '用户剪辑别名';
  f.opts.project.getSequences = async () => { throw new Error('不应读取时间线'); };
  const fresh = await Conflicts.snapshot(f.opts);
  assert.equal(Conflicts.revalidatePlans(p.plans, fresh).length, p.plans.length);
});

test('sidecars, active writes, and directory aliases are kept untouched', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(path.dirname(f.files[0]), '镜头.xmp'), 'metadata');
  await fs.writeFile(f.files[1], 'still recording');
  const p = await plansFor(f.opts);
  assert.equal(p.plans.length, 0);
  assert.ok(p.skipped.some(s => /XMP/.test(s.reason)));
  assert.ok(p.skipped.some(s => /刚刚写入/.test(s.reason)));
  const alias = path.join(f.dir, 'linked');
  await fs.symlink(path.join(f.dir, 'a'), alias, 'junction');
  await assert.rejects(Conflicts.inspectFile(fs, path.join(alias, '镜头.mp4')), /目录为链接/);
});

test('permission errors inspecting target paths never mean the target is absent', async t => {
  const f = await fixture(t);
  const denied = { ...fs, async lstat(p) { if (p.includes('-素材_')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.lstat(p); } };
  const p = await plansFor({ ...f.opts, fs: denied });
  assert.equal(p.plans.length, 0);
  assert.equal(p.skipped.length, 2);
});

test('non-file URLs and relative paths cannot reach disk mutation', async () => {
  const noIO = { async lstat() { assert.fail('invalid paths must not be read'); } };
  await assert.rejects(Conflicts.inspectFile(noIO, 'preview.mp4'), /本地绝对路径/);
  await assert.rejects(Conflicts.inspectFile(noIO, 'synthetic://clip.mp4'), /本地绝对路径/);
});

test('renames a real file and every panel reference without rewriting timeline names', async t => {
  const f = await fixture(t);
  const extra = clip(f.files[0], { name: '素材自定义名' });
  const video = track(extra, '镜头剪辑');
  const scene = host([...f.items, extra], [sequence([f.timeline], [[video]])]);
  const opts = { ...f.opts, ...scene };
  opts.project.getSequences = async () => { throw new Error('不应读取时间线'); };
  const p = (await plansFor(opts)).plans[0];
  const bytes = await fs.readFile(p.sourcePath);
  await Rename.execute({ ...opts, plan: p });
  await assert.rejects(fs.lstat(p.sourcePath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(p.targetPath), bytes);
  for (const ref of p.entry.refs) {
    assert.equal(ref.item.mediaPath, p.targetPath);
    assert.equal(ref.item.name, p.targetName);
    assert.equal(ref.tracks.length, 0);
  }
  assert.equal(video.name, '镜头剪辑');
  assert.equal(f.timeline[0].name, '镜头.mp4');
});

test('bin-only media can be renamed without any timeline occurrence', async t => {
  const f = await fixture(t);
  f.opts.project.getSequences = async () => { throw new Error('不应读取时间线'); };
  const p = (await plansFor(f.opts)).plans[0];
  await Rename.execute({ ...f.opts, plan: p });
  assert.equal(f.items[0].name, p.targetName);
});

test('failure on a later reference restores disk, links and different original names', async t => {
  const f = await fixture(t);
  const extra = clip(f.files[0], { name: '别名', async changeMediaFilePath(p) { if (p.includes('-素材_')) return false; this.mediaPath = p; return true; } });
  const scene = host([...f.items, extra], [sequence([f.timeline], [[track(extra, '剪辑别名')]])]);
  const opts = { ...f.opts, ...scene };
  const p = (await plansFor(opts)).plans[0];
  await assert.rejects(Rename.execute({ ...opts, plan: p }), e => { assert.deepEqual(e.rollbackWarnings, []); return /重链接/.test(e.message); });
  assert.ok(await fs.lstat(p.sourcePath));
  await assert.rejects(fs.lstat(p.targetPath), { code: 'ENOENT' });
  for (const ref of p.entry.refs) {
    assert.equal(ref.item.mediaPath, p.sourcePath);
    assert.equal(ref.item.name, ref.name);
    for (const tr of ref.tracks) assert.equal(await tr.item.getName(), tr.name);
  }
});

test('project switch after rename rolls back the captured project and cancels further work', async t => {
  const f = await fixture(t);
  const p = (await plansFor(f.opts)).plans[0];
  let moved = false;
  await assert.rejects(Rename.execute({ ...f.opts, plan: p,
    move: async (from, to) => { await f.opts.move(from, to); moved = to === p.targetPath; },
    validate: async () => { if (moved) throw Object.assign(new Error('项目已切换'), { code: 'VOICEOVER_NAMER_CANCELLED' }); },
  }), e => { assert.equal(e.code, 'VOICEOVER_NAMER_CANCELLED'); assert.deepEqual(e.rollbackWarnings, []); return true; });
  assert.equal(f.items[0].mediaPath, p.sourcePath);
  assert.ok(await fs.lstat(p.sourcePath));
});

test('locked files, changed sources, and last-moment target collisions preserve original data', async t => {
  for (const mode of ['locked', 'changed', 'collision']) {
    const f = await fixture(t);
    const p = (await plansFor(f.opts)).plans[0];
    const before = await fs.readFile(p.sourcePath);
    if (mode === 'changed') await fs.writeFile(p.sourcePath, 'changed');
    const move = async (from, to) => {
      if (mode === 'locked') throw new Error('resource busy or locked');
      if (mode === 'collision') await fs.writeFile(to, 'unrelated-target');
      return f.opts.move(from, to);
    };
    await assert.rejects(Rename.execute({ ...f.opts, move, plan: p }));
    assert.deepEqual(await fs.readFile(p.sourcePath), mode === 'changed' ? Buffer.from('changed') : before);
    if (mode === 'collision') assert.equal(await fs.readFile(p.targetPath, 'utf8'), 'unrelated-target');
    assert.equal(f.items[0].mediaPath, p.sourcePath);
  }
});

test('rollback refuses to overwrite a newly occupied original filename', async t => {
  const f = await fixture(t);
  const p = (await plansFor(f.opts)).plans[0];
  const original = await fs.readFile(p.sourcePath);
  let first = true;
  f.items[0].changeMediaFilePath = async function (newPath) {
    if (first) { first = false; await fs.writeFile(p.sourcePath, 'new-user-file'); throw new Error('relink failed once'); }
    this.mediaPath = newPath; return true;
  };
  await assert.rejects(Rename.execute({ ...f.opts, plan: p }), e => {
    assert.ok(e.rollbackWarnings.length > 0); assert.equal(e.recoveryPath, p.targetPath); return true;
  });
  assert.equal(await fs.readFile(p.sourcePath, 'utf8'), 'new-user-file');
  assert.deepEqual(await fs.readFile(p.targetPath), original);
  assert.equal(f.items[0].mediaPath, p.targetPath);
});

test('UXP adapter uses documented moveTo with overwrite false and refuses cross-directory moves', async () => {
  const calls = [];
  const storage = { async getEntryWithUrl(url) {
    if (url.endsWith('/镜头.mp4')) return { isFile: true, async moveTo(folder, options) { calls.push(options); } };
    return { isFolder: true };
  } };
  await Rename.moveExclusive(storage, 'E:\\素材\\镜头.mp4', 'E:\\素材\\新名.mp4');
  assert.deepEqual(calls, [{ newName: '新名.mp4', overwrite: false }]);
  await assert.rejects(Rename.moveExclusive(storage, 'E:/a/a.mp4', 'E:/b/b.mp4'), /原文件夹/);
});

test('batch writes recovery plan before mutation and never registers ordinary media for recycling', async t => {
  const f = await fixture(t);
  const plans = (await plansFor(f.opts)).plans;
  const records = new Map(), results = [];
  const folder = { async createFile(name, options) {
    assert.equal(options.overwrite, false);
    assert.equal(records.has(name), false);
    let stored;
    return { nativePath: 'E:/命名记录/' + name, async write(text) { stored = text; records.set(name, JSON.parse(text)); }, async read() { return stored; } };
  } };
  const outcome = await Panel.executeBatch({ ...f.opts, plans,
    storage: { formats: { utf8: 'utf8' } }, createJournalFolder: async () => folder,
    progress() {}, cancelled() { return false; }, onResult(r) { results.push(r); },
    move: async (from, to) => {
      assert.ok([...records.keys()].some(k => k.endsWith('-计划.json')));
      const prepared = [...records.values()].find(r => r.kind === 'manual-media-rename-prepared' && r.source === from);
      assert.ok(prepared, 'content proof is durable before disk mutation');
      assert.equal(prepared.fileProof.sha256, crypto.createHash('sha256').update(await fs.readFile(from)).digest('hex'));
      await f.opts.move(from, to);
    },
    recycler: { register() { assert.fail('general media must never be enrolled'); } },
  });
  assert.equal(outcome.results.length, 2);
  assert.ok(results.every(r => r.status === 'completed'));
  assert.equal(records.size, 5);
  const record = [...records.values()][0];
  assert.equal(record.kind, 'manual-media-rename');
  assert.equal(record.scope, 'project-panel');
  assert.equal(record.files.length, 2);
});

test('cannot write recovery plan means no mutation; cancellation after first file leaves later files intact', async t => {
  const f = await fixture(t);
  const plans = (await plansFor(f.opts)).plans;
  const base = { ...f.opts, plans, storage: { formats: { utf8: 'utf8' } }, progress() {}, cancelled: () => false, onResult() {} };
  await assert.rejects(Panel.executeBatch({ ...base, createJournalFolder: async () => { throw new Error('journal denied'); } }), /journal denied/);
  assert.ok(await fs.lstat(plans[0].sourcePath));
  let stop = false;
  const result = await Panel.executeBatch({ ...base,
    createJournalFolder: async () => ({ async createFile() { let stored; return { nativePath: 'E:/日志.json', async write(value) { stored = value; }, async read() { return stored; } }; } }),
    onResult() { stop = true; }, cancelled: () => stop,
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.remaining, 1);
  assert.ok(await fs.lstat(plans[1].sourcePath));
});

test('failure to persist pre-move content proof stops the entire batch without renaming', async t => {
  const f = await fixture(t), plans = (await plansFor(f.opts)).plans;
  const result = await Panel.executeBatch({ ...uiOptions(f.opts, fakeDocument()), plans,
    progress() {}, cancelled: () => false,
    move() { assert.fail('no durable content proof'); },
    createJournalFolder: async () => ({ async createFile(name) {
      if (name.endsWith('-校验.json')) throw new Error('proof journal disk full');
      let stored; return { nativePath: 'E:/记录/' + name, async write(value) { stored = value; }, async read() { return stored; } };
    } }),
  });
  assert.equal(result.stopped, true);
  assert.equal(result.remaining, 1);
  assert.match(result.results[0].message, /proof journal/);
  for (const file of f.files) assert.ok(await fs.lstat(file));
});

test('registered recordings and hardlinked files are not reclassified as ordinary media', async t => {
  const f = await fixture(t);
  const p = await plansFor({ ...f.opts, protect: async p => p === f.files[0] ? '该录音已登记自动回收' : '' });
  assert.equal(p.plans.length, 1);
  assert.match(p.skipped[0].reason, /登记/);
  await fs.link(f.files[1], path.join(f.dir, 'hardlink.mp4'));
  await assert.rejects(Conflicts.inspectFile(fs, f.files[1]), /硬链接/);
});

test('a partial name transaction is rolled back including custom names on unused items', async t => {
  const f = await fixture(t);
  const extra = clip(f.files[0], { name: '素材自定义名' });
  const opts = { ...f.opts, ...host([...f.items, extra]) };
  const p = (await plansFor(opts)).plans[0];
  let fail = true;
  extra.createSetNameAction = function (name) {
    return () => { if (fail) { fail = false; throw new Error('name action failed'); } this.name = name; };
  };
  await assert.rejects(Rename.execute({ ...opts, plan: p }), e => { assert.deepEqual(e.rollbackWarnings, []); return /name action/.test(e.message); });
  assert.equal(extra.name, '素材自定义名');
  assert.equal(f.items[0].name, p.entry.refs[0].name);
  assert.ok(await fs.lstat(p.sourcePath));
});

test('a replaced target is never adopted and moved back as the original media', async t => {
  const f = await fixture(t);
  const p = (await plansFor(f.opts)).plans[0];
  const saved = path.join(f.dir, 'preserved-original.mp4');
  await assert.rejects(Rename.execute({ ...f.opts, plan: p, move: async (from, to) => {
    await f.opts.move(from, to);
    await fs.rename(to, saved);
    await fs.writeFile(to, 'unrelated replacement');
  } }), e => { assert.ok(e.rollbackWarnings.length > 0); return /身份/.test(e.message); });
  await assert.rejects(fs.lstat(p.sourcePath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(p.targetPath, 'utf8'), 'unrelated replacement');
  assert.ok(await fs.lstat(saved));
});

function fakeDocument() {
  class Element {
    constructor() { this.children = []; this.listeners = new Map(); this.disabled = false; this.hidden = false; this.open = false; }
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return (this.value || '') + this.children.map(c => c.textContent).join(''); }
    appendChild(child) { this.children.push(child); }
    addEventListener(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(fn); }
    removeEventListener(event, fn) { this.listeners.get(event)?.delete(fn); }
    click() { if (!this.disabled && !this.hidden) this.dispatch('click'); }
    dispatch(event) { this.listeners.get(event)?.forEach(fn => fn({ preventDefault() {} })); }
    uxpShowModal() { this.open = true; return new Promise(resolve => { this.resolve = resolve; }); }
    close(value) { this.open = false; this.resolve(value); }
  }
  const nodes = new Map();
  return { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }, createElement() { return new Element(); } };
}
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('panel state timeout'); await new Promise(setImmediate); }
}
function uiOptions(opts, doc, records = []) {
  return { ...opts, document: doc, storage: { formats: { utf8: 'utf8' } }, log() {}, onResult() {},
    createJournalFolder: async () => ({ async createFile(name) { let stored; return { nativePath: 'E:/记录/' + name, async write(value) { stored = value; records.push(JSON.parse(value)); }, async read() { return stored; } }; } }),
  };
}

test('panel previews full paths and cancelling does not rename or write a journal', async t => {
  const f = await fixture(t), doc = fakeDocument(), records = [];
  const running = Panel.run(uiOptions(f.opts, doc, records));
  await until(() => !doc.getElementById('confirmMediaButton').disabled);
  assert.ok(doc.getElementById('mediaPreview').textContent.includes(f.files[0]));
  assert.match(doc.getElementById('mediaDialogCount').textContent, /1 组同名.*可改 2/);
  assert.match(doc.getElementById('mediaScope').textContent, /项目面板 2 个素材箱中的 2 个文件/);
  doc.getElementById('cancelMediaButton').click();
  await running;
  assert.equal(records.length, 0);
  for (const p of f.files) assert.ok(await fs.lstat(p));
});

test('panel executes once despite repeated confirmation clicks and retains results until closed', async t => {
  const f = await fixture(t), doc = fakeDocument(), records = [];
  f.opts.project.getSequences = async () => { throw new Error('预览和执行均不应读取时间线'); };
  const running = Panel.run(uiOptions(f.opts, doc, records));
  await until(() => !doc.getElementById('confirmMediaButton').disabled);
  const button = doc.getElementById('confirmMediaButton');
  button.click(); button.dispatch('click');
  await until(() => doc.getElementById('cancelMediaButton').textContent === '完成');
  assert.equal(records.length, 5);
  assert.match(doc.getElementById('mediaDialogCount').textContent, /完成 2 个 · 未完成 0/);
  assert.equal(doc.getElementById('mediaDialog').open, true);
  doc.getElementById('cancelMediaButton').click();
  await running;
});

test('panel with incomplete recovery lists surviving paths and never advises saving or rescanning', async t => {
  const f = await fixture(t), doc = fakeDocument(), records = [];
  let moved = false;
  const opts = exfatOptions(f.opts);
  f.items[0].changeMediaFilePath = async () => { throw new Error('host relink refused'); };
  const running = Panel.run(uiOptions({ ...opts, move: async (from, to) => {
    if (moved) throw new Error('rollback locked');
    moved = true;
    await opts.move(from, to);
  } }, doc, records));
  await until(() => !doc.getElementById('confirmMediaButton').disabled);
  doc.getElementById('confirmMediaButton').click();
  await until(() => doc.getElementById('cancelMediaButton').textContent === '完成');
  const result = records.find(r => r.status === 'failed');
  assert.ok(result.needsRecovery);
  assert.equal(result.recoveryPath, result.target);
  const visible = doc.getElementById('mediaScope').textContent + doc.getElementById('mediaPreview').textContent;
  assert.match(visible, /暂勿保存或再次改名/);
  assert.doesNotMatch(visible, /请正常保存|可重新扫描/);
  assert.ok(visible.includes(result.target));
  assert.ok(await fs.lstat(f.files[1]));
  doc.getElementById('cancelMediaButton').click();
  await running;
});

test('panel with fully restored failures reports no completed rename and does not ask to save', async t => {
  const f = await fixture(t), doc = fakeDocument();
  const running = Panel.run(uiOptions({ ...f.opts, move: async () => { throw new Error('file locked'); } }, doc));
  await until(() => !doc.getElementById('confirmMediaButton').disabled);
  doc.getElementById('confirmMediaButton').click();
  await until(() => doc.getElementById('cancelMediaButton').textContent === '完成');
  assert.match(doc.getElementById('mediaScope').textContent, /没有完成改名，原文件已保留或恢复/);
  assert.doesNotMatch(doc.getElementById('mediaScope').textContent, /请正常保存/);
  doc.getElementById('cancelMediaButton').click();
  await running;
});

test('panel lists skipped style entries and still renames only actual media files', async t => {
  const f = await fixture(t), doc = fakeDocument(), records = [];
  const style = views.register({ name: '字幕样式' }, 'style', 'non-media');
  style.createSetNameAction = () => { assert.fail('must not mutate a style'); };
  const opts = { ...f.opts, ...host([style, folder(f.items)]) };
  const running = Panel.run(uiOptions(opts, doc, records));
  await until(() => !doc.getElementById('confirmMediaButton').disabled);
  assert.match(doc.getElementById('mediaScope').textContent, /非媒体条目 1 项/);
  assert.match(doc.getElementById('mediaPreview').textContent, /字幕样式.*非媒体项目条目/);
  doc.getElementById('confirmMediaButton').click();
  await until(() => doc.getElementById('cancelMediaButton').textContent === '完成');
  assert.match(doc.getElementById('mediaDialogCount').textContent, /完成 2 个 · 未完成 0/);
  assert.equal(style.name, '字幕样式');
  assert.equal(records[0].files.length, 2);
  doc.getElementById('cancelMediaButton').click();
  await running;
});

test('panel stop finishes the current transaction and does not start the next file', async t => {
  const f = await fixture(t), doc = fakeDocument();
  let release, started = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const opts = uiOptions({ ...f.opts, move: async (from, to) => { started = true; await barrier; await f.opts.move(from, to); } }, doc);
  const running = Panel.run(opts);
  await until(() => !doc.getElementById('confirmMediaButton').disabled);
  doc.getElementById('confirmMediaButton').click();
  await until(() => started);
  doc.getElementById('cancelMediaButton').click();
  assert.equal(doc.getElementById('mediaDialog').open, true);
  release();
  await until(() => doc.getElementById('cancelMediaButton').textContent === '完成');
  assert.match(doc.getElementById('mediaDialogCount').textContent, /完成 1 个 · 未完成 1/);
  assert.ok(await fs.lstat(f.files[1]));
  doc.getElementById('cancelMediaButton').click();
  await running;
});

test('panel displays incomplete-scan errors and never enables apply', async t => {
  const f = await fixture(t), doc = fakeDocument();
  f.opts.project.getRootItem = async () => { throw new Error('无法读取素材箱'); };
  const running = Panel.run(uiOptions(f.opts, doc));
  await until(() => doc.getElementById('mediaDialogCount').textContent.includes('扫描未完成'));
  assert.equal(doc.getElementById('confirmMediaButton').disabled, true);
  assert.match(doc.getElementById('mediaPreview').textContent, /无法读取素材箱/);
  doc.getElementById('cancelMediaButton').click();
  await running;
});

test('corrupted journal readback prevents media mutation, result-write failure stops the next file', async t => {
  const f = await fixture(t);
  const plans = (await plansFor(f.opts)).plans;
  let resultEvent;
  const base = { ...f.opts, plans, storage: { formats: { utf8: 'utf8' } }, progress() {}, cancelled: () => false, onResult(r) { resultEvent = r; } };
  await assert.rejects(Panel.executeBatch({ ...base, createJournalFolder: async () => ({
    async createFile() { return { async write() {}, async read() { return 'truncated'; } }; },
  }) }), /校验失败/);
  assert.ok(await fs.lstat(plans[0].sourcePath));
  const outcome = await Panel.executeBatch({ ...base, createJournalFolder: async () => ({
    async createFile(name) {
      if (name.endsWith('-结果.json')) throw new Error('disk full');
      let stored; return { nativePath: 'E:/计划.json', async write(text) { stored = text; }, async read() { return stored; } };
    },
  }) });
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.results.length, 1);
  assert.match(resultEvent.journalWarning, /disk full/);
  assert.ok(await fs.lstat(plans[1].sourcePath));
});

test('failure to open the host dialog removes handlers so a retry cannot duplicate work', async t => {
  const f = await fixture(t), doc = fakeDocument();
  doc.getElementById('mediaDialog').uxpShowModal = () => { throw new Error('dialog unavailable'); };
  await assert.rejects(Panel.run(uiOptions(f.opts, doc)), /dialog unavailable/);
  assert.equal(doc.getElementById('confirmMediaButton').listeners.get('click').size, 0);
  assert.equal(doc.getElementById('cancelMediaButton').listeners.get('click').size, 0);
});
