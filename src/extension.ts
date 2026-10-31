import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import SevenZipFactory from '7z-wasm';

type ArchiveFormat = 'zstd' | 'zip';

const FORMAT_EXT: Record<ArchiveFormat, string> = {
    zstd: '.drzst',
    zip: '.zip'
};

let sevenZipModule: any = null;

async function getSevenZip(): Promise<any> {
    if (sevenZipModule) { return sevenZipModule; }
    try {
        sevenZipModule = await SevenZipFactory();
        sevenZipModule.print = () => {};
        sevenZipModule.printErr = () => {};
        return sevenZipModule;
    } catch (err: any) {
        throw new Error(`7z-wasm 模块加载失败：${err.message}`);
    }
}

function refreshExplorer() {
    vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
}

function getOverwriteArg(): string {
    const mode = vscode.workspace.getConfiguration('drzst-extract').get<string>('overwriteMode', 'overwrite');
    switch (mode) {
        case 'rename': return '-aou';
        case 'skip': return '-aos';
        default: return '-aoa';
    }
}

function getDeleteSource(): boolean {
    return vscode.workspace.getConfiguration('drzst-extract').get<boolean>('deleteSource', true);
}

function getOverwriteMode(): string {
    return vscode.workspace.getConfiguration('drzst-extract').get<string>('overwriteMode', 'overwrite');
}

function isDirectory(mode: number): boolean {
    return (mode & 0o170000) === 0o040000;
}

/** 递归查找指定扩展名的所有文件 */
function findAllFilesByExtension(rootDir: string, extension: string): string[] {
    const result: string[] = [];
    const stack = [rootDir];
    const ext = extension.toLowerCase();
    while (stack.length) {
        const current = stack.pop()!;
        try {
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
                    result.push(fullPath);
                }
            }
        } catch { /* 忽略无权限目录 */ }
    }
    return result;
}

/** 处理“解压到同名文件夹”时的目录冲突 */
function resolveOutputDir(baseDir: string, overwriteMode: string): string | null {
    if (!fs.existsSync(baseDir)) { return baseDir; }
    if (overwriteMode === 'overwrite') { return baseDir; }
    if (overwriteMode === 'skip') { return null; }
    let counter = 1;
    let newDir = `${baseDir}_1`;
    while (fs.existsSync(newDir)) {
        counter++;
        newDir = `${baseDir}_${counter}`;
    }
    return newDir;
}

/** 单文件写入时的冲突处理（重命名在文件名末尾加 _1） */
function resolveSingleFilePath(targetDir: string, desiredName: string): string | null {
    const mode = getOverwriteMode();
    const originalPath = path.join(targetDir, desiredName);
    if (mode === 'overwrite') { return originalPath; }
    if (!fs.existsSync(originalPath)) { return originalPath; }
    if (mode === 'skip') { return null; }
    let counter = 1;
    let candidatePath = path.join(targetDir, `${desiredName}_${counter}`);
    while (fs.existsSync(candidatePath)) {
        counter++;
        candidatePath = path.join(targetDir, `${desiredName}_${counter}`);
    }
    return candidatePath;
}

function copyDirRecursive(sz: any, internalPath: string, realPath: string) {
    if (!fs.existsSync(realPath)) { fs.mkdirSync(realPath, { recursive: true }); }
    const entries: string[] = sz.FS.readdir(internalPath);
    for (const entry of entries) {
        if (entry === '.' || entry === '..') continue;
        const src = path.posix.join(internalPath, entry);
        const dest = path.join(realPath, entry);
        const stat = sz.FS.stat(src);
        if (isDirectory(stat.mode)) {
            copyDirRecursive(sz, src, dest);
        } else {
            const data = sz.FS.readFile(src);
            fs.writeFileSync(dest, data);
        }
    }
}

function removeDirRecursive(sz: any, internalPath: string) {
    try {
        const entries: string[] = sz.FS.readdir(internalPath);
        for (const entry of entries) {
            if (entry === '.' || entry === '..') continue;
            const full = path.posix.join(internalPath, entry);
            const stat = sz.FS.stat(full);
            if (isDirectory(stat.mode)) {
                removeDirRecursive(sz, full);
            } else {
                sz.FS.unlink(full);
            }
        }
        sz.FS.rmdir(internalPath);
    } catch (_) {}
}

/**
 * 核心解压逻辑
 * @param format 'zstd' 使用 -tzstd；'zip' 使用 -tzip
 */
async function extractSingleFile(
    archivePath: string,
    outputDir: string,
    deleteSource: boolean,
    format: ArchiveFormat = 'zstd'
): Promise<void> {
    const sz = await getSevenZip();

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const archiveBuffer = await fs.promises.readFile(archivePath);
    const wasmArchiveName = format === 'zip' ? 'input.zip' : 'input.drzst';
    sz.FS.writeFile(wasmArchiveName, new Uint8Array(archiveBuffer));

    const internalOut = '/out';
    sz.FS.mkdir(internalOut);

    const overwriteArg = getOverwriteArg();
    const formatArg = format === 'zip' ? '-tzip' : '-tzstd';
    const args = ['x', wasmArchiveName, formatArg, `-o${internalOut}`, overwriteArg, '-y'];

    try {
        sz.callMain(args);
    } catch (err: any) {
        try { sz.FS.unlink(wasmArchiveName); } catch (_) {}
        try { removeDirRecursive(sz, internalOut); } catch (_) {}
        throw new Error(`解压失败：${err.message}`);
    }

    let entries: string[] = [];
    try {
        const raw = sz.FS.readdir(internalOut);
        entries = raw.filter((e: string) => e !== '.' && e !== '..');
    } catch (e) {}

    if (entries.length === 0) {
        try { sz.FS.unlink(wasmArchiveName); } catch (_) {}
        try { removeDirRecursive(sz, internalOut); } catch (_) {}
        throw new Error('解压后没有生成任何文件。');
    }

    // 只有裸 zstd 单文件才会被命名为 "input"，需要重命名；zip 通常保留内部文件名。
    const needsRename = format === 'zstd' &&
        entries.length === 1 &&
        !isDirectory(sz.FS.stat(path.posix.join(internalOut, entries[0])).mode) &&
        entries[0] === 'input';

    const sourceBaseName = path.basename(archivePath, FORMAT_EXT[format]);

    if (needsRename) {
        const internalFilePath = path.posix.join(internalOut, 'input');
        const data = sz.FS.readFile(internalFilePath);
        const finalPath = resolveSingleFilePath(outputDir, sourceBaseName);
        if (finalPath !== null) {
            fs.mkdirSync(path.dirname(finalPath), { recursive: true });
            fs.writeFileSync(finalPath, data);
        }
    } else {
        for (const entry of entries) {
            const src = path.posix.join(internalOut, entry);
            const dest = path.join(outputDir, entry);
            const stat = sz.FS.stat(src);
            if (isDirectory(stat.mode)) {
                copyDirRecursive(sz, src, dest);
            } else {
                const data = sz.FS.readFile(src);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, data);
            }
        }
    }

    try {
        sz.FS.unlink(wasmArchiveName);
        removeDirRecursive(sz, internalOut);
    } catch (_) {}

    const realEntries = fs.readdirSync(outputDir).filter(e => e !== '.' && e !== '..');
    if (realEntries.length === 0) {
        throw new Error('文件未能成功写入目标目录。');
    }

    if (deleteSource) {
        await fs.promises.unlink(archivePath);
    }
}

/** 单文件解压命令的统一实现 */
async function performSingleExtract(
    uri: vscode.Uri,
    format: ArchiveFormat,
    toSameDir: boolean
): Promise<void> {
    if (!uri) {
        vscode.window.showErrorMessage('未获取到文件路径');
        return;
    }
    const filePath = uri.fsPath;
    const fileName = path.basename(filePath);
    let outputDir: string;

    if (toSameDir) {
        const baseName = path.basename(filePath, FORMAT_EXT[format]);
        const proposedDir = path.join(path.dirname(filePath), baseName);
        const resolved = resolveOutputDir(proposedDir, getOverwriteMode());
        if (resolved === null) {
            vscode.window.showInformationMessage(`跳过解压：同名文件夹已存在 (模式为 skip)`);
            return;
        }
        outputDir = resolved;
    } else {
        outputDir = path.dirname(filePath);
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `正在解压 ${fileName}...`,
        cancellable: false
    }, async () => {
        try {
            await extractSingleFile(filePath, outputDir, getDeleteSource(), format);
            vscode.window.showInformationMessage(`${fileName} 解压成功`);
        } catch (err: any) {
            vscode.window.showErrorMessage(err.message);
        }
    });
    refreshExplorer();
}

/** 批量解压命令的统一实现 */
async function performBatchExtract(
    clickedFolder: vscode.Uri,
    format: ArchiveFormat,
    toSameDir: boolean
): Promise<void> {
    if (!clickedFolder) {
        vscode.window.showErrorMessage('未获取到文件夹路径');
        return;
    }
    const rootDir = clickedFolder.fsPath;
    const files = findAllFilesByExtension(rootDir, FORMAT_EXT[format]);
    const formatLabel = format === 'zip' ? 'zip' : 'drzst';
    const destLabel = toSameDir ? '同名文件夹' : '当前位置';

    if (files.length === 0) {
        vscode.window.showInformationMessage(`未找到任何 .${formatLabel} 文件`);
        return;
    }

    const deleteSource = getDeleteSource();
    const overwriteMode = getOverwriteMode();
    let success = 0;
    let failed = 0;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `批量解压${formatLabel}到${destLabel}`,
        cancellable: false
    }, async (progress) => {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            progress.report({ message: `正在处理 ${i + 1}/${files.length}: ${path.basename(file)}` });
            try {
                let outputDir: string;
                if (toSameDir) {
                    const baseName = path.basename(file, FORMAT_EXT[format]);
                    const proposedDir = path.join(path.dirname(file), baseName);
                    const resolved = resolveOutputDir(proposedDir, overwriteMode);
                    if (resolved === null) {
                        success++;
                        continue;
                    }
                    outputDir = resolved;
                } else {
                    outputDir = path.dirname(file);
                }
                await extractSingleFile(file, outputDir, deleteSource, format);
                success++;
            } catch (err: any) {
                failed++;
                console.error(`解压 ${file} 失败: ${err.message}`);
            }
        }
    });

    vscode.window.showInformationMessage(
        `批量解压${formatLabel}完成：成功 ${success} 个，失败 ${failed} 个`
    );
    refreshExplorer();
}

export function activate(context: vscode.ExtensionContext) {
    // ---------- 单文件：drzst ----------
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.extractToCurrent', (uri: vscode.Uri) =>
            performSingleExtract(uri, 'zstd', false)
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.extractToSameDir', (uri: vscode.Uri) =>
            performSingleExtract(uri, 'zstd', true)
        )
    );

    // ---------- 单文件：zip ----------
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.extractZipToCurrent', (uri: vscode.Uri) =>
            performSingleExtract(uri, 'zip', false)
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.extractZipToSameDir', (uri: vscode.Uri) =>
            performSingleExtract(uri, 'zip', true)
        )
    );

    // ---------- 批量：drzst ----------
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.batchExtractToCurrent', (uri: vscode.Uri) =>
            performBatchExtract(uri, 'zstd', false)
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.batchExtractToSameDir', (uri: vscode.Uri) =>
            performBatchExtract(uri, 'zstd', true)
        )
    );

    // ---------- 批量：zip ----------
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.batchExtractZipToCurrent', (uri: vscode.Uri) =>
            performBatchExtract(uri, 'zip', false)
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.batchExtractZipToSameDir', (uri: vscode.Uri) =>
            performBatchExtract(uri, 'zip', true)
        )
    );
}

export function deactivate() {}