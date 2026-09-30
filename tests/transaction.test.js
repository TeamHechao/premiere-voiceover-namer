const test = require('node:test');
const assert = require('node:assert/strict');

const sha256 = require('../src/sha256.js');
const transaction = require('../src/transaction.js');

test('shared relink refreshes with override and waits for an explicitly online matching path', async () => {
  const events = [];
  let current = 'old.mp4', reads = 0;
  const item = {
    async getMediaFilePath() { return current; },
    async changeMediaFilePath(value, override) { events.push(['link', value, override]); current = value; return true; },
    async refreshMedia() { events.push(['refresh']); },
    async isOffline() { reads += 1; return reads < 3 ? undefined : false; },
  };
  await transaction.relinkMedia({ projectItem: item, targetPath: 'new.mp4', samePath: (a, b) => a === b,
    delay: async () => { events.push(['wait']); },
  });
  assert.deepEqual(events, [['link', 'new.mp4', true], ['refresh'], ['wait'], ['wait']]);
});

function makeFs(initialPaths, options = {}) {
  const files = new Set(initialPaths);
  const contents = new Map(initialPaths.map((nativePath, index) => [
    nativePath,
    Buffer.alloc(128, 0x40 + index),
  ]));
  const renames = [];
  const copies = [];
  const unlinks = [];
  const contentFor = (nativePath) => {
    if (contents.has(nativePath)) return contents.get(nativePath);
    const fallback = Buffer.alloc(128, 0x5a);
    contents.set(nativePath, fallback);
    return fallback;
  };
  return {
    files,
    contents,
    renames,
    copies,
    unlinks,
    constants: { COPYFILE_EXCL: 1 },
    async lstat(path) {
      if (!files.has(path)) {
        const error = new Error('missing: ' + path);
        error.code = 'ENOENT';
        throw error;
      }
      const custom = options.statForPath ? options.statForPath(path, files) : null;
      return {
        path,
        size: contentFor(path).byteLength,
        mtimeMs: 1000,
        birthtimeMs: 900,
        ctimeMs: 1000,
        ino: 'source-file',
        ...(custom || {}),
      };
    },
    async rename(source, target) {
      renames.push([source, target]);
      const renameError = options.renameError && options.renameError(source, target, files);
      if (renameError) throw renameError instanceof Error ? renameError : new Error('rename failed');
      if (options.renameResult !== undefined) return options.renameResult;
      if (!files.has(source)) throw new Error('missing source');
      if (files.has(target)) throw new Error('target exists');
      files.delete(source);
      files.add(target);
      const sourceContents = contentFor(source);
      contents.delete(source);
      contents.set(target, sourceContents);
      if (options.afterRename) options.afterRename(source, target, files, contents);
      return 0;
    },
    async copyFile(source, target, flags) {
      copies.push([source, target, flags]);
      if (options.beforeCopy) options.beforeCopy(source, target, files, contents);
      const copyError = options.copyError && options.copyError(source, target, files);
      if (copyError) {
        if (options.leavePartialCopy) {
          files.add(target);
          contents.set(target, Buffer.from(contentFor(source).subarray(0, 32)));
        }
        throw copyError instanceof Error ? copyError : new Error('copy failed');
      }
      if (!files.has(source)) throw new Error('missing source');
      if (files.has(target) && flags === 1) {
        const error = new Error('target exists');
        error.code = 'EEXIST';
        throw error;
      }
      files.add(target);
      contents.set(target, Buffer.from(contentFor(source)));
      if (options.afterCopy) options.afterCopy(source, target, files, contents);
      return 0;
    },
    async readFile(path) {
      if (!files.has(path)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      const bytes = contentFor(path);
      return Uint8Array.from(bytes).buffer;
    },
    async unlink(path) {
      unlinks.push(path);
      const unlinkError = options.unlinkError && options.unlinkError(path, unlinks.length, files);
      if (unlinkError) throw unlinkError instanceof Error ? unlinkError : new Error('unlink failed');
      if (!files.has(path)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      files.delete(path);
      contents.delete(path);
      if (options.afterUnlink) options.afterUnlink(path, files, contents);
      return 0;
    },
  };
}

function makePremiere(options = {}) {
  const targetName = '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav';
  const trackOriginalNames = options.trackOriginalNames || ['音频 2_1.wav'];
  const trackItems = trackOriginalNames.map((originalName, index) => ({
    name: originalName,
    getNameCalls: 0,
    nameActionCalls: [],
    async getName() {
      this.getNameCalls += 1;
      if (options.trackGetNameError && options.trackGetNameError(this, index, this.getNameCalls)) {
        throw new Error('track name read failed');
      }
      return this.name;
    },
    createSetNameAction(name) {
      this.nameActionCalls.push(name);
      if (options.trackCreateNameActionError && options.trackCreateNameActionError(this, name, index)) {
        throw new Error('track name action failed');
      }
      return () => {
        if (options.transactionResult === false) return true;
        if (options.trackNameAction) return options.trackNameAction(this, name, index);
        this.name = name;
        return true;
      };
    },
  }));
  if (options.missingTrackNameApi) delete trackItems[options.missingTrackNameApiIndex || 0].createSetNameAction;

  const item = {
    name: options.originalName || '原始素材名',
    mediaPath: options.mediaPath || 'C:\\Captures\\source.wav',
    changeCalls: [],
    refreshCount: 0,
    async canChangeMediaPath() {
      return options.canChange !== false;
    },
    async changeMediaFilePath(path) {
      this.changeCalls.push(path);
      if (options.changeError && options.changeError(path, this.changeCalls.length)) throw new Error('relink failed');
      if (options.changeResult && options.changeResult(path, this.changeCalls.length) === false) return false;
      this.mediaPath = path;
      if (options.afterMediaPathChange) options.afterMediaPathChange(path, this.changeCalls.length);
      return true;
    },
    async refreshMedia() {
      this.refreshCount += 1;
    },
    async getMediaFilePath() {
      return this.mediaPath;
    },
    async isOffline() {
      return options.offline === true;
    },
    createSetNameAction(name) {
      return () => {
        if (options.transactionResult === false) return true;
        if (options.nameAction) return options.nameAction(this, name);
        this.name = name;
        return true;
      };
    },
  };
  const project = {
    transactionCount: 0,
    actionsPerTransaction: [],
    lockedAccess(callback) {
      return callback();
    },
    executeTransaction(callback) {
      this.transactionCount += 1;
      let actionCount = 0;
      const compoundAction = {
        addAction: (action) => {
          actionCount += 1;
          return action();
        },
      };
      try {
        callback(compoundAction);
      } finally {
        this.actionsPerTransaction.push(actionCount);
      }
      return options.transactionResult === undefined ? true : options.transactionResult;
    },
  };
  return { project, item, trackItems, targetName };
}

const paths = {
  source: 'C:\\Captures\\source.wav',
  target: 'C:\\Captures\\renamed.wav',
};

const crossPaths = {
  source: 'C:\\Captures\\source.wav',
  target: 'E:\\剪辑工程\\Adobe Premiere Pro Captured and Generated\\项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
};

const commonOptions = (fs, premiere, extra = {}) => ({
  fs,
  project: premiere.project,
  projectItem: premiere.item,
  trackItems: premiere.trackItems,
  sourcePath: paths.source,
  targetPath: paths.target,
  targetName: '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
  samePath: (left, right) => left.toLowerCase().replaceAll('\\', '/') === right.toLowerCase().replaceAll('\\', '/'),
  delay: async () => {},
  ...extra,
});

const commonNameOptions = (premiere, extra = {}) => ({
  project: premiere.project,
  projectItem: premiere.item,
  trackItems: premiere.trackItems,
  targetName: premiere.targetName,
  expectedMediaPath: paths.source,
  samePath: (left, right) => left.toLowerCase().replaceAll('\\', '/') === right.toLowerCase().replaceAll('\\', '/'),
  delay: async () => {},
  ...extra,
});

const crossVolumeOptions = (fs, premiere, extra = {}) => commonOptions(fs, premiere, {
  sourcePath: crossPaths.source,
  targetPath: crossPaths.target,
  ...extra,
});

test('exists reports filesystem presence without leaking lstat errors', async () => {
  const fs = makeFs(['present.wav']);
  assert.equal(await transaction.exists(fs, 'present.wav'), true);
  assert.equal(await transaction.exists(fs, 'missing.wav'), false);
});

test('target conflict detection recognizes direct and wrapped filesystem errors', () => {
  assert.equal(transaction.isTargetConflict(new Error('目标文件已存在')), true);
  assert.equal(transaction.isTargetConflict(Object.assign(new Error('rename failed'), { code: 'EEXIST' })), true);
  assert.equal(transaction.isTargetConflict(new Error('File already exists')), true);
  assert.equal(transaction.isTargetConflict(Object.assign(new Error('wrapped'), {
    cause: Object.assign(new Error('native failure'), { code: 'EEXIST' }),
  })), true);
  assert.equal(transaction.isTargetConflict(Object.assign(new Error('locked'), { code: 'EBUSY' })), false);
});

test('renameAndRelink succeeds and synchronizes the media item and every timeline clip name', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ trackOriginalNames: ['片段甲', '片段乙'] });
  const result = await transaction.renameAndRelink(commonOptions(fs, premiere));
  assert.deepEqual(result, {
    sourcePath: paths.source,
    targetPath: paths.target,
    targetName: '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
    originalName: '原始素材名',
    transferMode: 'renamed',
    sourceRetained: false,
    cleanupWarning: '',
  });
  assert.equal(fs.files.has(paths.source), false);
  assert.equal(fs.files.has(paths.target), true);
  assert.equal(premiere.item.mediaPath, paths.target);
  assert.equal(premiere.item.name, result.targetName);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [result.targetName, result.targetName]);
  assert.deepEqual(premiere.item.changeCalls, [paths.target]);
  assert.equal(premiere.item.refreshCount, 1);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3]);
});

test('cross-volume transfer copies exclusively to the final project path and deletes the verified source last', async () => {
  const fs = makeFs([crossPaths.source]);
  const premiere = makePremiere({ mediaPath: crossPaths.source, trackOriginalNames: ['片段甲', '片段乙'] });

  const result = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere));

  assert.equal(result.transferMode, 'copied');
  assert.equal(result.sourceRetained, false);
  assert.equal(result.cleanupWarning, '');
  assert.equal(fs.files.has(crossPaths.source), false);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.equal(fs.copies.length, 1);
  assert.deepEqual(fs.copies[0], [crossPaths.source, crossPaths.target, 1]);
  assert.equal(fs.renames.length, 1);
  assert.equal(fs.renames[0][0], crossPaths.source);
  assert.match(fs.renames[0][1], /\.voiceover-namer-cleanup-/);
  assert.deepEqual(fs.unlinks, [fs.renames[0][1]]);
  assert.equal(premiere.item.mediaPath, crossPaths.target);
  assert.equal(premiere.item.name, premiere.targetName);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [premiere.targetName, premiere.targetName]);
});

test('cross-volume content verification supports UXP numeric file descriptors', async () => {
  const fs = makeFs([crossPaths.source]);
  const descriptors = new Map();
  let nextDescriptor = 10;
  let closeCalls = 0;
  delete fs.readFile;
  fs.open = async (nativePath) => {
    if (!fs.files.has(nativePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const descriptor = nextDescriptor++;
    descriptors.set(descriptor, { nativePath, position: 0 });
    return descriptor;
  };
  fs.read = async (descriptor, arrayBuffer, offset, length, position) => {
    const state = descriptors.get(descriptor);
    if (!state) throw new Error('invalid descriptor');
    const bytes = fs.contents.get(state.nativePath);
    const start = position >= 0 ? position : state.position;
    const count = Math.min(length, Math.max(0, bytes.byteLength - start));
    new Uint8Array(arrayBuffer).set(bytes.subarray(start, start + count), offset);
    if (position < 0) state.position += count;
    return { bytesRead: count, buffer: arrayBuffer };
  };
  fs.close = async (descriptor) => {
    if (!descriptors.delete(descriptor)) throw new Error('invalid descriptor');
    closeCalls += 1;
    return 0;
  };
  const premiere = makePremiere({ mediaPath: crossPaths.source });

  const result = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere));

  assert.equal(result.transferMode, 'copied');
  assert.equal(result.sourceRetained, false);
  assert.equal(closeCalls, 4);
  assert.equal(descriptors.size, 0);
  assert.equal(fs.files.has(crossPaths.target), true);
});

test('numeric read failures still close the UXP file descriptor', async () => {
  const fs = makeFs([crossPaths.source]);
  let descriptorOpen = false;
  let closeCalls = 0;
  delete fs.readFile;
  fs.open = async () => {
    descriptorOpen = true;
    return 10;
  };
  fs.read = async () => {
    throw Object.assign(new Error('read failed'), { code: 'EIO' });
  };
  fs.close = async () => {
    descriptorOpen = false;
    closeCalls += 1;
    return 0;
  };
  const premiere = makePremiere({ mediaPath: crossPaths.source });

  await assert.rejects(
    transaction.renameAndRelink(crossVolumeOptions(fs, premiere)),
    /跨盘复制校验失败：源文件无法读取：read failed/,
  );

  assert.equal(closeCalls, 1);
  assert.equal(descriptorOpen, false);
  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
});

test('SHA-256 initialization fails before a UXP file descriptor is opened', async () => {
  const fs = makeFs([crossPaths.source]);
  let openCalls = 0;
  delete fs.readFile;
  fs.open = async () => {
    openCalls += 1;
    return 10;
  };
  fs.read = async () => ({ bytesRead: 0, buffer: new ArrayBuffer(0) });
  fs.close = async () => 0;
  const premiere = makePremiere({ mediaPath: crossPaths.source });
  const originalCreateHasher = sha256.createHasher;
  sha256.createHasher = () => {
    throw new Error('hasher unavailable');
  };

  try {
    await assert.rejects(
      transaction.renameAndRelink(crossVolumeOptions(fs, premiere)),
      /跨盘复制校验失败：源文件无法读取：hasher unavailable/,
    );
  } finally {
    sha256.createHasher = originalCreateHasher;
  }

  assert.equal(openCalls, 0);
  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
});

test('cross-volume copy failure preserves an uncertain partial target and leaves Premiere on the source', async () => {
  const fs = makeFs([crossPaths.source], {
    copyError: () => Object.assign(new Error('copy interrupted'), { code: 'EIO' }),
    leavePartialCopy: true,
  });
  const premiere = makePremiere({ mediaPath: crossPaths.source });

  const error = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.code, 'EIO');
  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('已保留')));
  assert.deepEqual(fs.unlinks, []);
  assert.equal(premiere.item.mediaPath, crossPaths.source);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('cross-volume size mismatch fails before relinking and preserves both files for recovery', async () => {
  const fs = makeFs([crossPaths.source], {
    statForPath: (nativePath) => nativePath === crossPaths.target ? { size: 64 } : null,
  });
  const premiere = makePremiere({ mediaPath: crossPaths.source });

  await assert.rejects(
    transaction.renameAndRelink(crossVolumeOptions(fs, premiere)),
    (error) => /最终文件大小不一致/.test(error.message)
      && error.rollbackWarnings.some((warning) => warning.includes('已保留')),
  );

  assert.deepEqual([...fs.files].sort(), [crossPaths.source, crossPaths.target].sort());
  assert.deepEqual(fs.unlinks, []);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('a target appearing during cross-volume copy is never overwritten', async () => {
  const externalContents = Buffer.alloc(128, 0xee);
  const fs = makeFs([crossPaths.source], {
    beforeCopy: (_source, target, files, contents) => {
      files.add(crossPaths.target);
      contents.set(crossPaths.target, externalContents);
    },
  });
  const premiere = makePremiere({ mediaPath: crossPaths.source });

  const error = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(transaction.isTargetConflict(error), true);
  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.deepEqual(fs.contents.get(crossPaths.target), externalContents);
  assert.deepEqual(fs.unlinks, []);
  assert.equal(premiere.item.mediaPath, crossPaths.source);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('cross-volume relink failure keeps both files and restores Premiere to the source', async () => {
  const fs = makeFs([crossPaths.source]);
  const premiere = makePremiere({
    mediaPath: crossPaths.source,
    changeResult: (path) => path !== crossPaths.target,
  });

  await assert.rejects(
    transaction.renameAndRelink(crossVolumeOptions(fs, premiere)),
    (error) => error.message === 'Premiere 重链接返回失败'
      && error.rollbackWarnings.some((warning) => warning.includes('事务副本已保留')),
  );

  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.deepEqual(fs.unlinks, []);
  assert.equal(premiere.item.mediaPath, crossPaths.source);
  assert.equal(premiere.item.name, '原始素材名');
});

test('source cleanup failure keeps both copies but leaves Premiere safely linked to the project copy', async () => {
  const fs = makeFs([crossPaths.source], {
    renameError: (source, target) => source === crossPaths.source && target.includes('.voiceover-namer-cleanup-')
      ? Object.assign(new Error('source locked'), { code: 'EBUSY' })
      : null,
  });
  const premiere = makePremiere({ mediaPath: crossPaths.source, trackOriginalNames: ['片段甲', '片段乙'] });

  const result = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere));

  assert.equal(result.transferMode, 'copied');
  assert.equal(result.sourceRetained, true);
  assert.match(result.cleanupWarning, /原始采集文件暂未删除/);
  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.equal(fs.renames.filter((entry) => entry[0] === crossPaths.source).length, 4);
  assert.deepEqual(fs.unlinks, []);
  assert.equal(premiere.item.mediaPath, crossPaths.target);
  assert.equal(premiere.item.name, premiere.targetName);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [premiere.targetName, premiere.targetName]);
});

test('same-size target corruption is detected by content hash before Premiere relinks', async () => {
  const fs = makeFs([crossPaths.source], {
    afterCopy: (_source, target, _files, contents) => {
      contents.set(target, Buffer.alloc(128, 0xee));
    },
  });
  const premiere = makePremiere({ mediaPath: crossPaths.source });

  const error = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.match(error.message, /目标文件内容与已验证副本不一致/);
  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.deepEqual(fs.unlinks, []);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('a target replaced after relinking is detected before source cleanup', async () => {
  const fs = makeFs([crossPaths.source]);
  const premiere = makePremiere({
    mediaPath: crossPaths.source,
    afterMediaPathChange: (nativePath) => {
      if (nativePath === crossPaths.target) fs.contents.set(crossPaths.target, Buffer.alloc(128, 0xee));
    },
  });

  const result = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere));

  assert.equal(result.sourceRetained, true);
  assert.match(result.cleanupWarning, /工程目录副本.*内容.*不一致/);
  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.deepEqual(fs.unlinks, []);
});

test('rollback never deletes a target that was externally replaced', async () => {
  const fs = makeFs([crossPaths.source]);
  const premiere = makePremiere({
    mediaPath: crossPaths.source,
    changeResult: (nativePath) => {
      if (nativePath === crossPaths.target) {
        fs.contents.set(crossPaths.target, Buffer.alloc(128, 0xee));
        return false;
      }
      return true;
    },
  });

  const error = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 重链接返回失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('已保留')));
  assert.equal(fs.files.has(crossPaths.source), true);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.deepEqual(fs.unlinks, []);
  assert.equal(premiere.item.mediaPath, crossPaths.source);
});

test('a context switch during source cleanup preserves the quarantined source', async () => {
  const fs = makeFs([crossPaths.source]);
  const premiere = makePremiere({ mediaPath: crossPaths.source });
  let validationCalls = 0;

  const result = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 9) throw Object.assign(new Error('项目已切换'), { code: 'VOICEOVER_NAMER_CANCELLED' });
      return true;
    },
  }));

  const quarantinePath = [...fs.files].find((nativePath) => nativePath.includes('.voiceover-namer-cleanup-'));
  assert.equal(validationCalls, 9);
  assert.equal(result.sourceRetained, true);
  assert.match(result.cleanupWarning, /项目或序列.*最终清理前发生切换/);
  assert.equal(fs.files.has(crossPaths.source), false);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.ok(quarantinePath);
  assert.deepEqual(fs.unlinks, []);
});

test('a source missing before cleanup is reported instead of claimed as plugin deletion', async () => {
  const fs = makeFs([crossPaths.source]);
  const premiere = makePremiere({
    mediaPath: crossPaths.source,
    afterMediaPathChange: (nativePath) => {
      if (nativePath !== crossPaths.target) return;
      fs.files.delete(crossPaths.source);
      fs.contents.delete(crossPaths.source);
    },
  });

  const result = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere));

  assert.equal(result.sourceRetained, false);
  assert.match(result.cleanupWarning, /清理前已经不存在/);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.deepEqual(fs.unlinks, []);
});

test('a same-size source replacement is quarantined and never deleted', async () => {
  const fs = makeFs([crossPaths.source]);
  const replacement = Buffer.alloc(128, 0xee);
  const premiere = makePremiere({
    mediaPath: crossPaths.source,
    afterMediaPathChange: (nativePath) => {
      if (nativePath === crossPaths.target) fs.contents.set(crossPaths.source, replacement);
    },
  });

  const result = await transaction.renameAndRelink(crossVolumeOptions(fs, premiere));

  const quarantinePath = [...fs.files].find((nativePath) => nativePath.includes('.voiceover-namer-cleanup-'));
  assert.equal(result.sourceRetained, true);
  assert.match(result.cleanupWarning, /原始采集路径已被替换/);
  assert.equal(fs.files.has(crossPaths.source), false);
  assert.equal(fs.files.has(crossPaths.target), true);
  assert.ok(quarantinePath);
  assert.deepEqual(fs.contents.get(quarantinePath), replacement);
  assert.deepEqual(fs.unlinks, []);
});

test('missing timeline clips fails closed before disk or Premiere mutation', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();

  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere, { trackItems: [] })),
    (error) => error.message === '未找到可同步名称的 Premiere 时间线音频片段'
      && error.rollbackWarnings.length === 0,
  );

  assert.deepEqual([...fs.files], [paths.source]);
  assert.deepEqual(fs.renames, []);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('timeline name API failure fails closed before disk or Premiere mutation', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ missingTrackNameApi: true });

  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === 'Premiere 时间线片段不支持名称读取或改名 API'
      && error.rollbackWarnings.length === 0,
  );

  assert.deepEqual([...fs.files], [paths.source]);
  assert.deepEqual(fs.renames, []);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('timeline getName exception fails closed before disk or Premiere mutation', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ trackGetNameError: () => true });

  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => /无法读取 Premiere 时间线片段名称/.test(error.message)
      && error.rollbackWarnings.length === 0,
  );

  assert.deepEqual([...fs.files], [paths.source]);
  assert.deepEqual(fs.renames, []);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('renameAndRelink never invokes legacy project persistence hooks', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  let persistCalls = 0;
  let persistRollbackCalls = 0;

  await transaction.renameAndRelink(commonOptions(fs, premiere, {
    persist: async () => {
      persistCalls += 1;
      throw new Error('must not save');
    },
    persistRollback: async () => {
      persistRollbackCalls += 1;
      throw new Error('must not save rollback');
    },
  }));

  assert.equal(persistCalls, 0);
  assert.equal(persistRollbackCalls, 0);
});

test('renameAndRelink reports only the rename and relink hot-path stages', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  const stages = [];

  await transaction.renameAndRelink(commonOptions(fs, premiere, {
    onStage: (stage) => stages.push(stage),
  }));

  assert.deepEqual(stages, ['rename', 'relink']);
});

test('a context switch after disk rename rolls back before Premiere is relinked', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  let validationCalls = 0;

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 3) {
        const switched = new Error('项目已切换');
        switched.code = 'VOICEOVER_NAMER_CANCELLED';
        throw switched;
      }
      return true;
    },
  })).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.code, 'VOICEOVER_NAMER_CANCELLED');
  assert.equal(validationCalls, 3);
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('a context switch after the item rename rolls back the completed hot path', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  let validationCalls = 0;

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 6) {
        const switched = new Error('序列已切换');
        switched.code = 'VOICEOVER_NAMER_CANCELLED';
        throw switched;
      }
      return true;
    },
  })).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.code, 'VOICEOVER_NAMER_CANCELLED');
  assert.equal(validationCalls, 6);
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
});

test('target conflict fails before mutating disk or Premiere', async () => {
  const fs = makeFs([paths.source, paths.target]);
  const premiere = makePremiere();
  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === '目标文件已存在' && error.rollbackWarnings.length === 0,
  );
  assert.deepEqual([...fs.files].sort(), [paths.source, paths.target].sort());
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('a changed ProjectItem source path fails before disk rename with zero mutation', async () => {
  const fs = makeFs([paths.source]);
  const otherPath = 'C:\\Captures\\different-source.wav';
  const premiere = makePremiere({ mediaPath: otherPath });

  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.rollbackWarnings.length === 0
      && /源|媒体|候选|路径/.test(error.message),
  );

  assert.deepEqual([...fs.files], [paths.source]);
  assert.deepEqual(fs.renames, []);
  assert.equal(premiere.item.mediaPath, otherPath);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('relink failure restores the original filename and media path', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({
    changeResult: (path) => path !== paths.target,
  });
  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === 'Premiere 重链接返回失败' && error.rollbackWarnings.length === 0,
  );
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.deepEqual(premiere.item.changeCalls, [paths.target]);
  assert.equal(premiere.item.refreshCount, 0);
});

test('material-name transaction failure rolls back file and media link', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ transactionResult: false });
  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === 'Premiere 素材和时间线片段名称事务返回失败' && error.rollbackWarnings.length === 0,
  );
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.source]);
});

test('one stale timeline name makes the operation fail and restores every original name', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({
    trackOriginalNames: ['片段甲', '片段乙'],
    trackNameAction: (trackItem, name, index) => {
      if (index === 1 && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav') return true;
      trackItem.name = name;
      return true;
    },
  });

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 时间线片段名验证失败');
  assert.deepEqual(error.rollbackWarnings, []);
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['片段甲', '片段乙']);
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.source]);
  assert.equal(premiere.project.transactionCount, 2);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3, 3]);
});

test('timeline rename action exception fails the operation and restores partial name changes', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({
    trackOriginalNames: ['片段甲', '片段乙'],
    trackCreateNameActionError: (_trackItem, name, index) => index === 1
      && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
  });

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, '时间线片段改名动作创建失败: track name action failed');
  assert.deepEqual(error.rollbackWarnings, []);
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['片段甲', '片段乙']);
  assert.deepEqual(premiere.project.actionsPerTransaction, [2, 3]);
});

test('rollback does not run a name transaction when neither media path survives', async () => {
  const fs = makeFs([paths.source], {
    afterRename: (source, target, files) => {
      if (source === paths.source && target === paths.target) files.delete(paths.target);
    },
  });
  const premiere = makePremiere({ trackOriginalNames: ['片段甲', '片段乙'] });
  let validationCalls = 0;

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 6) throw new Error('最终上下文验证失败');
      return true;
    },
  })).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, '最终上下文验证失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('源文件和目标文件都不存在')));
  assert.equal(fs.files.has(paths.source), false);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3]);
  assert.equal(premiere.item.name, premiere.targetName);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [premiere.targetName, premiere.targetName]);
});

test('offline or mismatched relink verification rolls back', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ offline: true });
  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === '重链接后素材仍离线或路径不一致'
      && error.rollbackWarnings.some((warning) => warning.includes('恢复媒体路径后验证失败')),
  );
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
});

test('failed disk rollback keeps Premiere on the existing target instead of a missing source', async () => {
  const fs = makeFs([paths.source], {
    renameError: (source, target) => source === paths.target && target === paths.source,
  });
  const premiere = makePremiere({
    transactionResult: false,
    changeResult: (path) => path !== paths.source,
  });
  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(error.message, 'Premiere 素材和时间线片段名称事务返回失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('磁盘文件名回滚失败')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('保留新文件并维持新路径')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('恢复素材名和时间线片段名返回失败')));
  assert.equal(fs.files.has(paths.target), true);
  assert.equal(fs.files.has(paths.source), false);
  assert.equal(premiere.item.mediaPath, paths.target);
  assert.deepEqual(premiere.item.changeCalls, [paths.target]);
});

test('failed file rollback recovers a failed forward relink to the surviving target', async () => {
  const fs = makeFs([paths.source], {
    renameError: (source, target) => source === paths.target && target === paths.source,
  });
  const premiere = makePremiere({
    changeResult: (path, callCount) => !(path === paths.target && callCount === 1),
  });
  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(error.message, 'Premiere 重链接返回失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('磁盘文件名回滚失败')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('保留新文件并维持新路径')));
  assert.equal(fs.files.has(paths.target), true);
  assert.equal(fs.files.has(paths.source), false);
  assert.equal(premiere.item.mediaPath, paths.target);
  assert.equal(premiere.item.name, '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav');
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.target]);
});

test('rollback keeps the transaction target when an external file recreates the source path', async () => {
  const fs = makeFs([paths.source], {
    afterRename: (source, target, files) => {
      if (source === paths.source && target === paths.target) files.add(paths.source);
    },
  });
  const premiere = makePremiere({
    changeResult: (path, callCount) => !(path === paths.target && callCount === 1),
  });

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 重链接返回失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('旧路径与新路径同时存在')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('保留新文件并维持新路径')));
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), true);
  assert.equal(premiere.item.mediaPath, paths.target);
  assert.equal(premiere.item.name, '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav');
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.target]);
});

test('synchronizeNames performs no transaction when the material and every timeline clip already match', async () => {
  const premiere = makePremiere({ trackOriginalNames: ['旧片段甲', '旧片段乙'] });
  premiere.item.name = premiere.targetName;
  premiere.trackItems.forEach((item) => {
    item.name = premiere.targetName;
  });

  const result = await transaction.synchronizeNames(commonNameOptions(premiere));

  assert.deepEqual(result, {
    changed: false,
    targetName: premiere.targetName,
    originalName: premiere.targetName,
  });
  assert.equal(premiere.project.transactionCount, 0);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.item.refreshCount, 0);
});

test('synchronizeNames updates the material and every stale timeline clip without relinking media', async () => {
  const premiere = makePremiere({ trackOriginalNames: ['旧片段甲', '旧片段乙'] });

  const result = await transaction.synchronizeNames(commonNameOptions(premiere));

  assert.equal(result.changed, true);
  assert.equal(premiere.item.name, premiere.targetName);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [premiere.targetName, premiere.targetName]);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3]);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.item.refreshCount, 0);
});

test('synchronizeNames submits only stale names when the material and one timeline clip already match', async () => {
  const premiere = makePremiere({ trackOriginalNames: ['旧片段', '已同步片段'] });
  premiere.item.name = premiere.targetName;
  premiere.trackItems[1].name = premiere.targetName;

  const result = await transaction.synchronizeNames(commonNameOptions(premiere));

  assert.equal(result.changed, true);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [premiere.targetName, premiere.targetName]);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.project.actionsPerTransaction, [1]);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames fails before mutation when the media path no longer matches the scanned item', async () => {
  const premiere = makePremiere({
    mediaPath: 'C:\\Captures\\other.wav',
    trackOriginalNames: ['旧片段'],
  });

  await assert.rejects(
    transaction.synchronizeNames(commonNameOptions(premiere)),
    (error) => /不再指向待核验的媒体路径/.test(error.message)
      && error.rollbackWarnings.length === 0,
  );

  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段']);
  assert.equal(premiere.project.transactionCount, 0);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames fails closed when a timeline clip lacks the name action API', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段'],
    missingTrackNameApi: true,
  });

  await assert.rejects(
    transaction.synchronizeNames(commonNameOptions(premiere)),
    (error) => error.message === 'Premiere 时间线片段不支持名称读取或改名 API'
      && error.rollbackWarnings.length === 0,
  );

  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段']);
  assert.equal(premiere.project.transactionCount, 0);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames treats a rejected compound transaction as failure without touching media', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段'],
    transactionResult: false,
  });

  await assert.rejects(
    transaction.synchronizeNames(commonNameOptions(premiere)),
    (error) => error.message === 'Premiere 素材和时间线片段名称事务返回失败'
      && error.rollbackWarnings.length === 0,
  );

  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段']);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.item.refreshCount, 0);
});

test('synchronizeNames restores every original name when one timeline clip fails verification', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段甲', '旧片段乙'],
    trackNameAction: (trackItem, name, index) => {
      if (index === 1 && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav') return true;
      trackItem.name = name;
      return true;
    },
  });

  const error = await transaction.synchronizeNames(commonNameOptions(premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 时间线片段名验证失败');
  assert.deepEqual(error.rollbackWarnings, []);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段甲', '旧片段乙']);
  assert.equal(premiere.project.transactionCount, 2);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3, 2]);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames reports an incomplete explicit restore as a rollback warning', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段甲', '旧片段乙'],
    trackNameAction: (trackItem, name, index) => {
      if (index === 1 && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav') return true;
      if (index === 0 && name === '旧片段甲') return true;
      trackItem.name = name;
      return true;
    },
  });

  const error = await transaction.synchronizeNames(commonNameOptions(premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 时间线片段名验证失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('恢复时间线片段名后验证失败')));
  assert.equal(premiere.item.name, '原始素材名');
  assert.equal(premiere.trackItems[0].name, premiere.targetName);
  assert.equal(premiere.trackItems[1].name, '旧片段乙');
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames restores partial changes when a timeline rename action cannot be created', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段甲', '旧片段乙'],
    trackCreateNameActionError: (_trackItem, name, index) => index === 1
      && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
  });

  const error = await transaction.synchronizeNames(commonNameOptions(premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, '时间线片段改名动作创建失败: track name action failed');
  assert.deepEqual(error.rollbackWarnings, []);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段甲', '旧片段乙']);
  assert.deepEqual(premiere.project.actionsPerTransaction, [2, 2]);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames preserves cancellation and restores names after a context switch', async () => {
  const premiere = makePremiere({ trackOriginalNames: ['旧片段'] });
  let validationCalls = 0;

  const error = await transaction.synchronizeNames(commonNameOptions(premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 3) {
        const switched = new Error('序列已切换');
        switched.code = 'VOICEOVER_NAMER_CANCELLED';
        throw switched;
      }
      return true;
    },
  })).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.code, 'VOICEOVER_NAMER_CANCELLED');
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段']);
  assert.equal(premiere.project.transactionCount, 2);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('setProjectItemName uses a locked Premiere transaction and returns its result', () => {
  const premiere = makePremiere();
  assert.equal(transaction.setProjectItemName(
    premiere.project, premiere.item, '新名字', '测试事务',
  ), true);
  assert.equal(premiere.item.name, '新名字');
  assert.equal(premiere.project.transactionCount, 1);
});
