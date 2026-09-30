import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = packageJson.version;
const outputRoot = path.resolve(process.env.MACOS_OUTPUT_DIR || path.join(projectRoot, "outputs", "macos"));
const packageName = `premiere-voiceover-namer-${version}-macos`;
const packageDirectory = path.join(outputRoot, packageName);
const distDirectory = path.join(projectRoot, "dist");
const zipPath = path.join(outputRoot, `${packageName}.zip`);
const zipShaPath = `${zipPath}.sha256`;

if (path.dirname(outputRoot) === outputRoot || outputRoot === projectRoot) {
  throw new Error(`拒绝使用过宽的 macOS 产物目录：${outputRoot}`);
}
const distStat = await stat(distDirectory).catch(() => null);
if (!distStat?.isDirectory()) throw new Error("找不到 dist，请先运行 npm run build。");

await mkdir(outputRoot, { recursive: true });
await rm(packageDirectory, { recursive: true, force: true });
await rm(zipPath, { force: true });
await rm(zipShaPath, { force: true });
await mkdir(packageDirectory, { recursive: true });
const bundledPluginDirectory = path.join(packageDirectory, "plugin");
await cp(distDirectory, bundledPluginDirectory, { recursive: true, filter: source => !["native", ".bridge"].includes(path.basename(source)) });
await cp(path.join(projectRoot, "scripts", "install-user-plugin-macos.sh"), path.join(packageDirectory, "安装-macOS.sh"));
await cp(path.join(projectRoot, "scripts", "uninstall-user-plugin-macos.sh"), path.join(packageDirectory, "卸载-macOS.sh"));
await chmod(path.join(packageDirectory, "安装-macOS.sh"), 0o755);
await chmod(path.join(packageDirectory, "卸载-macOS.sh"), 0o755);

const guide = `# 赫朝录音命名器 macOS 侧载包

版本：${version}

这是一个自包含的 macOS 个人安装包，内含 \`plugin/\` UXP 插件目录、安装脚本、卸载脚本和 SHA-256 清单。接收方不需要安装 Node.js 或 UXP Developer Tool。

## 安装

先完全退出 Premiere Pro，在当前目录执行：

\`bash "./安装-macOS.sh"\`

脚本会把 \`plugin/\` 安装到 \`~/Library/Application Support/Adobe/UXP/Plugins/External/com.hechao.premiere.voiceover-namer\`。这是本项目使用的个人侧载经验路径，不宣称为 Adobe 官方发布接口。如系统阻止执行权限，可先执行 \`chmod +x 安装-macOS.sh 卸载-macOS.sh\`。也可以设置 \`TARGET_ROOT\` 指向隔离测试目录；脚本会校验清单、临时副本和安装结果，并把旧版本移到可恢复备份。

## 安装前检查

- Premiere Pro 版本至少为 25.6.0。
- 本目录的 \`SHA256SUMS.txt\` 校验通过。
- 安装和卸载都必须在 Premiere Pro 完全退出后进行。
- 安装脚本会把旧版本移动到 \`~/Library/Application Support/Adobe/UXP/PluginBackups\`，失败时保留可恢复备份。

## 卸载

在当前目录执行 \`bash "./卸载-macOS.sh"\`。脚本只移动插件目录，不直接删除文件。

## 功能边界

本版本 Windows 新增的自动回收不在 Mac 包中启用；Mac 只保持命名、移动和重链接能力。不会用永久删除代替 macOS 垃圾桶。

插件在录音停止、Premiere 生成 WAV 后等待文件稳定，再把它移入与当前 \`.prproj\` 同级的 \`Adobe Premiere Pro Captured and Generated\` 文件夹，命名为“项目名-32位UUID.wav”，并同步 Premiere 素材名、媒体路径和时间线片段名。跨卷时会排他复制并分块核对 SHA-256，链接成功后才清理原始采集文件；任何不确定情况都会保留源文件并提示。它不会在每条录音后保存整个 \`.prproj\`。旧版创建的“录音”文件夹不会被自动移动或删除。macOS 外置卷权限、跨卷复制、真实录音、重链接和长时间连续录音仍需按项目验收清单验证。
`;
const mediaGuide = await readFile(path.join(projectRoot, "docs/同名素材整理.md"), "utf8");
await writeFile(path.join(packageDirectory, "使用说明.md"), guide + "\n\n" + mediaGuide, "utf8");

async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`macOS 包只允许普通文件和目录：${absolute}`);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const packageFiles = await filesUnder(packageDirectory);
const checksumLines = [];
for (const filePath of packageFiles) {
  const relative = path.relative(packageDirectory, filePath).replaceAll(path.sep, "/");
  if (relative === "SHA256SUMS.txt") continue;
  checksumLines.push(`${await sha256(filePath)}  ${relative}`);
}
await writeFile(path.join(packageDirectory, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`, "utf8");

async function createZip() {
  if (process.platform === "darwin") {
    await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", packageDirectory, zipPath]);
    return;
  }
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath ${quote(packageDirectory)} -DestinationPath ${quote(zipPath)} -Force`;
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    return;
  }
  await execFileAsync("zip", ["-q", "-r", zipPath, packageName], { cwd: outputRoot });
}

await createZip();
const zipHash = await sha256(zipPath);
await writeFile(zipShaPath, `${zipHash}  ${path.basename(zipPath)}\n`, "utf8");
console.log(`已生成 macOS 插件目录：${packageDirectory}`);
console.log(`已生成 macOS 插件压缩包：${zipPath}`);
console.log(`压缩包 SHA-256：${zipHash}`);
