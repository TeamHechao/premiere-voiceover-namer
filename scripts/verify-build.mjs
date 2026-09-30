import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDirectory = path.join(projectRoot, "dist");

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function digest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const manifestPath = path.join(distDirectory, "manifest.json");
assert.equal(await exists(manifestPath), true, "dist/manifest.json is missing");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
assert.equal(manifest.manifestVersion, 5);
assert.equal(manifest.host.app, "premierepro");
assert.equal(manifest.host.minVersion, "25.6.0");
assert.equal(manifest.requiredPermissions.localFileSystem, "fullAccess");
assert.equal(manifest.entrypoints[0].id, "voiceoverNamer");
assert.equal(manifest.version, packageJson.version, "manifest and package versions differ");

const requiredFiles = [
  "index.html",
  "styles.css",
  "icons/dark.svg",
  "icons/light.svg",
  "icons/chevron-right.svg",
  "icons/refresh-cw.svg",
  "icons/trash-2.svg",
  "icons/lucide-LICENSE.txt",
  "src/core.js",
  "src/state.js",
  "src/panel-state.js",
  "src/folder-readiness.js",
  "src/media-candidates.js",
  "src/monitoring-policy.js",
  "src/sha256.js",
  "src/transaction.js",
  "src/coordination.js",
  "src/recycle-policy.js",
  "src/recycle-auth.js",
  "src/recycle-host.js",
  "src/recycle.js",
  "src/media-conflicts.js",
  "src/media-rename.js",
  "src/media-panel.js",
  "native/windows/RecycleHelper.cs",
  "src/main.js",
];

for (const relativePath of requiredFiles) {
  assert.equal(await exists(path.join(distDirectory, relativePath)), true, `${relativePath} is missing`);
}

for (const fileName of ["core.js", "state.js", "panel-state.js", "folder-readiness.js", "media-candidates.js", "monitoring-policy.js", "sha256.js", "transaction.js", "coordination.js", "recycle-auth.js", "recycle-policy.js", "recycle-host.js", "recycle.js", "media-conflicts.js", "media-rename.js", "media-panel.js", "main.js"]) {
  const sourceHash = await digest(path.join(projectRoot, "src", fileName));
  const outputHash = await digest(path.join(distDirectory, "src", fileName));
  assert.equal(outputHash, sourceHash, `dist/src/${fileName} differs from source`);
}

for (const relativePath of ["manifest.json", "index.html", "styles.css", "icons/dark.svg", "icons/light.svg", "icons/chevron-right.svg", "icons/refresh-cw.svg", "icons/trash-2.svg", "icons/lucide-LICENSE.txt"]) {
  const sourceHash = await digest(path.join(projectRoot, "plugin", relativePath));
  const outputHash = await digest(path.join(distDirectory, relativePath));
  assert.equal(outputHash, sourceHash, `dist/${relativePath} differs from plugin source`);
}

const html = await readFile(path.join(distDirectory, "index.html"), "utf8");
const styles = await readFile(path.join(distDirectory, "styles.css"), "utf8");
const mainSource = await readFile(path.join(distDirectory, "src", "main.js"), "utf8");
const coreSource = await readFile(path.join(distDirectory, "src", "core.js"), "utf8");
let previousScriptIndex = -1;
for (const scriptPath of ["src/core.js", "src/state.js", "src/panel-state.js", "src/folder-readiness.js", "src/media-candidates.js", "src/monitoring-policy.js", "src/sha256.js", "src/transaction.js", "src/coordination.js", "src/recycle-auth.js", "src/recycle-policy.js", "src/recycle-host.js", "src/recycle.js", "src/media-conflicts.js", "src/media-rename.js", "src/media-panel.js", "src/main.js"]) {
  assert.match(html, new RegExp(`<script\\s+src=["']${scriptPath.replace(".", "\\.")}["']`));
  const scriptIndex = html.indexOf(`src="${scriptPath}"`);
  assert.ok(scriptIndex > previousScriptIndex, `${scriptPath} is loaded out of order`);
  previousScriptIndex = scriptIndex;
}

const requiredElementIds = [
  "panelMain",
  "monitorStatus",
  "monitorStatusText",
  "stateTitle",
  "stateDescription",
  "recordingDetailsButton",
  "recordingDetails",
  "connectionDetailsButton",
  "connectionDetails",
  "startButton",
  "stopButton",
  "scanButton",
  "mediaButton",
  "mediaDialog",
  "mediaDialogCount",
  "mediaScope",
  "mediaPreview",
  "closeMediaButton",
  "cancelMediaButton",
  "confirmMediaButton",
  "refreshButton",
  "readinessCount",
  "readinessProject",
  "readinessFolder",
  "readinessSequence",
  "projectName",
  "watchFolder",
  "sequenceName",
  "chooseFolderButton",
  "pipelineSummary",
  "pipelineFound",
  "pipelineStable",
  "pipelineRename",
  "pipelineRelink",
  "previewCaption",
  "previewSourceName",
  "previewTargetName",
  "processedCount",
  "pendingCount",
  "errorCount",
  "activityLog",
  "clearLogButton",
  "scanDialog",
  "scanDialogCount",
  "scanPreview",
  "closeScanButton",
  "cancelScanButton",
  "confirmScanButton",
];

for (const id of requiredElementIds) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `Required UI element #${id} is missing`);
}

const referencedElementIds = [...mainSource.matchAll(/element\("([^"]+)"\)/g)].map((match) => match[1]);
for (const id of new Set(referencedElementIds)) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `UI element #${id} is missing`);
}

assert.doesNotMatch(mainSource, /fs\.stat\s*\(/, "UXP exposes lstat, not Node fs.stat");
assert.doesNotMatch(mainSource, /require\(["']path["']\)/, "UXP path must not be loaded as a Node module");
assert.match(mainSource, /fs\.lstat\s*\(/, "file stability checks must use UXP fs.lstat");
assert.match(mainSource, /encoding:\s*["']utf-8["']/, "UXP text encoding must use utf-8");
assert.doesNotMatch(
  mainSource,
  /(?:\.\s*save|\[\s*["']save["']\s*\])\s*\(/,
  "recording processing must not save the full Premiere project",
);
assert.doesNotMatch(
  mainSource,
  /recordingCounter|maxManagedSequence|nextSequence/,
  "recording IDs must not depend on a shared or project-local counter",
);
assert.doesNotMatch(
  mainSource,
  /ProjectItem\.(?:TYPE_BIN|TYPE_ROOT)/,
  "project-bin traversal must not depend on undocumented ProjectItem type constants",
);
assert.match(coreSource, /randomUUID|getRandomValues/, "secure recording ID generation is missing");
assert.doesNotMatch(coreSource, /Math\.random|Date\.now/, "recording IDs must fail closed instead of using weak randomness");
assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, "reduced-motion handling is missing");
assert.doesNotMatch(styles, /transition:\s*all\b/, "UI transitions must target specific properties");
assert.doesNotMatch(styles, /(?:linear|radial)-gradient\(/, "the restrained Premiere panel must not use decorative gradients");
assert.doesNotMatch(html, /<sp-(?:button|checkbox)\b/i, "UXP controls must use native HTML elements");
assert.doesNotMatch(styles, /display:\s*grid\b/, "Premiere panel layout must use the UXP-stable flex/block subset");

const topLevel = (await readdir(distDirectory)).sort();
assert.deepEqual(topLevel, ["icons", "index.html", "manifest.json", "native", "src", "styles.css"]);
assert.equal(await digest(path.join(projectRoot, "native/windows/RecycleHelper.cs")), await digest(path.join(distDirectory, "native/windows/RecycleHelper.cs")));
if (process.platform === "win32") assert.equal(await exists(path.join(distDirectory, "native/windows/RecycleHelper.exe")), true);

console.log("Verified UXP build: manifest, files, script order, and source hashes are valid.");
