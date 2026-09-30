import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginRoot = path.join(projectRoot, "plugin");
const defaultPort = Number(process.env.PANEL_PREVIEW_PORT || 4174);

const previewStates = new Set([
  "disconnected",
  "unsaved",
  "no-sequence",
  "ready",
  "starting",
  "listening",
  "paused",
  "scanning",
  "processing",
  "loading",
  "error",
]);
const previewStages = new Set(["found", "stable", "rename", "relink"]);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function normalizePreviewState(value) {
  return typeof value === "string" && previewStates.has(value) ? value : "ready";
}

export function normalizePreviewStage(value) {
  return typeof value === "string" && previewStages.has(value) ? value : "relink";
}

export function createPreviewScenario(requestedState, requestedStage) {
  const state = normalizePreviewState(requestedState);
  const stage = normalizePreviewStage(requestedStage);
  const ready = {
    hasProject: true,
    projectSaved: true,
    hasSequence: true,
  };
  const inputs = {
    disconnected: {},
    unsaved: { hasProject: true, projectSaved: false, hasSequence: true },
    "no-sequence": { ...ready, hasSequence: false },
    ready,
    starting: { ...ready, starting: true },
    listening: { ...ready, monitoring: true },
    paused: { ...ready, paused: true },
    scanning: { ...ready, scanning: true },
    processing: { ...ready, monitoring: true, processing: true },
    loading: { refreshing: true },
    error: {
      ...ready,
      monitoring: true,
      errorMessage: "Premiere 重链接返回失败，原文件已恢复。",
    },
  };

  const hasFolder = !["disconnected", "unsaved", "loading"].includes(state);
  const job = state === "processing"
    ? { stage, sourceName: "音频 2_1.wav", targetName: "318最终版-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav" }
    : state === "error"
      ? {
          stage: "error",
          errorStage: stage,
          sourceName: "音频 2_1.wav",
          targetName: "318最终版-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav",
        }
      : null;

  return {
    state,
    input: inputs[state],
    projectName: state === "disconnected" ? "未打开工程" : state === "loading" ? "正在读取" : "318最终版.prproj",
    folderPath: hasFolder ? "D:\\318最终版\\Adobe Premiere Pro Captured and Generated" : "",
    sequenceName: state === "disconnected" || state === "loading" || state === "no-sequence" ? "未打开序列" : "主时间线",
    job,
    metrics: {
      processed: state === "disconnected" || state === "loading" ? 0 : 12,
      pending: state === "processing" ? 1 : 0,
      errors: state === "error" ? 1 : 0,
    },
  };
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function previewBootstrap(requestedState, requestedStage) {
  const scenario = createPreviewScenario(requestedState, requestedStage);
  return `
    <script>
      (function () {
        "use strict";
        var scenario = ${serializeForInlineScript(scenario)};
        var stateApi = globalThis.VoiceoverNamerPanelState;
        var view = stateApi.derivePanelState(scenario.input);
        var pipeline = stateApi.derivePipeline(scenario.job || {});

        function node(id) { return document.getElementById(id); }
        function text(id, value) {
          var target = node(id);
          if (target) target.textContent = String(value);
        }
        function disabled(id, value) {
          var target = node(id);
          if (!target) return;
          if (value) target.setAttribute("disabled", "");
          else target.removeAttribute("disabled");
        }

        node("panelMain").setAttribute("data-panel-state", view.mode);
        node("panelMain").setAttribute("aria-busy", view.busy ? "true" : "false");
        node("monitorStatus").className = "monitor-status monitor-status--" + view.tone;
        text("monitorStatusText", view.statusLabel);
        text("stateTitle", view.title);
        text("stateDescription", view.description);

        var readinessRows = [
          ["readinessProject", view.readiness.project, "工程已保存"],
          ["readinessSequence", view.readiness.sequence, "序列已打开"],
        ];
        readinessRows.forEach(function (entry) {
          node(entry[0]).setAttribute("data-ready", entry[1] ? "true" : "false");
          node(entry[0]).setAttribute("aria-label", entry[2] + "：" + (entry[1] ? "已完成" : "未完成"));
        });
        node("readinessFolder").setAttribute("data-ready", scenario.folderPath ? "true" : "false");

        var projectValue = scenario.projectName;
        if (scenario.state === "unsaved") projectValue += " · 尚未保存";
        var folderValue = scenario.folderPath || "保存工程后自动确定";
        text("projectName", projectValue);
        text("watchFolder", folderValue);
        text("sequenceName", scenario.sequenceName);
        text("readinessCount", view.readiness.completed === 2 ? projectValue : view.readiness.completed + "/2 已完成");

        function disclosure(id, open) {
          var button = node(id);
          node(button.getAttribute("aria-controls")).hidden = !open;
          button.setAttribute("aria-expanded", open ? "true" : "false");
        }
        ["recordingDetailsButton", "connectionDetailsButton"].forEach(function (id) {
          node(id).addEventListener("click", function () {
            disclosure(id, node(id).getAttribute("aria-expanded") !== "true");
          });
        });
        if (["disconnected", "unsaved", "no-sequence"].indexOf(view.mode) >= 0) disclosure("connectionDetailsButton", true);
        if (view.mode === "error") disclosure("recordingDetailsButton", true);
        node("clearLogButton").addEventListener("click", function () {
          node("activityLog").textContent = "";
          var empty = document.createElement("li");
          empty.className = "activity-empty";
          empty.textContent = "暂无记录";
          node("activityLog").appendChild(empty);
        });

        var start = node("startButton");
        var stop = node("stopButton");
        start.hidden = !view.primaryAction;
        stop.hidden = !view.showStop;
        text("startButton", view.primaryLabel || "立即启用");
        disabled("startButton", view.busy || !view.primaryAction);
        disabled("stopButton", scenario.input.monitoring !== true);
        disabled("scanButton", view.busy || view.readiness.completed !== 2);
        disabled("mediaButton", view.busy || scenario.input.hasProject !== true || scenario.input.projectSaved !== true);
        disabled(
          "chooseFolderButton",
          scenario.input.monitoring === true || view.busy || scenario.input.hasProject !== true || scenario.input.projectSaved !== true
        );
        disabled("refreshButton", view.busy || (scenario.input.monitoring === true && !scenario.input.errorMessage));
        node("refreshButton").title = scenario.input.monitoring === true ? "重新检查" : "刷新项目";
        node("refreshButton").setAttribute("aria-label", node("refreshButton").title);

        var pipelineIds = ["pipelineFound", "pipelineStable", "pipelineRename", "pipelineRelink"];
        var statusLabels = { waiting: "等待", active: "正在进行", done: "已完成", error: "失败", skipped: "已跳过" };
        pipeline.forEach(function (entry, index) {
          var item = node(pipelineIds[index]);
          item.className = "pipeline-step pipeline-step--" + entry.status;
          item.setAttribute("aria-label", entry.name + "：" + statusLabels[entry.status]);
          if (entry.status === "active") item.setAttribute("aria-current", "step");
          else item.removeAttribute("aria-current");
          item.querySelector(".pipeline-marker").textContent = entry.status === "done"
            ? "✓"
            : entry.status === "error"
              ? "!"
              : entry.status === "skipped"
                ? "−"
                : String(index + 1);
        });

        var summaries = {
          found: "已发现新 WAV",
          stable: "等待文件写入完成",
          rename: "正在移入工程媒体目录并命名",
          relink: "正在更新 Premiere 链接",
          error: "处理失败",
        };
        var pipelineSummary = scenario.job
          ? summaries[scenario.job.stage] || "处理失败"
          : scenario.input.monitoring
            ? "等待新录音"
            : view.readiness.completed === 2
              ? "正在自动布防"
              : "等待准备完成";
        text("pipelineSummary", pipelineSummary);
        text("previewCaption", scenario.state === "processing" ? "当前录音" : scenario.state === "error" ? "失败录音" : "命名示例");
        text("previewSourceName", scenario.job ? scenario.job.sourceName : "音频 2_1.wav");
        text("previewTargetName", scenario.job ? scenario.job.targetName : "318最终版-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav");
        text("processedCount", scenario.metrics.processed);
        text("pendingCount", scenario.metrics.pending);
        text("errorCount", scenario.metrics.errors);

        if (["listening", "processing", "paused", "error"].indexOf(scenario.state) >= 0) {
          node("activityLog").textContent = "";
          for (var logIndex = 0; logIndex < 20; logIndex += 1) {
            var logRow = document.createElement("li");
            logRow.className = "activity-item activity-item--ok";
            var logTime = document.createElement("span");
            logTime.className = "activity-time";
            logTime.textContent = "14:30:12";
            logRow.appendChild(logTime);
            logRow.appendChild(document.createTextNode("已完成：318最终版-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav"));
            node("activityLog").appendChild(logRow);
          }
        }

        ["media", "scan"].forEach(function (kind) {
          var dialog = node(kind + "Dialog");
          node(kind + "Button").addEventListener("click", function () {
            text(kind + "DialogCount", "1 组同名 · 可改 8 个文件 · 跳过 0 个");
            if (kind === "media") text("mediaScope", "已检查项目面板 3 个素材箱中的 168 个文件，跳过 7 个序列、6 个非媒体条目。");
            var list = node(kind === "media" ? "mediaPreview" : "scanPreview");
            list.textContent = "";
            for (var index = 0; index < 8; index += 1) {
              var row = document.createElement("div");
              row.className = "preview-row";
              var source = document.createElement("div");
              source.className = "preview-source";
              source.textContent = "示例素材/片头/S00" + (index + 1) + "/彩色片段.mp4";
              var target = document.createElement("div");
              target.className = "preview-target";
              target.textContent = "彩色片段-素材_7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.mp4";
              row.appendChild(source); row.appendChild(target); list.appendChild(row);
            }
            var confirm = node("confirm" + (kind === "media" ? "Media" : "Scan") + "Button");
            confirm.hidden = false;
            confirm.disabled = true;
            confirm.textContent = "确认改名 8 个文件";
            dialog.showModal();
          });
          ["cancel", "close"].forEach(function (action) {
            node(action + (kind === "media" ? "Media" : "Scan") + "Button").addEventListener("click", function () { dialog.close(); });
          });
        });
      })();
    </script>`;
}

export async function renderIndex(requestedState, requestedStage) {
  var html = await readFile(path.join(pluginRoot, "index.html"), "utf8");
  html = html.replace(/\s*<script\s+src="src\/([^"]+)"><\/script>/g, function (tag, fileName) {
    return fileName === "panel-state.js" ? tag : "";
  });
  return html.replace("</body>", previewBootstrap(requestedState, requestedStage) + "\n  </body>");
}

export function startPreviewServer(port = defaultPort) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
        const html = await renderIndex(requestUrl.searchParams.get("state"), requestUrl.searchParams.get("stage"));
        response.writeHead(200, { "Content-Type": contentTypes[".html"], "Cache-Control": "no-store" });
        response.end(html);
        return;
      }

      const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
      const sourceAsset = relativePath.startsWith("src/");
      const assetRoot = sourceAsset ? path.join(projectRoot, "src") : pluginRoot;
      const assetRelativePath = sourceAsset ? relativePath.slice(4) : relativePath;
      const assetPath = path.resolve(assetRoot, assetRelativePath);
      if (assetPath !== assetRoot && !assetPath.startsWith(assetRoot + path.sep)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const content = await readFile(assetPath);
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(assetPath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(content);
    } catch (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const listeningPort = address && typeof address === "object" ? address.port : port;
    console.log(`Panel preview: http://127.0.0.1:${listeningPort}/?state=ready`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  startPreviewServer();
}
