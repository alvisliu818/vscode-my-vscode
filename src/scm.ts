import * as vscode from 'vscode';
import * as path from 'path';
import { git, existsInRev } from './git';
import { Binding } from './binding';
import { parseStatus, splitGroups, StatusEntry } from './pure';

export const SCHEME = 'separated-git';

const STATUS_LABEL: Record<string, string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  C: '复制',
  T: '类型变更',
  U: '冲突',
  '?': '未跟踪',
};

/** git 对象内容文档的 URI（scheme: separated-git，由 ShowProvider 惰性求值）。 */
export function contentUri(gitDir: string, spec: string, displayPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: '/' + displayPath.replace(/\\/g, '/'),
    query: JSON.stringify({ g: gitDir, s: spec }),
  });
}

export function joinFs(workTree: string, rel: string): string {
  return path.join(workTree, ...rel.split('/'));
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function toRel(workTree: string, fsPath: string): string | undefined {
  const a = normalizeSlashes(workTree);
  const b = normalizeSlashes(fsPath);
  if (!b.toLowerCase().startsWith(a.toLowerCase() + '/')) {
    return undefined;
  }
  return b.slice(a.length + 1);
}

class ShowProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: { g?: string; s?: string };
    try {
      q = JSON.parse(uri.query);
    } catch {
      return '// 无效内容 URI';
    }
    if (!q.g || !q.s) {
      return '// 无效内容 URI';
    }
    if (q.s === ':__EMPTY__') {
      return '';
    }
    const r = await git(q.g, ['show', q.s]);
    if (r.code !== 0) {
      return '// 无法读取该版本内容：\n// ' + r.stderr.trim().split(/\r?\n/).join('\n// ');
    }
    return r.stdout;
  }
}

export { ShowProvider };

interface ItemMeta {
  _repo?: BindingRepo;
  _entry?: StatusEntry;
  _group?: string;
  _groupId?: string;
}

function tag<T>(obj: T, meta: Partial<ItemMeta>): T {
  return Object.assign(obj as unknown as Record<string, unknown>, meta) as unknown as T;
}

export class BindingRepo implements vscode.QuickDiffProvider, vscode.Disposable {
  readonly scm: vscode.SourceControl;
  readonly indexGroup: vscode.SourceControlResourceGroup;
  readonly wtGroup: vscode.SourceControlResourceGroup;
  branch = '';
  upstream = '';
  ahead = 0;
  behind = 0;

  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly watchers: vscode.Disposable[] = [];

  constructor(
    readonly binding: Binding,
    private readonly log: vscode.OutputChannel,
    ctx: vscode.ExtensionContext,
  ) {
    this.scm = vscode.scm.createSourceControl('myVscode', binding.label, vscode.Uri.file(binding.workTree));
    tag(this.scm, { _repo: this });
    this.indexGroup = this.scm.createResourceGroup('index', '暂存的更改');
    tag(this.indexGroup, { _repo: this, _groupId: 'index' });
    this.wtGroup = this.scm.createResourceGroup('workingTree', '更改');
    tag(this.wtGroup, { _repo: this, _groupId: 'workingTree' });
    this.scm.quickDiffProvider = this;
    this.scm.acceptInputCommand = { command: 'myVscode.commit', title: '提交', arguments: [this] };
    this.scm.inputBox.placeholder = `提交信息（${binding.label}，Ctrl+Enter 提交已暂存）`;
    this.scm.statusBarCommands = [
      { command: 'myVscode.checkout', title: '$(git-branch) …', tooltip: binding.workTree, arguments: [this] },
    ];

    // 工作树文件变化 + 外迁 git-dir 的 index/HEAD/refs 变化（命令行提交也能实时反映）
    const wtWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(binding.workTree), '**'),
    );
    const gdWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(binding.gitDir), '{index,HEAD,ORIG_HEAD,MERGE_HEAD,refs/**}'),
    );
    for (const w of [wtWatcher, gdWatcher]) {
      const handler = this.debounceRefresh();
      this.watchers.push(w.onDidChange(handler), w.onDidCreate(handler), w.onDidDelete(handler));
    }
    this.watchers.push(wtWatcher, gdWatcher);
    ctx.subscriptions.push(this);
  }

  private debounceRefresh(): () => void {
    let t: NodeJS.Timeout | undefined;
    return () => {
      if (t) {
        clearTimeout(t);
      }
      t = setTimeout(() => void this.refresh().catch(() => undefined), 400);
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers.length = 0;
    this.scm.dispose();
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async run(args: string[]): Promise<void> {
    const r = await git(this.binding.gitDir, args, this.binding.workTree);
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() || `git ${args[0]} 退出码 ${r.code}`);
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const t0 = Date.now();
    const r = await git(
      this.binding.gitDir,
      ['status', '--porcelain', '-z', '-b', '--untracked-files=normal'],
      this.binding.workTree,
    );
    if (this.disposed) {
      return;
    }
    if (r.code !== 0) {
      this.log.appendLine(`[${this.binding.label}] git status 失败: ${r.stderr.trim()}`);
      return;
    }
    const parsed = parseStatus(r.stdout);
    const groups = splitGroups(parsed.entries);
    this.branch = parsed.branch ?? 'HEAD';
    this.upstream = parsed.upstream ?? '';
    this.ahead = parsed.ahead ?? 0;
    this.behind = parsed.behind ?? 0;
    this.indexGroup.resourceStates = groups.index.map((e) => this.toState(e, 'index'));
    this.wtGroup.resourceStates = [...groups.conflict, ...groups.worktree].map((e) => this.toState(e, 'worktree'));
    this.scm.count = this.indexGroup.resourceStates.length + this.wtGroup.resourceStates.length;
    const ab = (this.ahead ? ` ↑${this.ahead}` : '') + (this.behind ? ` ↓${this.behind}` : '');
    const cmds: vscode.Command[] = [
      {
        command: 'myVscode.checkout',
        title: `$(git-branch) ${this.branch}${ab}`,
        tooltip: `${this.binding.label} · ${this.binding.workTree}`,
        arguments: [this],
      },
    ];
    // 无上游时显示「发布分支」按钮（内置 git 同款行为）
    if (!this.upstream) {
      cmds.push({
        command: 'myVscode.publish',
        title: '$(cloud-upload)',
        tooltip: `发布分支 ${this.branch} 到远程`,
        arguments: [this],
      });
    }
    this.scm.statusBarCommands = cmds;
    this.log.appendLine(
      `[${this.binding.label}] 刷新：暂存 ${groups.index.length}，工作树 ${groups.worktree.length}` +
        `${groups.conflict.length ? `，冲突 ${groups.conflict.length}` : ''}（${Date.now() - t0}ms）`,
    );
  }

  private toState(e: StatusEntry, group: 'index' | 'worktree'): vscode.SourceControlResourceState {
    const code = group === 'index' ? e.x : e.x === '?' ? '?' : e.y;
    const deleted = code === 'D';
    const label = STATUS_LABEL[code] ?? code;
    // 单击变更行打开差异（内置 git 同款行为）；删除的文件也走差异查看原内容
    const command: vscode.Command = { command: 'myVscode.openChanges', title: '打开差异', arguments: [] };
    const state = tag<vscode.SourceControlResourceState>(
      {
        resourceUri: vscode.Uri.file(joinFs(this.binding.workTree, e.path)),
        decorations: {
          strikeThrough: deleted,
          tooltip: (e.origPath ? `重命名自 ${e.origPath} · ` : '') + label,
        },
        command,
      },
      { _repo: this, _entry: e, _group: group },
    );
    command.arguments?.push(this, state, group);
    return state;
  }

  async provideOriginalResource(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const rel = toRel(this.binding.workTree, uri.fsPath);
    if (!rel) {
      return undefined;
    }
    if (!(await existsInRev(this.binding.gitDir, `HEAD:${rel}`))) {
      return undefined;
    }
    return contentUri(this.binding.gitDir, `HEAD:${rel}`, rel);
  }

  // —— 操作（全部经 enqueue 串行化，避免并发动 index） ——

  stage(paths: string[]): Promise<void> {
    return this.enqueue(async () => {
      if (!paths.length) {
        return;
      }
      await this.run(['add', '--', ...paths]);
      await this.refresh();
    });
  }

  stageAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.run(['add', '-A']);
      await this.refresh();
    });
  }

  unstage(paths: string[]): Promise<void> {
    return this.enqueue(async () => {
      if (!paths.length) {
        return;
      }
      await this.run(await this.unstageArgs(paths));
      await this.refresh();
    });
  }

  unstageAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.run(await this.unstageArgs(['.']));
      await this.refresh();
    });
  }

  private async unstageArgs(paths: string[]): Promise<string[]> {
    const hasHead = (await git(this.binding.gitDir, ['rev-parse', '-q', '--verify', 'HEAD'])).code === 0;
    return hasHead ? ['reset', '-q', 'HEAD', '--', ...paths] : ['rm', '--cached', '-r', '-q', '--', ...paths];
  }

  discardNow(items: { entry: StatusEntry; group: string }[]): Promise<void> {
    return this.enqueue(async () => {
      const untracked = items.filter((x) => x.entry.x === '?').map((x) => x.entry.path);
      const tracked = items.filter((x) => x.entry.x !== '?').map((x) => x.entry.path);
      if (untracked.length) {
        await this.run(['clean', '-f', '-d', '--', ...untracked]);
      }
      if (tracked.length) {
        await this.run(['checkout', '--', ...tracked]);
      }
      await this.refresh();
    });
  }

  /** 提交。all=true 时先 add -A；否则只提交已暂存（未暂存时经确认后代为暂存全部）。 */
  async commit(all: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      let msg = this.scm.inputBox.value.trim();
      if (!msg) {
        msg =
          (await vscode.window.showInputBox({ prompt: `提交信息（${this.binding.label}）`, placeHolder: '提交说明…' }))?.trim() ??
          '';
      }
      if (!msg) {
        return false;
      }
      const staged = (await git(this.binding.gitDir, ['diff', '--cached', '--quiet'], this.binding.workTree)).code !== 0;
      if (!staged && !all) {
        const anyChange =
          (await git(this.binding.gitDir, ['status', '--porcelain', '--untracked-files=normal'], this.binding.workTree))
            .stdout.trim() !== '';
        if (!anyChange) {
          void vscode.window.showInformationMessage(`My VS Code：${this.binding.label} 没有可提交的更改。`);
          return false;
        }
        const pick = await vscode.window.showWarningMessage(
          `没有已暂存的更改。暂存全部并提交？`,
          { modal: true },
          '暂存全部并提交',
        );
        if (pick !== '暂存全部并提交') {
          return false;
        }
        await this.run(['add', '-A']);
      } else if (!staged && all) {
        await this.run(['add', '-A']);
      }
      const r = await git(this.binding.gitDir, ['commit', '-m', msg], this.binding.workTree);
      if (r.code !== 0) {
        this.log.appendLine(`[${this.binding.label}] 提交失败:\n${r.stderr.trim()}`);
        void vscode.window.showErrorMessage(
          `My VS Code：提交被拒绝（${this.binding.label}）\n${r.stderr.trim()}`,
          { modal: true },
        );
        return false;
      }
      this.scm.inputBox.value = '';
      const h = await git(this.binding.gitDir, ['log', '-1', '--format=%h %s'], this.binding.workTree);
      void vscode.window.showInformationMessage(
        `My VS Code：${this.binding.label} 已提交 ${h.stdout.trim().split(/\r?\n/)[0] ?? ''}`,
      );
      await this.refresh();
      return true;
    });
  }

  async pickBranch(): Promise<void> {
    const cur =
      (await git(this.binding.gitDir, ['symbolic-ref', '-q', '--short', 'HEAD'], this.binding.workTree)).stdout.trim() ||
      '(detached)';
    const r = await git(this.binding.gitDir, ['branch', '--format=%(refname:short)'], this.binding.workTree);
    const names = r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) {
      void vscode.window.showInformationMessage(`My VS Code：${this.binding.label} 没有本地分支。`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      names.map((n) => ({ label: n, description: n === cur ? '（当前）' : undefined })),
      { placeHolder: `切换分支 — ${this.binding.label}` },
    );
    if (!pick) {
      await this.refresh();
      return;
    }
    if (pick.label !== cur) {
      try {
        await this.enqueue(() => this.run(['checkout', pick.label]));
        void vscode.window.showInformationMessage(`My VS Code：${this.binding.label} 已切换到 ${pick.label}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`My VS Code：${String((e as Error)?.message ?? e)}`, { modal: true });
      }
    }
    await this.refresh();
  }

  // —— 远程管理 ——

  /** 远程列表（fetch URL），解析 `git remote -v`。 */
  async listRemotes(): Promise<{ name: string; url: string }[]> {
    const r = await git(this.binding.gitDir, ['remote', '-v'], this.binding.workTree);
    const map = new Map<string, string>();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\t(\S+)\s+\(fetch\)$/);
      if (m) {
        map.set(m[1], m[2]);
      }
    }
    return [...map].map(([name, url]) => ({ name, url }));
  }

  addRemote(name: string, url: string): Promise<void> {
    return this.enqueue(async () => {
      await this.run(['remote', 'add', name, url]);
      this.log.appendLine(`[${this.binding.label}] 远程已添加：${name} → ${url}`);
    });
  }

  removeRemote(name: string): Promise<void> {
    return this.enqueue(async () => {
      await this.run(['remote', 'remove', name]);
      this.log.appendLine(`[${this.binding.label}] 远程已删除：${name}`);
    });
  }

  setRemoteUrl(name: string, url: string): Promise<void> {
    return this.enqueue(async () => {
      await this.run(['remote', 'set-url', name, url]);
      this.log.appendLine(`[${this.binding.label}] 远程 URL 已更新：${name} → ${url}`);
    });
  }

  /** 发布当前分支：git push -u <remote> <branch>，建立上游跟踪。 */
  async publishTo(remote: string): Promise<void> {
    const r = await git(this.binding.gitDir, ['push', '-u', remote, this.branch], this.binding.workTree, 120000);
    if (r.code === 0) {
      this.log.appendLine(`[${this.binding.label}] git push -u ${remote} ${this.branch}: OK`);
      void vscode.window.showInformationMessage(
        `My VS Code：${this.binding.label} 分支 ${this.branch} 已发布到 ${remote}。`,
      );
    } else {
      this.log.appendLine(`[${this.binding.label}] git push 失败:\n${r.stderr.trim()}`);
      void vscode.window.showErrorMessage(
        `My VS Code：${this.binding.label} 发布失败\n${r.stderr.trim()}`,
        { modal: true },
      );
    }
    await this.refresh();
  }

  async sync(kind: 'push' | 'pull'): Promise<void> {
    const r = await git(this.binding.gitDir, [kind], this.binding.workTree, 120000);
    const verb = kind === 'push' ? '推送' : '拉取';
    if (r.code === 0) {
      this.log.appendLine(`[${this.binding.label}] git ${kind}: OK`);
      void vscode.window.showInformationMessage(`My VS Code：${this.binding.label} ${verb}完成。`);
    } else {
      this.log.appendLine(`[${this.binding.label}] git ${kind} 失败:\n${r.stderr.trim()}`);
      void vscode.window.showErrorMessage(
        `My VS Code：${this.binding.label} ${verb}失败\n${r.stderr.trim()}`,
        { modal: true },
      );
    }
    await this.refresh();
  }
}

export async function openChanges(repo: BindingRepo, e: StatusEntry, group: string): Promise<void> {
  const b = repo.binding;
  const rel = e.origPath ?? e.path;
  const empty = contentUri(b.gitDir, ':__EMPTY__', e.path);
  let left: vscode.Uri;
  let right: vscode.Uri;
  let title: string;
  if (group === 'index') {
    const inHead = await existsInRev(b.gitDir, `HEAD:${rel}`);
    left = inHead ? contentUri(b.gitDir, `HEAD:${rel}`, rel) : empty;
    const inIndex = e.x !== 'D';
    right = inIndex ? contentUri(b.gitDir, `:${e.path}`, e.path) : empty;
    title = `${e.path}（HEAD ↔ 暂存区）`;
  } else {
    const inIndex = await existsInRev(b.gitDir, `:${e.path}`);
    left = inIndex ? contentUri(b.gitDir, `:${e.path}`, e.path) : empty;
    const onDisk = e.y !== 'D';
    right = onDisk ? vscode.Uri.file(joinFs(b.workTree, e.path)) : empty;
    title = `${e.path}（暂存区 ↔ 工作树）`;
  }
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

export async function openFile(repo: BindingRepo, e: StatusEntry): Promise<void> {
  if (e.y === 'D') {
    void vscode.window.showErrorMessage('文件已从工作树删除，可用「打开差异」查看原内容。');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(joinFs(repo.binding.workTree, e.path)));
  await vscode.window.showTextDocument(doc, { preview: true });
}
