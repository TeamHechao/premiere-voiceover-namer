(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VoiceoverNamerRecycleHost = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function list(value) {
    if (!Array.isArray(value)) throw new Error("回收检查未取得完整列表，保留录音");
    return value;
  }
  function itemLocation(item, location) {
    var name = "";
    try { name = String(item && item.name || "").slice(0, 100); } catch (error) {}
    return (location || "工程素材") + (name ? "（" + name + "）" : "");
  }
  async function identity(item, location) {
    function fail(reason) {
      throw new Error("素材身份不可读，保留录音；位置：" + itemLocation(item, location) + "；原因：" + reason);
    }
    if (!item || typeof item.getId !== "function") fail("素材项未提供 getId 接口");
    var id;
    try { id = await item.getId(); }
    catch (error) { fail("读取 ID 失败：" + String(error && error.message || error).slice(0, 240)); }
    if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) id = String(id);
    if (typeof id !== "string") fail("ID 返回类型为 " + (id === null ? "null" : typeof id));
    if (!id.trim() || id === "undefined" || id === "null") fail("ID 为空或无效");
    return id;
  }

  async function snapshot(project, ppro, normalize, validate) {
    var ids = new Set();
    var paths = new Set();
    var items = [];
    var visited = new Set();
    var folderIds = new Set();
    var folderViews = new Set();
    async function clipFor(raw) {
      var clip = await ppro.ClipProjectItem.cast(raw);
      if (!clip) throw new Error("无法读取素材类型，保留录音");
      return clip;
    }
    async function mediaPath(clip) {
      if (typeof clip.isMergedClip === "function" && await clip.isMergedClip()) {
        throw new Error("存在合并素材，无法完整证明底层引用，保留录音");
      }
      var path = await clip.getMediaFilePath();
      if (typeof path !== "string" || !path.trim()) throw new Error("存在源文件不可确认的素材，保留录音");
      return path;
    }
    async function sequence(seq) {
      await validate();
      if (!seq || !seq.guid) throw new Error("序列身份不可读，保留录音");
      var key = String(seq.guid);
      if (visited.has(key)) return;
      visited.add(key);
      for (var kind of ["Audio", "Video"]) {
        var count = await seq["get" + kind + "TrackCount"]();
        if (!Number.isInteger(count) || count < 0) throw new Error("轨道列表不完整，保留录音");
        for (var n = 0; n < count; n += 1) {
          var track = await seq["get" + kind + "Track"](n);
          var clips = list(await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
          for (var trackItem of clips) {
            var raw = await trackItem.getProjectItem();
            ids.add(await identity(raw, "序列 " + key + " / " + (kind === "Audio" ? "音轨 " : "视频轨 ") + (n + 1)));
            var clip = await clipFor(raw);
            if (await clip.isSequence()) {
              await sequence(await clip.getSequence());
            } else {
              paths.add(normalize(await mediaPath(clip)));
            }
          }
          await validate();
        }
      }
    }
    async function folder(parent, rawItem, location) {
      await validate();
      location = location || "工程根素材箱";
      if (!parent || typeof parent.getItems !== "function") throw new Error("无法读取素材箱内容，保留录音；位置：" + location);
      if (folderViews.has(parent)) throw new Error("项目文件夹结构重复，保留录音；位置：" + location);
      folderViews.add(parent);
      if (rawItem) {
        var key = await identity(rawItem, location);
        if (folderIds.has(key)) throw new Error("项目文件夹结构重复，保留录音；位置：" + location);
        folderIds.add(key);
        location = itemLocation(rawItem, location);
      }
      var children = list(await parent.getItems());
      for (var index = 0; index < children.length; index += 1) {
        var raw = children[index], childLocation = location + " / 第 " + (index + 1) + " 项";
        var child = null;
        try { child = await ppro.FolderItem.cast(raw); } catch (castError) { /* A media item is not a folder. */ }
        if (child) {
          await folder(child, raw, childLocation);
        } else {
          var id = await identity(raw, childLocation);
          var clip = await clipFor(raw);
          if (await clip.isSequence()) await sequence(await clip.getSequence());
          else items.push({ id: id, path: await mediaPath(clip), raw: raw, parent: parent });
        }
      }
      await validate();
    }
    var sequences = list(await project.getSequences());
    for (var seq of sequences) await sequence(seq);
    await folder(await project.getRootItem());
    await validate();
    return { complete: true, ids: ids, paths: paths, items: items };
  }

  async function removeUnusedItem(project, entry) {
    var result = false;
    await project.lockedAccess(function () {
      result = project.executeTransaction(function (compound) {
        compound.addAction(entry.parent.createRemoveItemAction(entry.raw));
      }, "回收已弃用录音的素材项");
    });
    if (await result !== true) throw new Error("录音已回收，但 Premiere 素材项移除失败");
  }
  return { snapshot: snapshot, removeUnusedItem: removeUnusedItem };
});
