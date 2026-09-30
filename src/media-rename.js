(function (root, factory) {
  "use strict";
  var cjs = typeof module !== "undefined" && module.exports;
  var api = factory(cjs ? require("./core.js") : root.VoiceoverNamerCore,
    cjs ? require("./media-conflicts.js") : root.VoiceoverNamerMediaConflicts,
    cjs ? require("./transaction.js") : root.VoiceoverNamerTransaction);
  if (cjs) module.exports = api;
  else root.VoiceoverNamerMediaRename = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core, Conflicts, Transaction) {
  "use strict";
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function entryUrl(path) {
    path = Core.plainNativePath(path).replace(/\\/g, "/");
    return "file:" + (/^[a-z]:\//i.test(path) ? "/" : "") + path;
  }

  async function moveExclusive(storage, sourcePath, targetPath) {
    var source = Core.splitNativePath(sourcePath), target = Core.splitNativePath(targetPath);
    if (!Core.sameNativePath(source.dir, target.dir)) throw new Error("同名整理只允许在原文件夹中改名");
    var file = await storage.getEntryWithUrl(entryUrl(sourcePath));
    var folder = await storage.getEntryWithUrl(entryUrl(source.dir));
    if (!file || file.isFile !== true || !folder || folder.isFolder !== true || typeof file.moveTo !== "function") {
      throw new Error("宿主不支持安全改名，原文件保持不变");
    }
    // fs.rename can replace an existing target on some platforms. UXP Entry's
    // explicit no-overwrite move also protects the last-moment target race.
    await file.moveTo(folder, { newName: target.base, overwrite: false });
  }

  async function setNames(project, names, label) {
    if (!project || typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function") {
      throw new Error("Premiere 名称事务不可用");
    }
    var result = false;
    await project.lockedAccess(function () {
      result = project.executeTransaction(function (compound) {
        for (var entry of names) {
          var action = entry.item.createSetNameAction(entry.name);
          if (!action || compound.addAction(action) === false) throw new Error("无法创建素材/片段改名动作");
        }
      }, label);
    });
    if (await result !== true) throw new Error("Premiere 名称事务返回失败");
  }
  async function readName(entry) {
    return String(entry.track ? await entry.item.getName() : entry.item.name);
  }
  async function verifyNames(names, delay) {
    for (var attempt = 0; attempt < 8; attempt += 1) {
      var matches = true;
      for (var entry of names) if (await readName(entry) !== entry.name) matches = false;
      if (matches) return;
      if (attempt < 7) await delay(80);
    }
    throw new Error("Premiere 素材或时间线名称验证失败");
  }
  async function verifyLink(item, path, delay) {
    if (!(await Transaction.verifyMediaLink(item, path, Core.sameNativePath, delay))) {
      throw new Error("重链接后素材离线或路径不一致");
    }
  }
  async function link(item, path, delay) {
    await Transaction.relinkMedia({ projectItem: item, targetPath: path, samePath: Core.sameNativePath, delay: delay });
  }
  function nameSnapshots(entry) {
    var names = [];
    entry.refs.forEach(function (ref) {
      names.push({ item: ref.item, name: ref.name, track: false, referenceId: ref.id });
      ref.tracks.forEach(function (track) { names.push({ item: track.item, name: track.name, track: true, referenceId: ref.id }); });
    });
    return names;
  }

  async function preflight(options) {
    var plan = options.plan;
    await options.validate();
    if (!plan.entry.refs.length) throw new Error("未找到素材引用");
    if (!Core.sameNativePath(Core.splitNativePath(plan.sourcePath).dir, Core.splitNativePath(plan.targetPath).dir) ||
        Core.sameNativePath(plan.sourcePath, plan.targetPath) || Core.fileNameFromPath(plan.targetPath) !== plan.targetName) {
      throw new Error("无效的原目录改名计划");
    }
    var current = await Conflicts.inspectFile(options.fs, plan.sourcePath);
    var protection = options.protect ? await options.protect(plan.sourcePath) : "";
    if (protection) throw new Error(protection);
    if (!Conflicts.sameSignature(plan.sourceSignature, current)) throw new Error("预览后源文件发生变化，请重新扫描");
    if (await Conflicts.statOrNull(options.fs, plan.targetPath)) throw new Error("目标文件已存在，未覆盖；请重新扫描");
    for (var ref of plan.entry.refs) {
      if (!Core.sameNativePath(await ref.item.getMediaFilePath(), plan.sourcePath)) throw new Error("素材路径已变化，请重新扫描");
      if (await ref.item.isOffline() !== false || await ref.item.canChangeMediaPath() !== true || await ref.item.hasProxy() !== false ||
          await ref.item.isMergedClip() !== false || await ref.item.isMulticamClip() !== false) throw new Error("素材状态已变化，请重新扫描");
    }
    var names = nameSnapshots(plan.entry);
    for (var name of names) {
      if (typeof name.item.createSetNameAction !== "function" || await readName(name) !== name.name) throw new Error("素材名称已变化或无法同步，请重新扫描");
    }
    await options.validate();
    return names;
  }

  async function fileSignature(fs, path) {
    var stat = await fs.lstat(path);
    if (!stat || typeof stat.isFile !== "function" || stat.isFile() !== true ||
        Conflicts.isKnownLink(stat) || Number(stat.nlink || 1) > 1) throw new Error("媒体路径不再是独立普通文件");
    return Conflicts.signature(stat);
  }

  async function contentProof(options, path, expectedSignature, expectedDigest) {
    var before = await fileSignature(options.fs, path);
    if (expectedSignature && !Conflicts.sameSignature(expectedSignature, before)) throw new Error("媒体文件身份发生变化");
    // Reuse the recording transaction's streaming SHA-256 reader. Never load
    // a large video in one allocation on hosts without chunked reads.
    if (typeof options.fs.open !== "function" && before.size > 8 * 1024 * 1024) {
      throw new Error("宿主缺少大文件分块校验能力，未执行改名");
    }
    var content = await Transaction.hashFile(options.fs, path, options.delay);
    var after = await fileSignature(options.fs, path);
    if (!Conflicts.sameSignature(before, after)) throw new Error("媒体文件在内容校验期间发生变化");
    if (content.size !== after.size || (expectedDigest && content.digest !== expectedDigest)) {
      throw new Error("媒体文件内容验证失败，无法确认文件身份");
    }
    return { signature: after, sha256: content.digest, size: content.size };
  }

  function stage(options, value) {
    try { if (options.onStage) options.onStage(value); } catch (error) { /* Status must not interrupt recovery. */ }
  }

  async function rollback(options, originalNames, proof) {
    var plan = options.plan, warnings = [], recoveryPath = "";
    var restorable = new Set();
    try {
      var source = await Conflicts.statOrNull(options.fs, plan.sourcePath);
      var verified = await contentProof(options, plan.targetPath, proof.movedSignature, proof.sha256);
      recoveryPath = plan.targetPath;
      if (!source) {
        var moveError = null;
        try { await options.move(plan.targetPath, plan.sourcePath); }
        catch (error) { moveError = error; }
        // A provider may throw after finishing the move. Inspect both paths
        // and verify content before deciding which location is recoverable.
        recoveryPath = "";
        var restored = await Conflicts.statOrNull(options.fs, plan.sourcePath);
        var remaining = await Conflicts.statOrNull(options.fs, plan.targetPath);
        if (restored && !remaining) {
          verified = await contentProof(options, plan.sourcePath, null, proof.sha256);
          proof.restoredSignature = verified.signature;
          recoveryPath = plan.sourcePath;
        } else {
          verified = await contentProof(options, plan.targetPath, null, proof.sha256);
          recoveryPath = plan.targetPath;
          warnings.push("恢复磁盘原名未完成：" + (moveError ? moveError.message || moveError : "原路径已被占用或移动未完成"));
        }
      } else {
        warnings.push("原路径已被占用；保留新文件，未覆盖现有文件");
      }
      for (var ref of plan.entry.refs) {
        try {
          if (!Conflicts.sameSignature(verified.signature, await fileSignature(options.fs, recoveryPath))) throw new Error("恢复文件已变化");
          var current = await ref.item.getMediaFilePath();
          if (!Core.sameNativePath(current, plan.sourcePath) && !Core.sameNativePath(current, plan.targetPath)) throw new Error("媒体路径已由其他操作修改");
          restorable.add(ref.id);
          await link(ref.item, recoveryPath, options.delay);
        } catch (error) { warnings.push("恢复引用 " + ref.id + " 失败：" + (error.message || error)); }
      }
      var names = originalNames.filter(function (entry) { return restorable.has(entry.referenceId); }).map(function (entry) {
        return { item: entry.item, track: entry.track, name: recoveryPath === plan.sourcePath ? entry.name : plan.targetName };
      });
      if (names.length) await setNames(options.project, names, "恢复项目面板素材名称");
      await verifyNames(names, options.delay);
      for (var checked of plan.entry.refs) if (restorable.has(checked.id)) await verifyLink(checked.item, recoveryPath, options.delay);
      if (!Conflicts.sameSignature(verified.signature, await fileSignature(options.fs, recoveryPath))) {
        recoveryPath = "";
        throw new Error("恢复校验期间文件再次变化，请核对记录中的两个位置");
      }
      if (recoveryPath !== plan.sourcePath) warnings.push("文件保留在新路径：" + recoveryPath);
    } catch (error) { warnings.push(error.message || String(error)); }
    return { warnings: warnings, recoveryPath: recoveryPath };
  }

  async function execute(options) {
    options = Object.assign({ delay: wait, validate: async function () {} }, options);
    var plan = options.plan, moved = false, attempted = false, originals = [];
    var proof = { sha256: "", sourceSignature: plan.sourceSignature, observedTargetSignature: null,
      movedSignature: null, restoredSignature: null };
    try {
      originals = await preflight(options);
      stage(options, "verify-source");
      var sourceContent = await contentProof(options, plan.sourcePath, plan.sourceSignature);
      proof.sha256 = sourceContent.sha256;
      // This hook must persist the reviewable mapping before any file changes.
      if (options.beforeMove) await options.beforeMove(proof);
      // Hashing can take time. Recheck the host references and source after it
      // and the journal write, before performing a no-overwrite rename.
      await preflight(options);
      if (!Conflicts.sameSignature(plan.sourceSignature, await fileSignature(options.fs, plan.sourcePath))) {
        throw new Error("源文件仍在变化，未执行改名");
      }
      stage(options, "rename");
      attempted = true;
      await options.move(plan.sourcePath, plan.targetPath);
      moved = true;
      stage(options, "verify-target");
      proof.observedTargetSignature = await fileSignature(options.fs, plan.targetPath);
      var targetContent = await contentProof(options, plan.targetPath, proof.observedTargetSignature, proof.sha256);
      proof.movedSignature = targetContent.signature;
      if (await Conflicts.statOrNull(options.fs, plan.sourcePath)) throw new Error("改名后原路径被占用或移动未完成");
      stage(options, "relink");
      for (var ref of plan.entry.refs) {
        await options.validate();
        var currentPath = await ref.item.getMediaFilePath();
        if (!Core.sameNativePath(currentPath, plan.sourcePath) && !Core.sameNativePath(currentPath, plan.targetPath)) {
          throw new Error("校验期间素材路径已由其他操作修改");
        }
        await link(ref.item, plan.targetPath, options.delay);
      }
      await options.validate();
      var renamed = originals.map(function (entry) { return { item: entry.item, track: entry.track, name: plan.targetName }; });
      await setNames(options.project, renamed, "整理项目面板同名素材");
      await verifyNames(renamed, options.delay);
      for (var checked of plan.entry.refs) await verifyLink(checked.item, plan.targetPath, options.delay);
      await options.validate();
      if (!Conflicts.sameSignature(proof.movedSignature, await fileSignature(options.fs, plan.targetPath))) throw new Error("验证期间媒体文件发生变化");
      return { sourcePath: plan.sourcePath, targetPath: plan.targetPath, targetName: plan.targetName,
        references: plan.entry.refs.length, fileProof: proof };
    } catch (error) {
      var recovery = { warnings: [], recoveryPath: "" };
      if (!moved && attempted) {
        try {
          var source = await Conflicts.statOrNull(options.fs, plan.sourcePath);
          var target = await Conflicts.statOrNull(options.fs, plan.targetPath);
          // Content proof also works when exFAT has changed the directory-entry
          // identity or UXP does not expose any inode at all.
          if (!source && target) {
            proof.observedTargetSignature = Conflicts.signature(target);
            var adopted = await contentProof(options, plan.targetPath, proof.observedTargetSignature, proof.sha256);
            moved = true;
            proof.movedSignature = adopted.signature;
          } else if (!source) recovery.warnings.push("源路径消失，无法确认改名结果；请按命名记录核对文件");
          else if (!Conflicts.sameSignature(plan.sourceSignature, Conflicts.signature(source))) {
            recovery.warnings.push("改名返回异常且原路径身份已变化；请按命名记录核对文件");
          }
        } catch (checkError) { recovery.warnings.push("无法确认磁盘改名结果：" + (checkError.message || checkError)); }
      }
      if (moved) {
        stage(options, "rollback");
        recovery = await rollback(options, originals, proof);
      }
      var wrapped = new Error(error.message || String(error));
      wrapped.code = error.code;
      wrapped.rollbackWarnings = recovery.warnings;
      wrapped.recoveryPath = recovery.recoveryPath;
      wrapped.fileProof = proof;
      wrapped.needsRecovery = recovery.warnings.length > 0;
      wrapped.pathsToCheck = wrapped.needsRecovery ? [plan.sourcePath, plan.targetPath] : [];
      wrapped.cause = error;
      throw wrapped;
    }
  }
  return { execute: execute, preflight: preflight, moveExclusive: moveExclusive, entryUrl: entryUrl };
});
