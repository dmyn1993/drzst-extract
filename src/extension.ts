import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import SevenZipFactory from '7z-wasm';

let sevenZipModule: any = null;

async function getSevenZip(): Promise<any> {
    if (sevenZipModule) {
        return sevenZipModule;
    }
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
    const mode = vscode.workspace
        .getConfiguration('drzst-extract')
        .get<string>('overwriteMode', 'overwrite');
    switch (mode) {
        case 'rename': return '-aou';
        case 'skip': return '-aos';
        default: return '-aoa';
    }
}

function isDirectory(mode: number): boolean {
    return (mode & 0o170000) === 0o040000;
}

/**
 * 处理“解压到同名文件夹”时的目录冲突
 */
function resolveOutputDir(baseDir: string, overwriteMode: string): string | null {
    if (!fs.existsSync(baseDir)) {
        return baseDir;
    }

    if (overwriteMode === 'overwrite') {
        return baseDir;
    }

    if (overwriteMode === 'skip') {
        return null;
    }

    // rename 模式：生成新目录名
    let counter = 1;
    let newDir = `${baseDir}_1`;
    while (fs.existsSync(newDir)) {
        counter++;
        newDir = `${baseDir}_${counter}`;
    }
    return newDir;
}

/**
 * 根据用户设置解决单文件写入时的文件名冲突
 * @returns 最终路径，或 null（skip 时跳过）
 */
function resolveSingleFilePath(targetDir: string, desiredName: string): string | null {
    const mode = vscode.workspace
        .getConfiguration('drzst-extract')
        .get<string>('overwriteMode', 'overwrite');

    const originalPath = path.join(targetDir, desiredName);

    if (mode === 'overwrite') {
        return originalPath;
    }

    if (!fs.existsSync(originalPath)) {
        return originalPath;
    }

    if (mode === 'skip') {
        return null;
    }

    // rename 模式：在完整文件名末尾追加 _1, _2, ...
    let counter = 1;
    let candidatePath = path.join(targetDir, `${desiredName}_${counter}`);
    while (fs.existsSync(candidatePath)) {
        counter++;
        candidatePath = path.join(targetDir, `${desiredName}_${counter}`);
    }
    return candidatePath;
}

function copyDirRecursive(sz: any, internalPath: string, realPath: string) {
    if (!fs.existsSync(realPath)) {
        fs.mkdirSync(realPath, { recursive: true });
    }
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

async function extractWith7zWasm(
    archivePath: string,
    outputDir: string,
    deleteSource: boolean
): Promise<void> {
    const fileName = path.basename(archivePath);
    const sz = await getSevenZip();

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const archiveBuffer = await fs.promises.readFile(archivePath);
    const wasmArchiveName = 'input.drzst';
    sz.FS.writeFile(wasmArchiveName, new Uint8Array(archiveBuffer));

    const internalOut = '/out';
    sz.FS.mkdir(internalOut);

    const overwriteArg = getOverwriteArg();
    const args = [
        'x', wasmArchiveName,
        '-tzstd',
        `-o${internalOut}`,
        overwriteArg,
        '-y'
    ];

    try {
        sz.callMain(args);
    } catch (err: any) {
        try { sz.FS.unlink(wasmArchiveName); } catch (_) {}
        throw new Error(`解压失败：${err.message}`);
    }

    let entries: string[] = [];
    try {
        const raw = sz.FS.readdir(internalOut);
        entries = raw.filter((e: string) => e !== '.' && e !== '..');
    } catch (e) {}

    if (entries.length === 0) {
        try { sz.FS.unlink(wasmArchiveName); } catch (_) {}
        throw new Error('解压后没有生成任何文件。请确认 .drzst 是有效的 zstd 压缩包。');
    }

    // 智能重命名单个文件（避免固定为 'input'）
    const needsRename = entries.length === 1 &&
        !isDirectory(sz.FS.stat(path.posix.join(internalOut, entries[0])).mode) &&
        entries[0] === 'input';

    const sourceBaseName = path.basename(archivePath, '.drzst');

    if (needsRename) {
        const internalFilePath = path.posix.join(internalOut, 'input');
        const data = sz.FS.readFile(internalFilePath);
        const finalPath = resolveSingleFilePath(outputDir, sourceBaseName);

        if (finalPath === null) {
            vscode.window.showInformationMessage(`${fileName} 解压成功（跳过已存在的文件）`);
        } else {
            fs.mkdirSync(path.dirname(finalPath), { recursive: true });
            fs.writeFileSync(finalPath, data);
        }
    } else {
        // 多文件或目录
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
        try {
            await fs.promises.unlink(archivePath);
            vscode.window.showInformationMessage(`${fileName} 解压并删除成功`);
        } catch (unlinkErr: any) {
            vscode.window.showWarningMessage(`解压成功，但删除源文件失败：${unlinkErr.message}`);
        }
    } else {
        vscode.window.showInformationMessage(`${fileName} 解压成功`);
    }
    refreshExplorer();
}

export function activate(context: vscode.ExtensionContext) {
    const getDeleteSource = () =>
        vscode.workspace.getConfiguration('drzst-extract').get<boolean>('deleteSource', true);

    const getOverwriteMode = () =>
        vscode.workspace.getConfiguration('drzst-extract').get<string>('overwriteMode', 'overwrite');

    // 解压到当前位置
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.extractToCurrent', async (uri: vscode.Uri) => {
            if (!uri) {
                vscode.window.showErrorMessage('未获取到文件路径');
                return;
            }
            const filePath = uri.fsPath;
            const outputDir = path.dirname(filePath);
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `正在解压 ${path.basename(filePath)}...`,
                    cancellable: false
                },
                () => extractWith7zWasm(filePath, outputDir, getDeleteSource())
            );
        })
    );

    // 解压到同名文件夹
    context.subscriptions.push(
        vscode.commands.registerCommand('drzst-extract.extractToSameDir', async (uri: vscode.Uri) => {
            if (!uri) {
                vscode.window.showErrorMessage('未获取到文件路径');
                return;
            }
            const filePath = uri.fsPath;
            const baseName = path.basename(filePath, '.drzst');
            const proposedDir = path.join(path.dirname(filePath), baseName);
            const overwriteMode = getOverwriteMode();

            const outputDir = resolveOutputDir(proposedDir, overwriteMode);
            if (outputDir === null) {
                vscode.window.showInformationMessage(`跳过解压：同名文件夹已存在 (模式为 skip)`);
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `正在解压 ${path.basename(filePath)} 到同名文件夹...`,
                    cancellable: false
                },
                () => extractWith7zWasm(filePath, outputDir, getDeleteSource())
            );
        })
    );
}

export function deactivate() {}