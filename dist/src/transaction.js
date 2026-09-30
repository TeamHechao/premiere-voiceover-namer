(function (root, factory) {
  "use strict";

  var hashApi = typeof module !== "undefined" && module.exports
    ? require("./sha256.js")
    : root.VoiceoverNamerSha256;
  var api = factory(hashApi);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerTransaction = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (HashApi) {
  "use strict";

  function wait(milliseconds) {
    return new Promise(function (resolve) {
      setTimeout(resolve, milliseconds);
    });
  }

  async function exists(fs, nativePath) {
    try {
      await fs.lstat(nativePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  function successResult(value) {
    return value === 0 || value === undefined || value === null;
  }

  function isTargetConflict(error) {
    var current = error;
    for (var depth = 0; current && depth < 4; depth += 1) {
      var code = String(current.code || "").toUpperCase();
      var message = String(current.message || current);
      if (code === "EEXIST") return true;
      if (/目标文件已存在|already exists|file exists/i.test(message)) return true;
      current = current.cause;
    }
    return false;
  }

  async function renameFile(fs, sourcePath, targetPath) {
    var result = await fs.rename(sourcePath, targetPath);
    if (!successResult(result)) {
      throw new Error("文件系统返回了意外结果: " + result);
    }
  }

  function errorCode(error) {
    var current = error;
    for (var depth = 0; current && depth < 4; depth += 1) {
      var code = String(current.code || "").toUpperCase();
      if (code) return code;
      current = current.cause;
    }
    return "";
  }

  function isCrossDeviceError(error) {
    var code = errorCode(error);
    if (code === "EXDEV") return true;
    var message = String(error && error.message || error || "");
    return /cross-device|different device|跨卷|跨设备|不同磁盘/i.test(message);
  }

  function isMissingError(error) {
    return errorCode(error) === "ENOENT" || /no such file|找不到|不存在/i.test(String(error && error.message || error || ""));
  }

  async function unlinkFile(fs, nativePath) {
    var result = await fs.unlink(nativePath);
    if (!successResult(result)) {
      throw new Error("文件系统删除返回了意外结果: " + result);
    }
  }

  function numericStatValue(stat, millisecondKey, dateKey) {
    var value = Number(stat && stat[millisecondKey] || 0);
    if (!value && stat && stat[dateKey]) value = new Date(stat[dateKey]).getTime();
    return value || 0;
  }

  function snapshotFromStat(stat) {
    return {
      size: Number(stat && stat.size || 0),
      mtime: numericStatValue(stat, "mtimeMs", "mtime"),
      birthtime: numericStatValue(stat, "birthtimeMs", "birthtime"),
      ctime: numericStatValue(stat, "ctimeMs", "ctime"),
      ino: stat && stat.ino != null ? String(stat.ino) : "",
    };
  }

  function sameFileSnapshot(left, right) {
    if (!left || !right) return false;
    return left.size === right.size
      && left.mtime === right.mtime
      && left.birthtime === right.birthtime
      && left.ctime === right.ctime
      && left.ino === right.ino;
  }

  async function readFileSnapshot(fs, nativePath) {
    return snapshotFromStat(await fs.lstat(nativePath));
  }

  function nativeVolumeKey(nativePath) {
    var value = String(nativePath || "");
    var drive = value.match(/^([a-z]):[\\/]/i);
    if (drive) return "drive:" + drive[1].toLowerCase();
    var unc = value.match(/^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/);
    if (unc) return "unc:" + unc[1].toLowerCase() + "/" + unc[2].toLowerCase();
    var macVolume = value.match(/^\/Volumes\/([^/]+)/);
    if (macVolume) return "volume:" + macVolume[1];
    return "";
  }

  function pathsAreOnDifferentKnownVolumes(sourcePath, targetPath) {
    var sourceVolume = nativeVolumeKey(sourcePath);
    var targetVolume = nativeVolumeKey(targetPath);
    return !!sourceVolume && !!targetVolume && sourceVolume !== targetVolume;
  }

  function byteView(value, byteLength) {
    var view;
    if (value instanceof Uint8Array) {
      view = value;
    } else if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      view = new Uint8Array(value);
    } else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      throw new Error("文件系统返回了无法校验的二进制数据");
    }
    return byteLength == null || byteLength === view.byteLength ? view : view.subarray(0, byteLength);
  }

  async function closeReadHandle(fs, handle) {
    if (typeof handle === "number") {
      var result = await fs.close(handle);
      if (!successResult(result)) throw new Error("文件读取句柄关闭失败");
      return;
    }
    if (handle && typeof handle.close === "function") await handle.close();
  }

  async function hashFileWithHandle(fs, nativePath, delay) {
    var hasher = HashApi.createHasher();
    var handle = await fs.open(nativePath, "r");
    var totalBytes = 0;
    var chunks = 0;
    var chunkSize = 1024 * 1024;
    try {
      var numericBuffer = typeof handle === "number" ? new ArrayBuffer(chunkSize) : null;
      var typedBuffer = typeof handle !== "number" && handle && typeof handle.read === "function"
        ? new Uint8Array(chunkSize)
        : null;
      while (true) {
        var bytesRead = 0;
        var output;
        if (typeof handle === "number") {
          if (typeof fs.read !== "function" || typeof fs.close !== "function") {
            throw new Error("当前 UXP 文件系统缺少分块读取能力");
          }
          var numericResult = await fs.read(handle, numericBuffer, 0, chunkSize, -1);
          bytesRead = Number(numericResult && numericResult.bytesRead || 0);
          output = numericResult && numericResult.buffer || numericBuffer;
        } else if (handle && typeof handle.read === "function") {
          var handleResult = await handle.read(typedBuffer, 0, chunkSize, null);
          bytesRead = Number(handleResult && handleResult.bytesRead || 0);
          output = handleResult && handleResult.buffer || typedBuffer;
        } else {
          throw new Error("文件系统返回了无法使用的读取句柄");
        }
        if (!bytesRead) break;
        hasher.update(byteView(output, bytesRead));
        totalBytes += bytesRead;
        chunks += 1;
        if (chunks % 4 === 0) await delay(0);
      }
    } finally {
      await closeReadHandle(fs, handle);
    }
    return { digest: hasher.digestHex(), size: totalBytes };
  }

  async function hashFile(fs, nativePath, delay) {
    delay = delay || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    if (!HashApi || typeof HashApi.createHasher !== "function") {
      var unsupported = new Error("当前插件缺少录音内容校验模块");
      unsupported.code = "ENOSYS";
      throw unsupported;
    }
    if (fs && typeof fs.open === "function") {
      return hashFileWithHandle(fs, nativePath, delay);
    }
    if (!fs || typeof fs.readFile !== "function") {
      var noReader = new Error("当前 UXP 文件系统不支持录音内容校验");
      noReader.code = "ENOSYS";
      throw noReader;
    }
    var contents = byteView(await fs.readFile(nativePath));
    return { digest: HashApi.hashHex(contents), size: contents.byteLength };
  }

  async function verifyFileContent(context, nativePath, expectedSnapshot, expectedDigest) {
    try {
      var before = await readFileSnapshot(context.fs, nativePath);
      if (expectedSnapshot && !sameFileSnapshot(expectedSnapshot, before)) {
        return { valid: false, missing: false, reason: "身份已变化" };
      }
      var content = await hashFile(context.fs, nativePath, context.delay);
      var after = await readFileSnapshot(context.fs, nativePath);
      if (!sameFileSnapshot(before, after)) {
        return { valid: false, missing: false, reason: "在校验期间发生变化" };
      }
      if (content.size !== after.size) {
        return { valid: false, missing: false, reason: "读取长度与文件大小不一致" };
      }
      if (expectedDigest && content.digest !== expectedDigest) {
        return { valid: false, missing: false, reason: "内容与已验证副本不一致" };
      }
      return {
        valid: true,
        missing: false,
        digest: content.digest,
        snapshot: after,
      };
    } catch (error) {
      return {
        valid: false,
        missing: isMissingError(error),
        reason: isMissingError(error) ? "不存在" : "无法读取：" + (error.message || error),
      };
    }
  }

  async function copyFileExclusive(fs, sourcePath, targetPath) {
    if (!fs || typeof fs.copyFile !== "function") {
      var unsupported = new Error("当前 UXP 文件系统不支持跨盘复制");
      unsupported.code = "ENOSYS";
      throw unsupported;
    }
    var exclusiveFlag = fs.constants && fs.constants.COPYFILE_EXCL != null
      ? fs.constants.COPYFILE_EXCL
      : 1;
    var result = await fs.copyFile(sourcePath, targetPath, exclusiveFlag);
    if (!successResult(result)) {
      throw new Error("文件系统复制返回了意外结果: " + result);
    }
  }

  async function transferFile(context) {
    context.sourceSnapshot = await readFileSnapshot(context.fs, context.sourcePath);
    if (!pathsAreOnDifferentKnownVolumes(context.sourcePath, context.targetPath)) {
      try {
        await renameFile(context.fs, context.sourcePath, context.targetPath);
        context.fileRenamed = true;
        context.transferMode = "renamed";
        return;
      } catch (error) {
        if (!isCrossDeviceError(error)) throw error;
      }
    }

    context.copyAttempted = true;
    await copyFileExclusive(context.fs, context.sourcePath, context.targetPath);
    context.fileCopied = true;
    context.transferMode = "copied";

    var sourceAfterCopy = await readFileSnapshot(context.fs, context.sourcePath);
    if (!sameFileSnapshot(context.sourceSnapshot, sourceAfterCopy)) {
      var changed = new Error("跨盘复制期间源文件发生变化，请重新扫描");
      changed.code = "VOICEOVER_NAMER_NOT_READY";
      throw changed;
    }
    var targetSnapshot = await readFileSnapshot(context.fs, context.targetPath);
    if (targetSnapshot.size !== context.sourceSnapshot.size) {
      throw new Error("跨盘复制校验失败：最终文件大小不一致");
    }

    var sourceContent = await verifyFileContent(context, context.sourcePath, context.sourceSnapshot, "");
    if (!sourceContent.valid) {
      throw new Error("跨盘复制校验失败：源文件" + sourceContent.reason);
    }
    var targetContent = await verifyFileContent(context, context.targetPath, targetSnapshot, sourceContent.digest);
    if (!targetContent.valid) {
      throw new Error("跨盘复制校验失败：目标文件" + targetContent.reason);
    }
    context.sourceDigest = sourceContent.digest;
    context.targetDigest = targetContent.digest;
    context.targetSnapshot = targetContent.snapshot;
  }

  async function verifyLink(projectItem, expectedPath, samePath) {
    var actualPath = await projectItem.getMediaFilePath();
    var offline = await projectItem.isOffline();
    return offline === false && samePath(actualPath, expectedPath);
  }

  async function waitForVerifiedLink(projectItem, expectedPath, samePath, delay) {
    for (var attempt = 0; attempt < 10; attempt += 1) {
      try {
        if (await verifyLink(projectItem, expectedPath, samePath)) return true;
      } catch (error) {}
      if (attempt < 9) await delay(150);
    }
    return false;
  }

  // Recording recovery and manual media naming share the same host operation:
  // override the stale path check, refresh, then read back both path and online
  // state. This changes only this ProjectItem, never rewrites a .prproj file.
  async function relinkMedia(options) {
    var item = options.projectItem;
    var delay = options.delay || wait;
    if (options.forceChange || !options.samePath(await item.getMediaFilePath(), options.targetPath) || await item.isOffline() !== false) {
      var changed = await item.changeMediaFilePath(options.targetPath, true);
      if (!changed) throw new Error("Premiere 重链接返回失败");
      if (options.onPathChanged) options.onPathChanged();
    }
    await validateContext(options.validate);
    await item.refreshMedia();
    if (!(await waitForVerifiedLink(item, options.targetPath, options.samePath, delay))) {
      throw new Error("重链接后素材仍离线或路径不一致");
    }
  }

  async function recoverLink(context, recoveryPath) {
    for (var attempt = 0; attempt < 3; attempt += 1) {
      if (await waitForVerifiedLink(context.projectItem, recoveryPath, context.samePath, context.delay)) return true;
      try {
        await relinkMedia({ projectItem: context.projectItem, targetPath: recoveryPath,
          samePath: context.samePath, delay: context.delay, forceChange: true });
        return true;
      } catch (error) {}
      if (attempt < 2) await context.delay(150);
    }
    return false;
  }

  async function waitForVerifiedName(projectItem, expectedName, delay) {
    for (var attempt = 0; attempt < 8; attempt += 1) {
      if (String(projectItem.name || "") === String(expectedName)) return true;
      if (attempt < 7) await delay(80);
    }
    return false;
  }

  async function validateContext(validate) {
    if (typeof validate !== "function") return;
    var valid = await validate();
    if (valid === false) throw new Error("项目或序列已切换");
  }

  function notifyStage(listener, stage) {
    if (typeof listener !== "function") return;
    try {
      listener(stage);
    } catch (error) {}
  }

  function uniqueTrackItems(trackItems) {
    var unique = [];
    var seen = new Set();
    (trackItems || []).forEach(function (trackItem) {
      if (!trackItem || seen.has(trackItem)) return;
      seen.add(trackItem);
      unique.push(trackItem);
    });
    return unique;
  }

  async function captureTrackItemNames(trackItems) {
    var unique = uniqueTrackItems(trackItems);
    if (!unique.length) throw new Error("未找到可同步名称的 Premiere 时间线音频片段");

    var snapshots = [];
    for (var index = 0; index < unique.length; index += 1) {
      var trackItem = unique[index];
      if (typeof trackItem.getName !== "function" || typeof trackItem.createSetNameAction !== "function") {
        throw new Error("Premiere 时间线片段不支持名称读取或改名 API");
      }
      var originalName;
      try {
        originalName = await trackItem.getName();
      } catch (error) {
        throw new Error("无法读取 Premiere 时间线片段名称: " + (error.message || error));
      }
      if (originalName === undefined || originalName === null) {
        throw new Error("Premiere 时间线片段返回了无效名称");
      }
      snapshots.push({
        trackItem: trackItem,
        originalName: String(originalName),
      });
    }
    return snapshots;
  }

  function addRequiredNameAction(compoundAction, owner, name, description) {
    var action;
    try {
      action = owner.createSetNameAction(name);
    } catch (error) {
      throw new Error(description + "改名动作创建失败: " + (error.message || error));
    }
    if (!action) throw new Error(description + "改名动作不可用");
    var added;
    try {
      added = compoundAction.addAction(action);
    } catch (error) {
      throw new Error(description + "改名动作加入事务失败: " + (error.message || error));
    }
    if (added === false) throw new Error(description + "改名动作加入事务失败");
  }

  function ensureNameTransactionSupport(project, projectItem) {
    if (!project || typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function") {
      throw new Error("Premiere 项目不支持名称事务 API");
    }
    if (!projectItem || typeof projectItem.createSetNameAction !== "function") {
      throw new Error("Premiere 素材不支持改名 API");
    }
  }

  function setProjectAndTrackItemNames(project, projectItem, projectItemName, trackItemNames, undoLabel) {
    ensureNameTransactionSupport(project, projectItem);

    var success = false;
    project.lockedAccess(function () {
      success = project.executeTransaction(function (compoundAction) {
        if (!compoundAction || typeof compoundAction.addAction !== "function") {
          throw new Error("Premiere 名称事务不可用");
        }
        if (projectItemName !== undefined && projectItemName !== null) {
          addRequiredNameAction(compoundAction, projectItem, projectItemName, "素材");
        }
        (trackItemNames || []).forEach(function (entry) {
          if (!entry || !entry.trackItem || typeof entry.trackItem.createSetNameAction !== "function") {
            throw new Error("Premiere 时间线片段不支持改名 API");
          }
          addRequiredNameAction(compoundAction, entry.trackItem, entry.name, "时间线片段");
        });
      }, undoLabel || "Rename captured audio");
    });
    return success;
  }

  function setProjectItemName(project, projectItem, name, undoLabel) {
    return setProjectAndTrackItemNames(project, projectItem, name, [], undoLabel);
  }

  async function waitForVerifiedTrackItemNames(trackItemNames, delay) {
    for (var attempt = 0; attempt < 8; attempt += 1) {
      var allMatch = true;
      for (var index = 0; index < (trackItemNames || []).length; index += 1) {
        var entry = trackItemNames[index];
        try {
          var actualName = await entry.trackItem.getName();
          if (String(actualName) !== String(entry.name)) allMatch = false;
        } catch (error) {
          allMatch = false;
        }
      }
      if (allMatch) return true;
      if (attempt < 7) await delay(80);
    }
    return false;
  }

  async function restoreNames(project, projectItem, originalName, trackItemNames, delay) {
    var warnings = [];
    var projectItemRestoreName = null;
    var trackItemRestoreNames = [];

    try {
      if (String(projectItem.name || "") !== String(originalName)) {
        projectItemRestoreName = originalName;
      }
    } catch (error) {
      projectItemRestoreName = originalName;
    }

    for (var index = 0; index < (trackItemNames || []).length; index += 1) {
      var entry = trackItemNames[index];
      try {
        var currentName = await entry.trackItem.getName();
        if (String(currentName) !== String(entry.originalName)) {
          trackItemRestoreNames.push({ trackItem: entry.trackItem, name: entry.originalName });
        }
      } catch (error) {
        trackItemRestoreNames.push({ trackItem: entry.trackItem, name: entry.originalName });
      }
    }

    if (projectItemRestoreName === null && !trackItemRestoreNames.length) return warnings;

    try {
      if (!setProjectAndTrackItemNames(
        project,
        projectItem,
        projectItemRestoreName,
        trackItemRestoreNames,
        "恢复录音素材和时间线片段名"
      )) {
        warnings.push("恢复素材名和时间线片段名返回失败");
        return warnings;
      }
      if (projectItemRestoreName !== null && !(await waitForVerifiedName(projectItem, originalName, delay))) {
        warnings.push("恢复素材名后验证失败");
      }
      var expectedTrackItemNames = (trackItemNames || []).map(function (entry) {
        return { trackItem: entry.trackItem, name: entry.originalName };
      });
      if (!(await waitForVerifiedTrackItemNames(expectedTrackItemNames, delay))) {
        warnings.push("恢复时间线片段名后验证失败");
      }
    } catch (error) {
      warnings.push("恢复素材名和时间线片段名失败: " + (error.message || error));
    }

    return warnings;
  }

  async function synchronizeNames(options) {
    var project = options.project;
    var projectItem = options.projectItem;
    var targetName = String(options.targetName || "");
    var delay = options.delay || wait;
    var originalName = String(projectItem.name || "");
    var trackItemNames = [];

    try {
      if (!targetName) throw new Error("缺少要同步的录音名称");
      await validateContext(options.validate);
      ensureNameTransactionSupport(project, projectItem);
      if (options.expectedMediaPath && typeof options.samePath === "function") {
        var currentMediaPath = await projectItem.getMediaFilePath();
        if (!options.samePath(currentMediaPath, options.expectedMediaPath)) {
          throw new Error("Premiere 素材已不再指向待核验的媒体路径");
        }
      }
      trackItemNames = await captureTrackItemNames(options.trackItems);

      var projectItemTargetName = originalName === targetName ? null : targetName;
      var changedTrackItemNames = trackItemNames.filter(function (entry) {
        return entry.originalName !== targetName;
      }).map(function (entry) {
        return { trackItem: entry.trackItem, name: targetName };
      });
      if (projectItemTargetName === null && !changedTrackItemNames.length) {
        return {
          changed: false,
          targetName: targetName,
          originalName: originalName,
        };
      }

      await validateContext(options.validate);
      if (!setProjectAndTrackItemNames(
        project,
        projectItem,
        projectItemTargetName,
        changedTrackItemNames,
        "修复录音素材和时间线片段名"
      )) {
        throw new Error("Premiere 素材和时间线片段名称事务返回失败");
      }

      if (!(await waitForVerifiedName(projectItem, targetName, delay))) {
        throw new Error("Premiere 素材名验证失败");
      }
      var targetTrackItemNames = trackItemNames.map(function (entry) {
        return { trackItem: entry.trackItem, name: targetName };
      });
      if (!(await waitForVerifiedTrackItemNames(targetTrackItemNames, delay))) {
        throw new Error("Premiere 时间线片段名验证失败");
      }
      await validateContext(options.validate);
      if (options.expectedMediaPath && typeof options.samePath === "function") {
        var verifiedMediaPath = await projectItem.getMediaFilePath();
        if (!options.samePath(verifiedMediaPath, options.expectedMediaPath)) {
          throw new Error("名称同步期间 Premiere 素材路径发生变化");
        }
      }

      return {
        changed: true,
        targetName: targetName,
        originalName: originalName,
      };
    } catch (error) {
      var rollbackWarnings = trackItemNames.length
        ? await restoreNames(project, projectItem, originalName, trackItemNames, delay)
        : [];
      var wrapped = new Error(error && error.message ? error.message : String(error));
      wrapped.cause = error;
      if (error && error.code) wrapped.code = error.code;
      wrapped.rollbackWarnings = rollbackWarnings;
      throw wrapped;
    }
  }

  async function restoreContextNames(context, recoveryName, useTargetName, warnings) {
    try {
      var trackItemRestoreNames = (context.trackItemNames || []).map(function (entry) {
        return {
          trackItem: entry.trackItem,
          name: useTargetName ? context.targetName : entry.originalName,
        };
      });
      var namesNeedRestore = String(context.projectItem.name || "") !== String(recoveryName);
      for (var nameIndex = 0; nameIndex < trackItemRestoreNames.length; nameIndex += 1) {
        try {
          var currentTrackItemName = await trackItemRestoreNames[nameIndex].trackItem.getName();
          if (String(currentTrackItemName) !== String(trackItemRestoreNames[nameIndex].name)) namesNeedRestore = true;
        } catch (error) {
          namesNeedRestore = true;
        }
      }
      if (!namesNeedRestore) return;
      if (!setProjectAndTrackItemNames(
        context.project,
        context.projectItem,
        recoveryName,
        trackItemRestoreNames,
        "恢复录音素材和时间线片段名"
      )) {
        warnings.push("恢复素材名和时间线片段名返回失败");
        return;
      }
      if (!(await waitForVerifiedName(context.projectItem, recoveryName, context.delay))) {
        warnings.push("恢复素材名后验证失败");
      }
      if (!(await waitForVerifiedTrackItemNames(trackItemRestoreNames, context.delay))) {
        warnings.push("恢复时间线片段名后验证失败");
      }
    } catch (error) {
      warnings.push("恢复素材名和时间线片段名失败: " + error.message);
    }
  }

  async function bestEffortCopiedRollback(context, warnings) {
    var sourceExists = await exists(context.fs, context.sourcePath);
    var targetExists = await exists(context.fs, context.targetPath);
    var sourceMatches = false;
    if (sourceExists) {
      try {
        sourceMatches = sameFileSnapshot(context.sourceSnapshot, await readFileSnapshot(context.fs, context.sourcePath));
      } catch (error) {}
    }

    var targetMatches = false;
    if (targetExists && context.targetDigest) {
      var targetVerification = await verifyFileContent(
        context,
        context.targetPath,
        context.targetSnapshot,
        context.targetDigest
      );
      targetMatches = targetVerification.valid;
    }

    var recoveryPath = sourceExists && sourceMatches
      ? context.sourcePath
      : targetMatches ? context.targetPath : "";
    var useTargetName = recoveryPath === context.targetPath;
    var recoveryName = useTargetName ? context.targetName : context.originalName;
    if (useTargetName) {
      warnings.push(sourceExists
        ? "源文件身份发生变化；保留工程目录中的已验证副本并维持新路径"
        : "源文件已不存在；保留工程目录中的已验证副本并维持新路径");
    }

    if (!recoveryPath) {
      warnings.push("没有找到身份可确认的源文件或工程目录副本，未继续修改媒体路径和名称");
      if (targetExists) warnings.push("工程媒体目录中的未确认文件已保留，插件没有自动删除");
      return;
    }

    var linkRecovered = await recoverLink(context, recoveryPath);
    if (!linkRecovered) warnings.push("恢复媒体路径后验证失败");
    await restoreContextNames(context, recoveryName, useTargetName, warnings);
    if (!useTargetName && targetExists) {
      warnings.push(context.fileCopied
        ? "工程媒体目录中的事务副本已保留，插件没有在回滚时自动删除"
        : "工程媒体目录目标路径中的文件已保留，插件没有在回滚时自动删除");
    }
  }

  async function bestEffortRollback(context) {
    var warnings = [];
    if (!context.fileRenamed && !context.copyAttempted && !context.fileCopied && !context.linkChanged && !context.itemNameChanged) return warnings;

    if (context.copyAttempted || context.fileCopied) {
      await bestEffortCopiedRollback(context, warnings);
      return warnings;
    }

    var sourceExists = await exists(context.fs, context.sourcePath);
    var targetExists = await exists(context.fs, context.targetPath);
    var preferTarget = false;

    if (context.fileRenamed) {
      try {
        if (targetExists && sourceExists) {
          preferTarget = true;
          warnings.push("旧路径与新路径同时存在；为避免误链到新生成的同名文件，保留本次事务的目标文件");
        } else if (targetExists && !sourceExists) {
          await renameFile(context.fs, context.targetPath, context.sourcePath);
          sourceExists = await exists(context.fs, context.sourcePath);
          targetExists = await exists(context.fs, context.targetPath);
        } else if (!sourceExists) {
          warnings.push("找不到可恢复的源文件或目标文件");
        }
      } catch (error) {
        warnings.push("磁盘文件名回滚失败: " + error.message);
        sourceExists = await exists(context.fs, context.sourcePath);
        targetExists = await exists(context.fs, context.targetPath);
      }
    }

    var recoveryPath = preferTarget ? context.targetPath : sourceExists ? context.sourcePath : targetExists ? context.targetPath : "";
    var useTargetName = recoveryPath === context.targetPath;
    var recoveryName = useTargetName ? context.targetName : context.originalName;
    if (useTargetName) warnings.push("旧文件名未恢复，保留新文件并维持新路径");

    if (!recoveryPath) {
      warnings.push("源文件和目标文件都不存在，未修改媒体路径、素材名或时间线片段名");
      return warnings;
    }

    var linkRecovered = await recoverLink(context, recoveryPath);
    if (!linkRecovered && recoveryPath === context.sourcePath && sourceExists && !targetExists) {
      var actualPath = "";
      try {
        actualPath = await context.projectItem.getMediaFilePath();
      } catch (error) {}
      if (context.samePath(actualPath, context.targetPath)) {
        try {
          await renameFile(context.fs, context.sourcePath, context.targetPath);
          sourceExists = false;
          targetExists = true;
          recoveryPath = context.targetPath;
          useTargetName = true;
          recoveryName = context.targetName;
          warnings.push("旧媒体路径无法恢复，已将文件重新放回当前新路径");
          linkRecovered = await recoverLink(context, recoveryPath);
        } catch (error) {
          warnings.push("恢复当前新路径失败: " + error.message);
        }
      }
    }
    if (!linkRecovered) warnings.push("恢复媒体路径后验证失败");
    await restoreContextNames(context, recoveryName, useTargetName, warnings);
    return warnings;
  }

  function cleanupQuarantinePath(context, attempt) {
    var sourcePath = String(context.sourcePath || "");
    var separatorIndex = Math.max(sourcePath.lastIndexOf("\\"), sourcePath.lastIndexOf("/"));
    var directory = separatorIndex >= 0 ? sourcePath.slice(0, separatorIndex + 1) : "";
    var token = String(context.operationId || context.targetName || "recording")
      .replace(/[^a-z0-9]/gi, "")
      .slice(-40);
    var suffix = attempt ? "-" + String(attempt + 1) : "";
    return directory + ".voiceover-namer-cleanup-" + token + suffix;
  }

  async function cleanupContextIsValid(context) {
    try {
      await validateContext(context.validate);
      return true;
    } catch (error) {
      return false;
    }
  }

  async function cleanupCopiedSource(context) {
    var lastError = null;
    if (!(await cleanupContextIsValid(context))) {
      return {
        sourceRetained: true,
        cleanupWarning: "最终文件已链接，但项目或序列在清理前发生切换；原始采集文件已保留",
      };
    }

    var targetVerification = await verifyFileContent(
      context,
      context.targetPath,
      context.targetSnapshot,
      context.targetDigest
    );
    if (!targetVerification.valid) {
      return {
        sourceRetained: true,
        cleanupWarning: "最终文件已链接，但工程目录副本" + targetVerification.reason + "；原始采集文件已保留",
      };
    }

    for (var attempt = 0; attempt < 4; attempt += 1) {
      if (!(await cleanupContextIsValid(context))) {
        return {
          sourceRetained: true,
          cleanupWarning: "最终文件已链接，但项目或序列在清理前发生切换；原始采集文件已保留",
        };
      }

      var currentTargetSnapshot;
      try {
        currentTargetSnapshot = await readFileSnapshot(context.fs, context.targetPath);
      } catch (error) {
        return {
          sourceRetained: true,
          cleanupWarning: "最终文件已链接，但无法再次核验工程目录副本；原始采集文件已保留",
        };
      }
      if (!sameFileSnapshot(context.targetSnapshot, currentTargetSnapshot)) {
        return {
          sourceRetained: true,
          cleanupWarning: "最终文件已链接，但工程目录副本身份已变化；原始采集文件已保留",
        };
      }

      var sourceSnapshot;
      try {
        sourceSnapshot = await readFileSnapshot(context.fs, context.sourcePath);
      } catch (error) {
        if (isMissingError(error)) {
          return {
            sourceRetained: false,
            cleanupWarning: "最终文件已链接，但原始采集文件在插件清理前已经不存在，无法确认由插件删除",
          };
        }
        lastError = error;
        if (attempt < 3) {
          await context.delay(150);
          continue;
        }
        return {
          sourceRetained: true,
          cleanupWarning: "最终文件已链接，但无法核验原始采集文件；该文件已保留",
        };
      }
      if (!sameFileSnapshot(context.sourceSnapshot, sourceSnapshot)) {
        return {
          sourceRetained: true,
          cleanupWarning: "最终文件已链接，但原始采集路径的文件身份已变化；未删除该文件",
        };
      }

      var quarantinePath = cleanupQuarantinePath(context, attempt);
      if (await exists(context.fs, quarantinePath)) {
        lastError = new Error("临时清理路径已被占用");
        if (attempt < 3) continue;
        return {
          sourceRetained: true,
          cleanupWarning: "最终文件已链接，但无法取得唯一清理路径；原始采集文件已保留",
        };
      }

      try {
        await renameFile(context.fs, context.sourcePath, quarantinePath);
      } catch (error) {
        if (isMissingError(error)) {
          return {
            sourceRetained: false,
            cleanupWarning: "最终文件已链接，但原始采集文件在插件清理时被外部移除，无法确认由插件删除",
          };
        }
        lastError = error;
        if (attempt < 3) {
          await context.delay(150);
          continue;
        }
        return {
          sourceRetained: true,
          cleanupWarning: "最终文件已保存并链接，但原始采集文件暂未删除：" + (error.message || error),
        };
      }

      context.sourceQuarantinePath = quarantinePath;
      var quarantined = await verifyFileContent(context, quarantinePath, null, context.sourceDigest);
      if (!quarantined.valid) {
        return {
          sourceRetained: true,
          cleanupWarning: "清理时检测到原始采集路径已被替换；文件未删除，保留在 " + quarantinePath,
        };
      }
      if (!(await cleanupContextIsValid(context))) {
        return {
          sourceRetained: true,
          cleanupWarning: "项目或序列在最终清理前发生切换；原始采集文件未删除，保留在 " + quarantinePath,
        };
      }

      var targetAfterQuarantine;
      try {
        targetAfterQuarantine = await readFileSnapshot(context.fs, context.targetPath);
      } catch (error) {
        return {
          sourceRetained: true,
          cleanupWarning: "最终清理前无法再次核验工程目录副本；原始采集文件未删除，保留在 " + quarantinePath,
        };
      }
      if (!sameFileSnapshot(context.targetSnapshot, targetAfterQuarantine)) {
        return {
          sourceRetained: true,
          cleanupWarning: "最终清理前工程目录副本身份已变化；原始采集文件未删除，保留在 " + quarantinePath,
        };
      }

      try {
        await unlinkFile(context.fs, quarantinePath);
        context.sourceDeleted = true;
        context.sourceQuarantinePath = "";
        if (!(await exists(context.fs, quarantinePath))) {
          return { sourceRetained: false, cleanupWarning: "" };
        }
        lastError = new Error("删除后临时清理路径仍存在");
      } catch (error) {
        if (isMissingError(error)) {
          context.sourceQuarantinePath = "";
          return {
            sourceRetained: false,
            cleanupWarning: "原始采集文件在最终清理时被外部移除，无法确认由插件删除",
          };
        }
        lastError = error;
      }
      return {
        sourceRetained: true,
        cleanupWarning: "最终文件已保存并链接，但原始采集文件暂未删除，保留在 " + quarantinePath + "：" + (lastError && (lastError.message || lastError) || "未知错误"),
      };
    }
    return {
      sourceRetained: true,
      cleanupWarning: "最终文件已保存并链接，但原始采集文件暂未删除：" + (lastError && (lastError.message || lastError) || "未知错误"),
    };
  }

  async function renameAndRelink(options) {
    var fs = options.fs;
    var project = options.project;
    var projectItem = options.projectItem;
    var sourcePath = options.sourcePath;
    var targetPath = options.targetPath;
    var targetName = options.targetName;
    var samePath = options.samePath;
    var delay = options.delay || wait;
    var originalName = String(projectItem.name || "");
    var context = {
      fs: fs,
      project: project,
      projectItem: projectItem,
      sourcePath: sourcePath,
      targetPath: targetPath,
      targetName: targetName,
      originalName: originalName,
      samePath: samePath,
      delay: delay,
      validate: options.validate,
      operationId: options.operationId || targetName,
      transferMode: "",
      fileRenamed: false,
      copyAttempted: false,
      fileCopied: false,
      sourceDeleted: false,
      sourceSnapshot: null,
      sourceDigest: "",
      targetDigest: "",
      targetSnapshot: null,
      sourceQuarantinePath: "",
      linkChanged: false,
      itemNameChanged: false,
      trackItemNames: [],
    };

    try {
      await validateContext(options.validate);
      ensureNameTransactionSupport(project, projectItem);
      context.trackItemNames = await captureTrackItemNames(options.trackItems);
      var currentMediaPath = await projectItem.getMediaFilePath();
      if (!samePath(currentMediaPath, sourcePath)) {
        throw new Error("Premiere 素材已不再指向候选源路径");
      }
      if (!(await exists(fs, sourcePath))) throw new Error("源文件不存在");
      if (await exists(fs, targetPath)) throw new Error("目标文件已存在");

      notifyStage(options.onStage, "rename");
      var canChange = await projectItem.canChangeMediaPath();
      if (!canChange) throw new Error("Premiere 不允许修改此素材的媒体路径");

      await validateContext(options.validate);
      await transferFile(context);

      await validateContext(options.validate);
      notifyStage(options.onStage, "relink");
      await relinkMedia({ projectItem: projectItem, targetPath: targetPath, samePath: samePath,
        delay: delay, validate: options.validate, forceChange: true,
        onPathChanged: function () { context.linkChanged = true; } });

      await validateContext(options.validate);
      var targetTrackItemNames = context.trackItemNames.map(function (entry) {
        return { trackItem: entry.trackItem, name: targetName };
      });
      if (!setProjectAndTrackItemNames(project, projectItem, targetName, targetTrackItemNames, "同步录音素材和时间线片段名")) {
        throw new Error("Premiere 素材和时间线片段名称事务返回失败");
      }
      context.itemNameChanged = true;
      if (!(await waitForVerifiedName(projectItem, targetName, delay))) {
        throw new Error("Premiere 素材名验证失败");
      }
      if (!(await waitForVerifiedTrackItemNames(targetTrackItemNames, delay))) {
        throw new Error("Premiere 时间线片段名验证失败");
      }

      await validateContext(options.validate);

      var cleanup = context.fileCopied
        ? await cleanupCopiedSource(context)
        : { sourceRetained: false, cleanupWarning: "" };

      return {
        sourcePath: sourcePath,
        targetPath: targetPath,
        targetName: targetName,
        originalName: originalName,
        transferMode: context.transferMode,
        sourceRetained: cleanup.sourceRetained,
        cleanupWarning: cleanup.cleanupWarning,
      };
    } catch (error) {
      var rollbackWarnings = await bestEffortRollback(context);
      var wrapped = new Error(error && error.message ? error.message : String(error));
      wrapped.cause = error;
      if (error && error.code) wrapped.code = error.code;
      wrapped.rollbackWarnings = rollbackWarnings;
      throw wrapped;
    }
  }

  return {
    exists: exists,
    hashFile: hashFile,
    relinkMedia: relinkMedia,
    verifyMediaLink: waitForVerifiedLink,
    isTargetConflict: isTargetConflict,
    renameAndRelink: renameAndRelink,
    synchronizeNames: synchronizeNames,
    setProjectItemName: setProjectItemName,
  };
});
