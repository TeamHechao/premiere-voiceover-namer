import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginDirectory = path.join(projectRoot, "plugin");
const sourceDirectory = path.join(projectRoot, "src");
const distDirectory = path.resolve(projectRoot, "dist");

if (path.dirname(distDirectory) !== projectRoot || path.basename(distDirectory) !== "dist") {
  throw new Error(`Refusing to replace unexpected path: ${distDirectory}`);
}

await rm(distDirectory, { recursive: true, force: true });
await mkdir(path.join(distDirectory, "src"), { recursive: true });
await cp(pluginDirectory, distDirectory, { recursive: true });

for (const fileName of ["core.js", "state.js", "panel-state.js", "folder-readiness.js", "media-candidates.js", "monitoring-policy.js", "sha256.js", "transaction.js", "coordination.js", "recycle-auth.js", "recycle-policy.js", "recycle-host.js", "recycle.js", "media-conflicts.js", "media-rename.js", "media-panel.js", "main.js"]) {
  await copyFile(path.join(sourceDirectory, fileName), path.join(distDirectory, "src", fileName));
}

await cp(path.join(projectRoot, "native"), path.join(distDirectory, "native"), { recursive: true });
if (process.platform === "win32") {
  const compiler = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  await promisify(execFile)(compiler, ["/nologo", "/codepage:65001", "/optimize+", "/target:winexe", "/r:System.Web.Extensions.dll",
    `/out:${path.join(distDirectory, "native", "windows", "RecycleHelper.exe")}`,
    path.join(projectRoot, "native", "windows", "RecycleHelper.cs")]);
}

console.log(`Built UXP plugin: ${distDirectory}`);
