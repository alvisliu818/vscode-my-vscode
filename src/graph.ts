import * as vscode from 'vscode';
import { git } from './git';
import { BindingRepo, contentUri } from './scm';

export interface GraphCommit {
  graph: string;
  id: string;
  parents: string[];
  short: string;
  author: string;
  time: number; // unix 秒
  subject: string;
}

/** 解析 `git log --graph --pretty=format:%x01...%x1f...` 的输出。 */
export function parseGraphLog(stdout: string): GraphCommit[] {
  const out: GraphCommit[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf('\x01');
    if (i < 0) {
      continue; // 提交体续行（graph 补白），忽略
    }
    const graph = line.slice(0, i);
    const f = line.slice(i + 1).split('\x1f');
    if (f.length < 6 || !f[0]) {
      continue;
    }
    out.push({
      graph,
      id: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      short: f[2],
      author: f[3],
      time: Number(f[4]) || 0,
      subject: f[5],
    });
  }
  return out;
}

function relTime(sec: number): string {
  const d = Date.now() / 1000 - sec;
  if (d < 60) {
    return '刚刚';
  }
  if (d < 3600) {
    return `${Math.floor(d / 60)} 分钟前`;
  }
  if (d < 86400) {
    return `${Math.floor(d / 3600)} 小时前`;
  }
  if (d < 86400 * 30) {
    return `${Math.floor(d / 86400)} 天前`;
  }
  if (d < 86400 * 365) {
    return `${Math.floor(d / 86400 / 30)} 个月前`;
  }
  return `${Math.floor(d / 86400 / 365)} 年前`;
}

export class GraphItem {
  static empty(msg: string): GraphItem {
    const it = new vscode.TreeItem(msg);
    it.iconPath = new vscode.ThemeIcon('info');
    return new GraphItem(undefined, undefined, it);
  }

  static commit(repo: BindingRepo, c: GraphCommit): GraphItem {
    return new GraphItem(repo, c, new vscode.TreeItem(''));
  }

  private constructor(
    readonly repo: BindingRepo | undefined,
    readonly commit: GraphCommit | undefined,
    readonly item: vscode.TreeItem,
  ) {}
}

/** 提交图表树视图：跟随当前仓库，`git log --graph` 渲染。 */
export class GraphProvider implements vscode.TreeDataProvider<GraphItem>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<GraphItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private repo?: BindingRepo;

  constructor(private readonly log: vscode.OutputChannel) {}

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** 跟随仓库（同仓库不重刷）。 */
  follow(repo: BindingRepo | undefined): void {
    if (repo === this.repo) {
      return;
    }
    this.repo = repo;
    this._onDidChange.fire();
  }

  current(): BindingRepo | undefined {
    return this.repo;
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: GraphItem): vscode.TreeItem {
    if (!el.commit) {
      return el.item;
    }
    const c = el.commit;
    let g = c.graph.trim();
    if (g.length > 20) {
      g = g.slice(0, 20) + '…';
    }
    const it = new vscode.TreeItem(g ? `${g} ${c.subject}` : c.subject);
    it.description = `${c.short} · ${relTime(c.time)} · ${c.author}`;
    it.iconPath = new vscode.ThemeIcon('git-commit');
    it.contextValue = 'commit';
    it.tooltip = new vscode.MarkdownString(
      `**${c.subject}**\n\n${c.short} · ${c.author} · ${new Date(c.time * 1000).toLocaleString()}`,
    );
    it.command = { command: 'myVscode.openCommit', title: '查看提交', arguments: [el.repo, c] };
    return it;
  }

  async getChildren(): Promise<GraphItem[]> {
    const repo = this.repo;
    if (!repo) {
      return [GraphItem.empty('没有仓库 — 打开绑定仓库的文件，或点击标题栏选择仓库')];
    }
    const r = await git(
      repo.binding.gitDir,
      [
        'log',
        '--graph',
        '--date-order',
        '-n',
        '300',
        '--pretty=format:%x01%H%x1f%P%x1f%h%x1f%an%x1f%at%x1f%s',
      ],
      repo.binding.workTree,
    );
    if (r.code !== 0) {
      this.log.appendLine(`[${repo.binding.label}] git log 失败: ${r.stderr.trim()}`);
      return [GraphItem.empty(`无法读取提交历史：${r.stderr.trim().split(/\r?\n/)[0] ?? ''}`)];
    }
    const commits = parseGraphLog(r.stdout);
    if (!commits.length) {
      return [GraphItem.empty('空仓库，还没有提交。')];
    }
    return commits.map((c) => GraphItem.commit(repo, c));
  }
}

/** 点击提交 → QuickPick 列出变更文件 → vscode.diff 查看差异。 */
export async function openCommit(repo: BindingRepo, c: GraphCommit): Promise<void> {
  const b = repo.binding;
  const r = await git(
    b.gitDir,
    ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '-z', c.id],
    b.workTree,
  );
  if (r.code !== 0) {
    void vscode.window.showErrorMessage(`My VS Code：读取提交 ${c.short} 失败\n${r.stderr.trim()}`, { modal: true });
    return;
  }
  // -z 流：状态 \0 路径 \0（重命名/复制时多一个原路径 \0）…
  const tok = r.stdout.split('\0');
  const changes: { st: string; path: string; orig?: string }[] = [];
  for (let i = 0; i < tok.length - 1; ) {
    const st = tok[i++];
    if (!st) {
      break;
    }
    const code = st[0];
    if (code === 'R' || code === 'C') {
      const orig = tok[i++];
      const p = tok[i++];
      if (p) {
        changes.push({ st: code, path: p, orig });
      }
    } else {
      const p = tok[i++];
      if (p) {
        changes.push({ st: code, path: p });
      }
    }
  }
  if (!changes.length) {
    void vscode.window.showInformationMessage(`My VS Code：提交 ${c.short}（${c.subject}）没有文件变更（可能是合并提交）。`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    changes.map((ch) => ({
      label: `${ch.orig ? `${ch.orig} → ${ch.path}` : ch.path}`,
      description: ch.st,
      ch,
    })),
    { placeHolder: `${c.short} ${c.subject} — 选择文件查看差异` },
  );
  if (!pick) {
    return;
  }
  const ch = pick.ch;
  const empty = contentUri(b.gitDir, ':__EMPTY__', ch.path);
  const parent = c.parents[0];
  const atId = (p: string) => contentUri(b.gitDir, `${c.id}:${p}`, p);
  const atParent = (p: string) => (parent ? contentUri(b.gitDir, `${parent}:${p}`, p) : empty);
  let left: vscode.Uri;
  let right: vscode.Uri;
  let title: string;
  if (ch.st === 'A') {
    left = empty;
    right = atId(ch.path);
    title = `${ch.path}（新增 @ ${c.short}）`;
  } else if (ch.st === 'D') {
    left = atParent(ch.path);
    right = empty;
    title = `${ch.path}（删除 @ ${c.short}）`;
  } else if (ch.orig) {
    left = atParent(ch.orig);
    right = atId(ch.path);
    title = `${ch.orig} → ${ch.path}（${ch.st} @ ${c.short}）`;
  } else {
    left = atParent(ch.path);
    right = atId(ch.path);
    title = `${ch.path}（${c.short}）`;
  }
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}
