import * as vscode from 'vscode';
import * as path from 'path';

/** 行尾形如 [[xxx 的前缀（xxx 内不允许再出现方括号） */
const WIKI_PREFIX = /\[\[[^[\]]*$/;

/** 补全扫描时排除的目录 */
const EXCLUDE_GLOB = '**/{node_modules,.git,__pycache__,.venv,venv,dist,out,tmp,.vs}/**';

/**
 * Python 文件里输入 [[ 自动提示工作区文件路径，回车后插入 `路径]]`。
 * 类 Obsidian wiki-link 的补全体验。
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
      item.insertText = relPath + ']]';
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

export function registerWikiPathCompletion(ctx: vscode.ExtensionContext): void {
  const provider = vscode.languages.registerCompletionItemProvider(
    { language: 'python', scheme: 'file' },
    new WikiPathCompletionProvider(),
    '[',
    '/',
    '\\',
  );
  ctx.subscriptions.push(provider);
}
