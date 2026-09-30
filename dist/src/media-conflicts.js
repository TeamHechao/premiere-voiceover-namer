(function (root, factory) {
  "use strict";
  var api = factory(typeof module !== "undefined" && module.exports ? require("./core.js") : root.VoiceoverNamerCore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VoiceoverNamerMediaConflicts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  // Containers with external dependencies (PSD/AE/camera packages) need their
  // own relinking strategy. Do not treat them as ordinary single-file media.
  var SINGLE_FILE = /\.(mp4|mov|m4v|avi|mkv|webm|mpg|mpeg|wmv|wav|aif|aiff|mp3|m4a|aac|flac|ogg|wma|bmp|jpg|jpeg|png|tif|tiff|gif|webp)$/i;
  var IMAGE = /\.(bmp|jpg|jpeg|png|tif|tiff|gif|webp)$/i;
  var RENAMED = /-素材_[0-9a-f]{32}\.[^.]+$/i;

  function nameKey(path) {
    return Core.fileNameFromPath(path).normalize("NFC").toLowerCase();
  }
  function isRenamedName(path) { return RENAMED.test(Core.fileNameFromPath(path)); }
  function list(value) {
    if (!Array.isArray(value)) throw new Error("Premiere 未返回完整素材列表，未执行改名");
    return value;
  }
  function itemLocation(item, location) {
    var name = "";
    try { name = String(item && item.name || "").slice(0, 100); } catch (error) {}
    return (location || "工程素材") + (name ? "（" + name + "）" : "");
  }
  async function identity(item, location) {
    function fail(reason) {
      throw new Error("无法读取素材身份，未执行改名；位置：" + itemLocation(item, location) + "；原因：" + reason);
    }
    // Read the original ProjectItem returned by the project bin's getItems.
    // FolderItem is only a traversal view; the root is only a container.
    if (!item || typeof item.getId !== "function") fail("素材项未提供 getId 接口");
    var id;
    try { id = await item.getId(); }
    catch (error) { fail("读取 ID 失败：" + String(error && error.message || error).slice(0, 240)); }
    if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) id = String(id);
    if (typeof id !== "string") fail("ID 返回类型为 " + (id === null ? "null" : typeof id));
    if (!id.trim() || id === "undefined" || id === "null") fail("ID 为空或无效");
    return id;
  }
  async function bool(item, method) {
    if (typeof item[method] !== "function") throw new Error("宿主缺少 " + method + " 检查，无法安全整理");
    var value = await item[method]();
    if (value !== true && value !== false) throw new Error(method + " 未返回明确结果");
    return value;
  }
  function addReason(entry, reason) {
    if (entry.reasons.indexOf(reason) < 0) entry.reasons.push(reason);
  }

  async function snapshot(options) {
    var project = options.project, ppro = options.ppro;
    var validate = options.validate || async function () {};
    var sources = new Map(), refs = new Map(), folders = new Set(), folderViews = new Set();
    var proxyPaths = new Set(), blockers = [], nonMediaItems = [], ignored = 0, skippedSequenceCount = 0;

    async function media(raw, location) {
      await validate();
      var id = await identity(raw, location);
      if (refs.has(id)) return;
      var clip;
      try { clip = await ppro.ClipProjectItem.cast(raw); }
      catch (error) {
        throw new Error("读取媒体类型失败，未执行改名；位置：" + itemLocation(raw, location) +
          "；原因：" + String(error && error.message || error).slice(0, 240));
      }
      if (clip === null || clip === undefined) {
        // Project bins also contain StyleProjectItem and other non-clip
        // entries. An empty cast is not a failed media read. Do not infer
        // type from a localized name or make up numeric type constants.
        refs.set(id, null);
        nonMediaItems.push({ id: id, name: String(raw.name || "未命名项目条目"), location: location,
          reason: "非媒体项目条目，保留原样" });
        ignored += 1;
        return;
      }
      if (await bool(clip, "isSequence")) {
        refs.set(id, null);
        // Manual organization is scoped to the Project panel. A sequence is
        // not a disk file; do not expand its tracks or nested sequences here.
        skippedSequenceCount += 1;
        return;
      }
      var merged = await bool(clip, "isMergedClip");
      var multicam = await bool(clip, "isMulticamClip");
      if (merged || multicam) {
        // A hidden constituent could share any candidate source path.
        blockers.push("“" + String(raw.name || id) + "”包含无法完整枚举的合并/多机位源；请先在普通素材工程中整理");
      }
      var path = Core.plainNativePath(await clip.getMediaFilePath());
      if (!path) { refs.set(id, null); ignored += 1; return; }
      if (/\.aepx?$/i.test(path)) blockers.push("存在 AE 动态链接，无法核对合成内部使用的素材；请先在普通素材工程中整理");
      var key = Core.normalizePathForComparison(path);
      if (!sources.has(key)) sources.set(key, { key: key, path: path, name: Core.fileNameFromPath(path), refs: [], reasons: [] });
      var source = sources.get(key);
      var ref = { id: id, item: clip, name: String(clip.name || raw.name || ""), tracks: [] };
      refs.set(id, ref);
      source.refs.push(ref);
      if (merged || multicam) addReason(source, "合并或多机位素材");
      if (await bool(clip, "isOffline")) addReason(source, "素材离线：先核对原链接");
      if (await bool(clip, "hasProxy")) {
        addReason(source, "已附加代理：需要同时处理代理，暂不改名");
        var proxyPath = await clip.getProxyPath();
        if (!proxyPath) throw new Error("代理路径不可读，未执行改名");
        proxyPaths.add(Core.normalizePathForComparison(proxyPath));
      }
      if (!(await bool(clip, "canChangeMediaPath"))) addReason(source, "Premiere 不允许重链接此素材");
      if (!SINGLE_FILE.test(path)) addReason(source, "暂不支持此格式或素材包（需保留关联文件）");
      // Premiere 25.6 has no isImageSequence API. Numbered image paths are
      // ambiguous unless XMP explicitly describes a still image.
      if (IMAGE.test(path) && /\d$/.test(Core.stemOf(path))) {
        var still = false;
        if (ppro.Metadata && typeof ppro.Metadata.getXMPMetadata === "function") {
          try {
            var xmp = String(await ppro.Metadata.getXMPMetadata(raw));
            still = /(?:xmpDM:videoFrameRate\s*=\s*["']Still["']|<xmpDM:videoFrameRate>\s*Still\s*<\/xmpDM:videoFrameRate>)/i.test(xmp);
          } catch (error) { /* Unknown image interpretation stays protected. */ }
        }
        if (!still) addReason(source, "可能是图片序列，宿主未明确标记为静态图片");
      }
    }

    async function folder(parent, rawItem, location) {
      await validate();
      location = location || "工程根素材箱";
      if (!parent || typeof parent.getItems !== "function") throw new Error("无法读取素材箱内容，未执行改名；位置：" + location);
      if (folderViews.has(parent)) throw new Error("素材箱结构重复，未执行改名；位置：" + location);
      folderViews.add(parent);
      if (rawItem) {
        var id = await identity(rawItem, location);
        if (folders.has(id)) throw new Error("素材箱结构重复，未执行改名；位置：" + location);
        folders.add(id);
        location = itemLocation(rawItem, location);
      }
      var children = list(await parent.getItems());
      for (var index = 0; index < children.length; index += 1) {
        var raw = children[index], childLocation = location + " / 第 " + (index + 1) + " 项";
        var child = null;
        try { child = await ppro.FolderItem.cast(raw); } catch (error) { /* Clip, not bin. */ }
        if (child) await folder(child, raw, childLocation);
        else await media(raw, childLocation);
      }
    }
    await folder(await project.getRootItem());
    await validate();
    var entries = Array.from(sources.values());
    entries.forEach(function (entry) {
      if (proxyPaths.has(entry.key)) addReason(entry, "此文件同时被用作代理");
    });
    return { scope: "project-panel", entries: entries, blockers: blockers, nonMediaItems: nonMediaItems, ignored: ignored,
      folderCount: folderViews.size, skippedSequenceCount: skippedSequenceCount };
  }

  function signature(stat) {
    function time(ms, date) { return Number(stat[ms] || (stat[date] ? new Date(stat[date]).getTime() : 0)); }
    return {
      size: Number(stat.size), mtime: time("mtimeMs", "mtime"), ctime: time("ctimeMs", "ctime"),
      birthtime: time("birthtimeMs", "birthtime"), ino: String(stat.ino || ""), dev: String(stat.dev || ""),
    };
  }
  // A signature protects one unchanged path. It is not an identity proof
  // across moves: exFAT and UXP can change inode and birthtime when renaming.
  function sameSignature(a, b) {
    return !!a && !!b && a.size === b.size && a.mtime === b.mtime && a.birthtime === b.birthtime &&
      a.ino === b.ino && a.dev === b.dev && a.ctime === b.ctime;
  }
  async function statOrNull(fs, path) {
    try { return await fs.lstat(path); }
    catch (error) {
      if (error && (error.code === "ENOENT" || /no such file|cannot find|找不到指定的文件/i.test(String(error.message)))) return null;
      throw error;
    }
  }
  function isKnownLink(stat) {
    if (!stat) return false;
    if (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()) return true;
    if (stat.isSymbolicLink === true) return true;
    // UXP exposes only a subset of Node Stats. When available, the POSIX
    // file-type bits provide another positive indication of a link.
    return Number.isInteger(stat.mode) && (stat.mode & 0xf000) === 0xa000;
  }
  async function inspectFile(fs, path) {
    if (Core.nativePathPlatform(path) === "relative") throw new Error("素材不是本地绝对路径，未执行改名");
    var stat = await fs.lstat(path);
    if (!stat || typeof stat.isFile !== "function" || stat.isFile() !== true ||
        isKnownLink(stat)) throw new Error("只处理普通媒体文件，不处理链接或文件夹");
    if (!(Number(stat.size) > 0)) throw new Error("空文件或尚未完成写入");
    if (Number(stat.nlink || 1) > 1) throw new Error("文件存在硬链接，需先确认共享关系");
    var snapshotValue = signature(stat);
    if (!snapshotValue.mtime || Date.now() - snapshotValue.mtime < 3000) throw new Error("文件刚刚写入，请停止录制/导出并稍后重新扫描");
    // lstat type checks also cover parents. UXP may omit isSymbolicLink;
    // that omission alone is not evidence that an ordinary directory is a
    // link. Require a real directory result and reject any positive link flag.
    var dir = Core.splitNativePath(path).dir;
    while (dir && !/^[a-z]:$/i.test(dir)) {
      var parent = await fs.lstat(dir);
      if (isKnownLink(parent)) throw new Error("素材目录为链接，保留原文件：" + dir);
      if (!parent || typeof parent.isDirectory !== "function") throw new Error("无法读取素材目录类型：" + dir);
      if (parent.isDirectory() !== true) throw new Error("素材目录不是普通文件夹：" + dir);
      var next = Core.splitNativePath(dir).dir;
      if (next === dir) break;
      dir = next;
    }
    var parts = Core.splitNativePath(path);
    var sidecars = [Core.joinNativePath(parts.dir, Core.stemOf(path) + ".xmp", parts.separator), path + ".xmp",
      Core.joinNativePath(parts.dir, Core.stemOf(path) + ".XMP", parts.separator), path + ".XMP"];
    for (var sidecar of sidecars) {
      if (await statOrNull(fs, sidecar)) throw new Error("存在关联 XMP 文件，暂不拆分改名");
    }
    return snapshotValue;
  }
  function fingerprint(entry) {
    return JSON.stringify(entry.refs.map(function (ref) {
      return [ref.id, ref.name, ref.tracks.map(function (track) { return [track.key, track.name]; }).sort()];
    }).sort(function (a, b) { return a[0].localeCompare(b[0]); }));
  }
  function buildName(path, randomSource) {
    // The underscore deliberately separates general media from the recording
    // UUID pattern, including when a WAV sits in a capture directory.
    return Core.sanitizeSegment(Core.stemOf(path), "素材", 48) + "-素材_" + Core.createRecordingId(randomSource) + Core.extensionOf(path);
  }

  async function plan(options) {
    var snapshotValue = options.snapshot, fs = options.fs;
    var groups = new Map(), occupied = new Set(), plans = [], skipped = [];
    snapshotValue.entries.forEach(function (entry) {
      var key = nameKey(entry.path);
      occupied.add(key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    });
    var conflicts = Array.from(groups.values()).filter(function (group) { return group.length > 1; });
    for (var group of conflicts) {
      for (var entry of group) {
        if (options.validate) await options.validate();
        if (entry.reasons.length) { skipped.push({ path: entry.path, reason: entry.reasons.join("；") }); continue; }
        try {
          var protection = options.protect ? await options.protect(entry.path) : "";
          if (protection) throw new Error(protection);
          var sourceSignature = await inspectFile(fs, entry.path);
          var targetName = "", targetPath = "", parts = Core.splitNativePath(entry.path);
          for (var attempt = 0; attempt < 10; attempt += 1) {
            targetName = buildName(entry.path, options.randomSource);
            targetPath = Core.joinNativePath(parts.dir, targetName, parts.separator);
            if (!occupied.has(nameKey(targetName)) && !(await statOrNull(fs, targetPath))) break;
            targetPath = "";
          }
          if (!targetPath) throw new Error("无法分配未占用的新名称");
          occupied.add(nameKey(targetName));
          plans.push({ entry: entry, sourcePath: entry.path, targetPath: targetPath, targetName: targetName,
            sourceSignature: sourceSignature, fingerprint: fingerprint(entry) });
        } catch (error) {
          skipped.push({ path: entry.path, reason: error.message || String(error) });
        }
      }
    }
    return { plans: plans, skipped: skipped, groups: conflicts.length, blockers: snapshotValue.blockers.slice(),
      scope: snapshotValue.scope, nonMediaItems: snapshotValue.nonMediaItems.slice(),
      fileCount: snapshotValue.entries.length, folderCount: snapshotValue.folderCount,
      skippedSequenceCount: snapshotValue.skippedSequenceCount, ignored: snapshotValue.ignored };
  }

  function revalidatePlans(plans, fresh) {
    if (fresh.blockers.length) throw new Error(fresh.blockers.join("；"));
    var byPath = new Map(fresh.entries.map(function (entry) { return [entry.key, entry]; }));
    return plans.map(function (old) {
      var current = byPath.get(Core.normalizePathForComparison(old.sourcePath));
      if (!current || current.reasons.length || fingerprint(current) !== old.fingerprint) {
        throw new Error("预览后素材引用或名称发生变化，请重新扫描：" + Core.fileNameFromPath(old.sourcePath));
      }
      return Object.assign({}, old, { entry: current });
    });
  }
  return { snapshot: snapshot, plan: plan, revalidatePlans: revalidatePlans, signature: signature,
    sameSignature: sameSignature, statOrNull: statOrNull, inspectFile: inspectFile, fingerprint: fingerprint,
    isRenamedName: isRenamedName, nameKey: nameKey, isKnownLink: isKnownLink };
});
