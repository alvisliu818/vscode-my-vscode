import * as vscode from 'vscode';
import * as path from 'path';

/** 行尾形如 [[xxx 的前缀（xxx 内不允许再出现方括号） */
const WIKI_PREFIX = /\[\[[^[\]]*$/;

/** 补全扫描时排除的目录 */
const EXCLUDE_GLOB = '**/{node_modules,.git,__pycache__,.venv,venv,dist,out,tmp,.vs}/**';

/**
 * Python 文件里输入 [[ 自动提示工作区文件路径，回车后插入 `路径]]`。
 * 类 Obsidian wiki-link 的补全体验。[[ 后跟 ./ 或 ../ 时按当前文件相对路径提示。
 */
export class WikiPathCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    const linePrefix = document.getText(new vscode.Range(position.line, 0, position.line, position.character));
    const match = WIKI_PREFIX.exec(linePrefix);
    if (!match) {
      return [];
    }

    const query = match[0].slice(2);
    const replaceRange = new vscode.Range(position.translate(0, -query.length), position);

    // [[./ 、[[../ 、[[. 、[[.. 模式：以当前文件目录为基准的相对路径补全
    const dirPart = relDirPart(query);
    if (dirPart !== undefined) {
      let dir = path.dirname(document.uri.fsPath);
      for (const seg of dirPart.split('/')) {
        if (seg === '..') {
          dir = path.dirname(dir);
        }
      }
      return readDirItems(dir, dirPart, replaceRange, token);
    }

    const files = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 2000, token);
    const roots = vscode.workspace.workspaceFolders ?? [];

    const items: vscode.CompletionItem[] = [];
    for (const file of files) {
      const root = roots.find((r) => file.fsPath.startsWith(r.uri.fsPath + path.sep)) ?? roots[0];
      if (!root) {
        continue;
      }
      const relPath = path.relative(root.uri.fsPath, file.fsPath).replace(/\\/g, '/');
      const item = new vscode.CompletionItem(relPath, vscode.CompletionItemKind.File);
      item.detail = file.fsPath;
      item.insertText = relPath;
      item.range = replaceRange;
      // 文件名命中查询的排前面
      if (query && path.basename(relPath).toLowerCase().includes(query.toLowerCase())) {
        item.sortText = '0' + relPath.toLowerCase();
      }
      items.push(item);
    }
    return items;
  }
}

/** 行尾形如 ./xxx 或 ../a/b/xxx 的相对路径（引号、空白、反斜杠视为路径结束） */
const REL_PATH = /^(\.{1,2}\/(?:[^'"\\/\s]+\/)*)([^'"\\/\s]*)$/;

/** query 是否处于相对路径输入状态；返回目录前缀部分（'.' / '..' / './…/ '） */
function relDirPart(q: string): string | undefined {
  if (q === '.' || q === '..') {
    return q;
  }
  return REL_PATH.exec(q)?.[1];
}

/** 列出 dir 下的条目生成补全项；insertText = 目录前缀 + 名称 + (目录加 /) */
async function readDirItems(
  dir: string,
  dirPart: string,
  range: vscode.Range,
  token: vscode.CancellationToken,
): Promise<vscode.CompletionItem[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  } catch {
    return [];
  }
  const prefix = dirPart.endsWith('/') ? dirPart : dirPart + '/';
  const items: vscode.CompletionItem[] = [];
  for (const [name, type] of entries) {
    if (token.isCancellationRequested) {
      return items;
    }
    const isDir = type === vscode.FileType.Directory;
    const item = new vscode.CompletionItem(
      isDir ? name + '/' : name,
      isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
    );
    item.insertText = prefix + name + (isDir ? '/' : '');
    item.filterText = prefix + name + (isDir ? '/' : '');
    item.range = range;
    item.detail = dir;
    // 目录排前面
    item.sortText = (isDir ? '0' : '1') + name.toLowerCase();
    items.push(item);
  }
  return items;
}

/** 以当前文件所在目录为基准解析 ./ 与 ../，提示相对路径下的文件和子目录 */
export class RelativePathCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    const linePrefix = document.getText(new vscode.Range(position.line, 0, position.line, position.character));
    const match = REL_PATH.exec(linePrefix);
    if (!match) {
      return [];
    }

    const [typed, dirPart] = match;
    const replaceRange = new vscode.Range(position.translate(0, -typed.length), position);

    let dir = path.dirname(document.uri.fsPath);
    for (const seg of dirPart.split('/')) {
      if (seg === '..') {
        dir = path.dirname(dir);
      }
    }
    return readDirItems(dir, dirPart, replaceRange, token);
  }
}

export function registerPathCompletions(ctx: vscode.ExtensionContext): void {
  const filter = { language: 'python', scheme: 'file' } as const;
  ctx.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(filter, new WikiPathCompletionProvider(), '[', '.', '/', '\\'),
    vscode.languages.registerCompletionItemProvider(filter, new RelativePathCompletionProvider(), '.', '/'),
  );
}
