import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'win32') throw new Error('Windows 完整安装包需要在 Windows 编译原生助手。');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'outputs/windows');
const name = `premiere-voiceover-namer-${version}-windows`;
const directory = path.join(output, name);
const zip = directory + '.zip';
if (path.dirname(directory) !== output || !name.startsWith('premiere-voiceover-namer-')) throw new Error('拒绝不明确的打包目录');
await readFile(path.join(root, 'dist/native/windows/RecycleHelper.exe'));
await mkdir(output, { recursive: true });
await rm(directory, { recursive: true, force: true });
await rm(zip, { force: true });
await mkdir(directory);
await cp(path.join(root, 'dist'), path.join(directory, 'plugin'), { recursive: true, filter: source => path.basename(source) !== '.bridge' });
for (const file of ['install-user-plugin.ps1', 'uninstall-user-plugin.ps1', 'configure-recycle-bridge.ps1']) {
  await cp(path.join(root, 'scripts', file), path.join(directory, file));
}
await writeFile(path.join(directory, '安装.cmd'), '@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-user-plugin.ps1" -BuildPath "%~dp0plugin"\r\npause\r\n');
await writeFile(path.join(directory, '卸载.cmd'), '@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-user-plugin.ps1"\r\npause\r\n');
await cp(path.join(root, 'docs/录音响应与回收开发状态.md'), path.join(directory, '回收机制与限制.md'));
await writeFile(path.join(directory, '使用说明.md'), `# 赫朝录音命名器 ${version}\n\n先退出 Premiere，再运行“安装.cmd”。插件和 Windows 回收助手会一起安装，不需要 Node.js、Adobe 开发者账号或单独启动助手。首次调用助手可能出现系统或 UXP 确认。\n\n仅本版本新录制、成功命名并签名登记的录音参与回收。最后一处时间线引用消失后留出至少 30 秒缓冲，再确认全部序列无引用，才送进系统回收站。普通素材、旧录音和仅凭 UUID 命名的文件不会纳入。删除项目面板素材项也走同样检查。\n\n暂停自动命名会同时暂停后续回收提交；错误可用面板“刷新项目”重新检查。回收完成后，Premiere 的撤销不能还原磁盘文件，需要先从系统回收站还原。\n\nWindows 本地固定磁盘可用；网络盘、可移动卷、链接目录或无法确认回收能力的卷会保留文件。Mac 回收尚未启用。助手不设开机自启、计划任务或网络服务。\n\n当前原生助手已用合成 WAV 验证真实回收站；Premiere 原生录音、删除与面板联动仍需在临时工程验收。\n`);
await appendFile(path.join(directory, '使用说明.md'), '\n' + await readFile(path.join(root, 'docs/同名素材整理.md'), 'utf8'));
async function inventory(dir, prefix = '') {
  const entries = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isDirectory()) entries.push(...await inventory(path.join(dir, item.name), relative + '/'));
    else if (item.isFile()) entries.push(relative);
    else throw new Error('安装包禁止链接文件');
  }
  return entries.sort();
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = await inventory(directory);
const sums = [];
for (const file of files) sums.push(`${hash(await readFile(path.join(directory, file)))}  ${file}`);
await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
const quote = value => `'${value.replaceAll("'", "''")}'`;
await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory(${quote(directory)}, ${quote(zip)}, [IO.Compression.CompressionLevel]::Optimal, $true)`], { windowsHide: true });
await writeFile(zip + '.sha256', `${hash(await readFile(zip))}  ${path.basename(zip)}\n`);
console.log(`Windows 一体安装包：${zip}，已覆盖 ${files.length} 个文件的 SHA-256。`);
