import * as vscode from 'vscode';
import { normalizePath, parseWrapperScript } from './pure';
import { gitPlain } from './git';

export interface Binding {
  workTree: string;
  gitDir: string;
  label: string;
  /** 跳过自管检测强制接管（目录内有有效 .git 指针但内置 git 扫不到时用） */
  force?: boolean;
}

const SCRIPT_RE = /^(?:[\w.-]+-)?gl\.sh$/;

function basename(p: string): string {
  const n = normalizePath(p) ?? p;
  const segs = n.split('/');
  return segs[segs.length - 1] || n;
}

/**
 * 绑定来源：
 * 1) settings 里手动配置 myVscode.bindings；
 * 2) 各工作区根目录下 *-gl.sh 包装脚本自动发现（--git-dir / --work-tree）。
 * 以 gitDir 归一化去重。
 */
export async function discoverBindings(): Promise<Binding[]> {
  const cfg = vscode.workspace.getConfiguration('myVscode');
  const out = new Map<string, Binding>();
  const add = (b: Binding) => {
    const key = normalizePath(b.gitDir)!.toLowerCase();
    if (!out.has(key)) {
      out.set(key, b);
    }
  };

  for (const raw of cfg.get<unknown[]>('bindings', [])) {
    const b = raw as { workTree?: string; gitDir?: string; label?: string; force?: boolean };
    const wt = normalizePath(b.workTree);
    const gd = normalizePath(b.gitDir);
    if (wt && gd) {
      add({ workTree: wt, gitDir: gd, label: b.label || basename(wt), force: b.force === true });
    }
  }

  if (cfg.get<boolean>('autoDiscover', true)) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      let list: [string, vscode.FileType][] = [];
      try {
        list = await vscode.workspace.fs.readDirectory(folder.uri);
      } catch {
        continue;
      }
      for (const [name, type] of list) {
        if (type !== vscode.FileType.File || !SCRIPT_RE.test(name)) {
          continue;
        }
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name));
          const m = parseWrapperScript(Buffer.from(bytes).toString('utf8'));
          if (m.gitDir && m.workTree) {
            add({ workTree: m.workTree, gitDir: m.gitDir, label: basename(m.workTree) });
          }
        } catch {
          // 单个脚本读失败不影响其它绑定
        }
      }
    }
  }

  return [...out.values()];
}

/**
 * workTree 内部是否已经是「自己能被发现的仓库」（目录内有有效 .git 或 .git 指针文件）。
 * 判据：在 workTree 里跑 rev-parse --show-toplevel，若顶层就是 workTree 自身，
 * 说明内置 git 扩展能直接识别，无需我们接管（避免重复条目）。
 * 项目目录里 .git 已外迁（或只有无效残留）时，toplevel 会落在别处 → 由我们接管。
 */
export async function selfManaged(workTree: string): Promise<boolean> {
  const r = await gitPlain(workTree, ['rev-parse', '--show-toplevel']);
  if (r.code !== 0 || !r.stdout.trim()) {
    return false;
  }
  const top = normalizePath(r.stdout.trim())?.toLowerCase();
  return top === normalizePath(workTree)!.toLowerCase();
}
