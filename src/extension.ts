import * as vscode from 'vscode';
import { discoverBindings, selfManaged, Binding } from './binding';
import { BindingRepo, SCHEME, ShowProvider, openChanges, openFile } from './scm';
import { StatusEntry } from './pure';
import { registerWikiPathCompletion } from './completion';

type RepoBag = { repo?: BindingRepo; entries: { entry: StatusEntry; group: string }[] };

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('My VS Code');
  const repos = new Map<string, BindingRepo>();

  ctx.subscriptions.push(log);
  registerWikiPathCompletion(ctx);
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ShowProvider()));

  const refreshAll = () => {
    for (const r of repos.values()) {
      void r.refresh().catch((e) => log.appendLine(`刷新异常: ${String(e)}`));
    }
  };

  const reload = async () => {
    for (const r of repos.values()) {
      r.dispose();
    }
    repos.clear();
    const bindings = await discoverBindings();
    const active: Binding[] = [];
    for (const b of bindings) {
      try {
        if (await selfManaged(b.workTree)) {
          log.appendLine(`[绑定] 跳过 ${b.label}（目录内已有自己的 .git，交给内置 git 扩展）`);
          continue;
        }
      } catch {
        // git 不可用时仍然接管
      }
      active.push(b);
    }
    for (const b of active) {
      repos.set(b.gitDir.toLowerCase(), new BindingRepo(b, log, ctx));
      log.appendLine(`[绑定] ${b.label}: work-tree=${b.workTree} git-dir=${b.gitDir}`);
    }
    log.appendLine(
      `[绑定] 共 ${active.length} 个分离仓库${bindings.length !== active.length ? `（另跳过 ${bindings.length - active.length} 个）` : ''}`,
    );
    refreshAll();
  };

  void reload();

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('myVscode')) {
        void reload();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void reload();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        refreshAll();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const p = doc.uri.fsPath.replace(/\\/g, '/').toLowerCase();
      for (const r of repos.values()) {
        const wt = r.binding.workTree.toLowerCase();
        if (p.startsWith(wt + '/')) {
          void r.refresh();
        }
      }
    }),
  );

  // —— 命令实参解析 ——

  const repoFromArg = (arg: unknown): BindingRepo | undefined => {
    if (!arg || typeof arg !== 'object') {
      return undefined;
    }
    const o = arg as Record<string, unknown>;
    const direct = o._repo as BindingRepo | undefined;
    if (direct) {
      return direct;
    }
    const viaScm = (o.scm as { _repo?: BindingRepo } | undefined)?._repo;
    return viaScm;
  };

  const resolveRepo = async (arg: unknown): Promise<BindingRepo | undefined> => {
    const r = repoFromArg(arg);
    if (r) {
      return r;
    }
    const list = [...repos.values()];
    if (list.length === 0) {
      void vscode.window.showInformationMessage('My VS Code：当前没有可用的分离仓库绑定。');
      return undefined;
    }
    if (list.length === 1) {
      return list[0];
    }
    const pick = await vscode.window.showQuickPick(
      list.map((x) => ({ label: x.binding.label, description: x.binding.workTree, repo: x })),
      { placeHolder: '选择要操作的分离仓库' },
    );
    return pick?.repo;
  };

  const collect = (args: unknown[]): RepoBag => {
    const bag: RepoBag = { entries: [] };
    const walk = (a: unknown) => {
      if (!a || typeof a !== 'object') {
        return;
      }
      if (Array.isArray(a)) {
        a.forEach(walk);
        return;
      }
      const o = a as Record<string, unknown>;
      const repo = o._repo as BindingRepo | undefined;
      if (repo && !bag.repo) {
        bag.repo = repo;
      }
      const entry = o._entry as StatusEntry | undefined;
      const group = o._group as string | undefined;
      if (entry && group) {
        bag.entries.push({ entry, group });
      }
    };
    (args ?? []).forEach(walk);
    return bag;
  };

  const errBox = (e: unknown) => {
    void vscode.window.showErrorMessage(`My VS Code：${String((e as Error)?.message ?? e)}`, { modal: true });
  };

  const reg = (id: string, fn: (...a: unknown[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('myVscode.refresh', () => refreshAll());
  reg('myVscode.showOutput', () => log.show(true));
  reg('myVscode.reloadBindings', () => reload());

  reg('myVscode.commit', (arg) => {
    void resolveRepo(arg).then((r) => r?.commit(false).catch(errBox));
  });
  reg('myVscode.commitAll', (arg) => {
    void resolveRepo(arg).then((r) => r?.commit(true).catch(errBox));
  });
  reg('myVscode.checkout', (arg) => {
    void resolveRepo(arg).then((r) => r?.pickBranch());
  });
  reg('myVscode.push', (arg) => {
    void resolveRepo(arg).then((r) => r?.sync('push').catch(errBox));
  });
  reg('myVscode.pull', (arg) => {
    void resolveRepo(arg).then((r) => r?.sync('pull').catch(errBox));
  });
  reg('myVscode.stageAll', (arg) => {
    void resolveRepo(arg).then((r) => r?.stageAll().catch(errBox));
  });
  reg('myVscode.unstageAll', (arg) => {
    void resolveRepo(arg).then((r) => r?.unstageAll().catch(errBox));
  });

  reg('myVscode.stage', (...args: unknown[]) => {
    const bag = collect(args);
    const paths = bag.entries.filter((x) => x.group !== 'index').map((x) => x.entry.path);
    if (bag.repo && paths.length) {
      void bag.repo.stage(paths).catch(errBox);
    }
  });
  reg('myVscode.unstage', (...args: unknown[]) => {
    const bag = collect(args);
    const paths = bag.entries.filter((x) => x.group === 'index').map((x) => x.entry.path);
    if (bag.repo && paths.length) {
      void bag.repo.unstage(paths).catch(errBox);
    }
  });

  const confirmDiscard = async (label: string, paths: string[]): Promise<boolean> => {
    const detail = paths.slice(0, 8).join('\n') + (paths.length > 8 ? `\n… 共 ${paths.length} 个文件` : '');
    const pick = await vscode.window.showWarningMessage(
      `放弃以下更改（不可恢复）？\n${detail}`,
      { modal: true, detail: `${label}：未跟踪文件将被直接删除。` },
      '放弃更改',
    );
    return pick === '放弃更改';
  };

  reg('myVscode.discard', async (...args: unknown[]) => {
    const bag = collect(args);
    if (!bag.repo || !bag.entries.length) {
      return;
    }
    const paths = [...new Set(bag.entries.map((x) => x.entry.path))];
    if (!(await confirmDiscard(bag.repo.binding.label, paths))) {
      return;
    }
    await bag.repo.discardNow(bag.entries).catch(errBox);
  });
  reg('myVscode.discardAll', async (arg) => {
    const repo = await resolveRepo(arg);
    if (!repo) {
      return;
    }
    const items = repo.wtGroup.resourceStates
      .map((s) => {
        const meta = s as unknown as { _entry?: StatusEntry };
        return meta._entry ? { entry: meta._entry, group: 'worktree' } : undefined;
      })
      .filter((x): x is { entry: StatusEntry; group: string } => !!x);
    if (!items.length) {
      void vscode.window.showInformationMessage(`My VS Code：${repo.binding.label} 工作树没有未暂存的更改。`);
      return;
    }
    const paths = [...new Set(items.map((x) => x.entry.path))];
    if (!(await confirmDiscard(repo.binding.label, paths))) {
      return;
    }
    await repo.discardNow(items).catch(errBox);
  });

  reg('myVscode.openChanges', async (...args: unknown[]) => {
    const bag = collect(args);
    if (bag.repo && bag.entries.length) {
      await openChanges(bag.repo, bag.entries[0].entry, bag.entries[0].group).catch(errBox);
    }
  });
  reg('myVscode.openFile', async (...args: unknown[]) => {
    const bag = collect(args);
    if (bag.repo && bag.entries.length) {
      await openFile(bag.repo, bag.entries[0].entry).catch(errBox);
    }
  });
}

export function deactivate(): void {
  // ctx.subscriptions 统一释放
}
