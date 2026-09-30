(function (root, factory) {
  "use strict";
  var cjs = typeof module !== "undefined" && module.exports;
  var api = factory(cjs ? require("./core.js") : root.VoiceoverNamerCore,
    cjs ? require("./media-conflicts.js") : root.VoiceoverNamerMediaConflicts,
    cjs ? require("./media-rename.js") : root.VoiceoverNamerMediaRename);
  if (cjs) module.exports = api;
  else root.VoiceoverNamerMediaPanel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core, Conflicts, Rename) {
  "use strict";

  function mapping(plan) {
    return { source: plan.sourcePath, target: plan.targetPath, signature: plan.sourceSignature,
      references: plan.entry.refs.map(function (ref) {
        return { id: ref.id, name: ref.name, tracks: ref.tracks.map(function (track) { return { location: track.key, name: track.name }; }) };
      }) };
  }
  async function writeRecord(storage, folder, name, value) {
    var entry = await folder.createFile(name, { overwrite: false });
    var content = JSON.stringify(value, null, 2) + "\n";
    await entry.write(content, { format: storage.formats.utf8 });
    if (String(await entry.read({ format: storage.formats.utf8 })) !== content) throw new Error("命名记录写入后校验失败");
    return entry.nativePath;
  }

  // Each result is immutable and written separately. An interrupted process
  // leaves the original plan intact; it never truncates the only recovery map.
  async function executeBatch(options) {
    var fresh = await Conflicts.snapshot(options);
    var plans = Conflicts.revalidatePlans(options.plans, fresh);
    for (var plan of plans) await Rename.preflight(Object.assign({}, options, { plan: plan }));
    await options.validate();
    var folder = await options.createJournalFolder();
    var batchId = Core.createRecordingId(options.randomSource);
    var recordPath = await writeRecord(options.storage, folder, batchId + "-计划.json", {
      schema: 2, kind: "manual-media-rename", scope: "project-panel", project: options.project.path, createdAt: new Date().toISOString(),
      note: "项目面板素材原目录改名，不逐条改写时间线片段名称，不登记为自动回收录音。计划不代表已完成，请查看对应结果。",
      files: plans.map(mapping),
    });
    var results = [], stopped = false;
    for (var index = 0; index < plans.length; index += 1) {
      if (options.cancelled()) { stopped = true; break; }
      var current = plans[index], result;
      options.progress(index, plans.length, current);
      try {
        var renamed = await Rename.execute(Object.assign({}, options, { plan: current,
          beforeMove: async function (proof) {
            try {
              await writeRecord(options.storage, folder, batchId + "-" + String(index + 1).padStart(4, "0") + "-校验.json", {
                schema: 2, kind: "manual-media-rename-prepared", index: index,
                source: current.sourcePath, target: current.targetPath, fileProof: proof,
              });
            } catch (error) { error.code = "VOICEOVER_NAMER_JOURNAL_FAILED"; throw error; }
            if (options.beforeMove) await options.beforeMove(proof);
          },
          onStage: function (stage) { options.progress(index, plans.length, current, stage); },
        }));
        result = { index: index, source: current.sourcePath, target: current.targetPath, status: "completed", fileProof: renamed.fileProof };
      } catch (error) {
        result = { index: index, source: current.sourcePath, target: current.targetPath, status: "failed",
          message: error.message || String(error), rollbackWarnings: error.rollbackWarnings || [], recoveryPath: error.recoveryPath || "",
          needsRecovery: !!error.needsRecovery, pathsToCheck: error.pathsToCheck || [], fileProof: error.fileProof || null };
        if (result.needsRecovery || result.rollbackWarnings.length || error.code === "VOICEOVER_NAMER_CANCELLED" ||
            error.code === "VOICEOVER_NAMER_JOURNAL_FAILED") stopped = true;
      }
      results.push(result);
      options.onResult(result);
      try {
        await writeRecord(options.storage, folder, batchId + "-" + String(index + 1).padStart(4, "0") + "-结果.json", result);
      } catch (error) {
        result.journalWarning = "结果记录写入失败：" + (error.message || error);
        options.onResult(result);
        stopped = true;
      }
      if (stopped) break;
    }
    return { results: results, stopped: stopped, remaining: plans.length - results.length, recordPath: recordPath };
  }

  async function run(options) {
    options = Object.assign({}, options);
    var doc = options.document;
    function el(id) { return doc.getElementById(id); }
    var dialog = el("mediaDialog"), preview = el("mediaPreview"), confirm = el("confirmMediaButton"), cancel = el("cancelMediaButton");
    var busy = false, closed = false, stop = false, plan = null, work = Promise.resolve();
    var validate = options.validate;
    options.validate = async function () {
      if (closed) { var error = new Error("同名素材窗口已关闭"); error.code = "VOICEOVER_NAMER_CANCELLED"; throw error; }
      await validate();
    };
    function status(text) { el("mediaDialogCount").textContent = text; }
    function row(source, target, detail, warning) {
      var node = doc.createElement("div");
      node.className = "preview-row";
      for (var part of [["preview-source", source], [warning ? "preview-warning" : "preview-target", target], ["preview-detail", detail]]) {
        if (!part[1]) continue;
        var text = doc.createElement("div"); text.className = part[0]; text.textContent = part[1]; node.appendChild(text);
      }
      preview.appendChild(node);
    }
    function close() {
      if (busy) { stop = true; cancel.textContent = "处理完本条后停止"; cancel.disabled = true; return; }
      dialog.close("cancel");
    }
    function escape(event) { if (busy) { event.preventDefault(); close(); } }
    function renderPlan(value) {
      preview.textContent = "";
      status(value.groups + " 组同名 · 可改 " + value.plans.length + " 个文件 · 跳过 " + value.skipped.length + " 个");
      el("mediaScope").textContent = "已检查项目面板 " + value.folderCount + " 个素材箱中的 " + value.fileCount +
        " 个文件；跳过序列 " + value.skippedSequenceCount + " 项、非媒体条目 " + value.nonMediaItems.length + " 项。";
      value.blockers.forEach(function (reason) { row("无法完整确认引用", reason, "本次只预览，不执行改名。", true); });
      value.plans.forEach(function (entry) {
        var refs = entry.entry.refs;
        row(entry.sourcePath, "→ " + entry.targetName, refs.length + " 个项目面板素材项");
      });
      value.skipped.forEach(function (entry) { row(entry.path, "跳过：" + entry.reason, "", true); });
      value.nonMediaItems.forEach(function (entry) { row(entry.name, "跳过：" + entry.reason, entry.location); });
      if (!value.groups && !value.blockers.length) row("没有发现同名冲突", "无需修改", "仅比较文件名（含扩展名，不区分大小写），不按内容去重。");
      confirm.hidden = value.plans.length === 0 || value.blockers.length > 0;
      confirm.disabled = confirm.hidden;
      confirm.textContent = "确认改名 " + value.plans.length + " 个文件";
      cancel.textContent = "关闭";
    }
    async function apply() {
      if (busy || !plan || plan.blockers.length || !plan.plans.length) return;
      busy = true; confirm.disabled = true; cancel.textContent = "停止后续";
      preview.textContent = "";
      try {
        var outcome = await executeBatch(Object.assign({}, options, {
          plans: plan.plans,
          cancelled: function () { return stop || closed; },
          progress: function (index, count, current, stage) {
            var labels = { "verify-source": "校验原文件内容", rename: "改名", "verify-target": "校验改名结果", relink: "更新素材链接", rollback: "恢复本条素材" };
            status("正在" + (labels[stage] || "处理") + " " + (index + 1) + "/" + count + "，请等待当前文件完成");
          },
          onResult: function (result) {
            var okay = result.status === "completed";
            var detail = [result.journalWarning || ""].concat(result.rollbackWarnings || []).filter(Boolean).join("；");
            if (result.recoveryPath) detail += "；已验证的恢复文件：" + result.recoveryPath;
            if (result.needsRecovery && result.pathsToCheck.length) detail += "；需核对的位置：" + result.pathsToCheck.join("；");
            row(result.source, okay ? "已完成 → " + Core.fileNameFromPath(result.target) : "未完成：" + result.message,
              detail, !okay || !!result.journalWarning);
            options.onResult(result);
          },
        }));
        var count = outcome.results.filter(function (result) { return result.status === "completed"; }).length;
        var needsRecovery = outcome.results.some(function (result) { return result.needsRecovery || (result.rollbackWarnings || []).length; });
        var journalIncomplete = outcome.results.some(function (result) { return !!result.journalWarning; });
        status("完成 " + count + " 个 · 未完成 " + (outcome.results.length - count + outcome.remaining) + " 个");
        var guidance = needsRecovery ? "有文件未完整恢复。请先核对下方位置与媒体链接，暂勿保存或再次改名。" :
          journalIncomplete ? "结果记录未完整写入，已停止后续。请先核对已完成项的文件及链接。" :
          count ? "已完成项的文件、素材名与链接均已核对，请正常保存工程。" : "本次没有完成改名，原文件已保留或恢复。";
        el("mediaScope").textContent = guidance + "命名记录：" + outcome.recordPath;
        if (outcome.remaining) row("后续 " + outcome.remaining + " 个文件未改动",
          needsRecovery || journalIncomplete ? "已停止，请先核对恢复结果" : "已停止，可重新扫描", "", true);
      } catch (error) {
        status("本次整理已停止");
        el("mediaScope").textContent = "本次未能确认全部结果，请先核对命名记录和素材链接，再继续操作。";
        row("检查未通过", error.message || String(error), "已停止后续处理。", true);
        options.log("error", "同名素材整理：" + (error.message || error));
      } finally {
        busy = false; confirm.hidden = true; cancel.disabled = false; cancel.textContent = "完成";
      }
    }
    function startApply() { if (!busy) work = apply(); }
    confirm.hidden = true; confirm.disabled = true; cancel.disabled = false; cancel.textContent = "关闭";
    preview.textContent = ""; status("正在扫描项目面板素材箱…");
    el("mediaScope").textContent = "检查期间暂缓自动录音处理；关闭后继续。";
    confirm.addEventListener("click", startApply);
    cancel.addEventListener("click", close);
    el("closeMediaButton").addEventListener("click", close);
    dialog.addEventListener("cancel", escape);
    var modal, scanning = Promise.resolve();
    try {
      if (typeof dialog.uxpShowModal === "function") {
        modal = dialog.uxpShowModal({ title: "整理同名素材", resize: "both", size: { width: 580, height: 620 }, minSize: { width: 340, height: 400 } });
      } else {
        modal = new Promise(function (resolve) { dialog.addEventListener("close", resolve, { once: true }); });
        dialog.showModal();
      }
      scanning = (async function () {
        try {
          var scanned = await Conflicts.snapshot(options);
          plan = await Conflicts.plan(Object.assign({}, options, { snapshot: scanned }));
          await options.validate();
          if (!closed) renderPlan(plan);
        } catch (error) {
          if (!closed) { status("扫描未完成，未修改任何文件"); row("无法完成检查", error.message || String(error), "", true); }
        }
      })();
      await modal;
    }
    finally {
      closed = true; stop = true;
      await scanning; await work;
      confirm.removeEventListener("click", startApply);
      cancel.removeEventListener("click", close);
      el("closeMediaButton").removeEventListener("click", close);
      dialog.removeEventListener("cancel", escape);
    }
  }
  return { run: run, executeBatch: executeBatch, mapping: mapping };
});
