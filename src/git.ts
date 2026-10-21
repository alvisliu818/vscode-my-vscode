import { execFile } from 'child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

type ExecErr = { code?: string | number | null; message?: string } | null;

function toResult(err: ExecErr, stdout: string | Buffer, stderr: string | Buffer): GitResult {
  if (!err) {
    return { code: 0, stdout: String(stdout ?? ''), stderr: '' };
  }
  const c = err.code;
  const code = typeof c === 'number' ? c : 1;
  const msg = (typeof stderr === 'string' && stderr) || String(err.message ?? err);
  return { code, stdout: typeof stdout === 'string' ? stdout : '', stderr: msg };
}

/**
 * 以显式 --git-dir（可选 --work-tree）执行 git，避免任何工作目录歧义；
 * cwd 一律设为工作树根，pathspec 相对工作树解析。
 * core.quotepath=false 保证中文文件名原样输出。
 */
export function git(gitDir: string, args: string[], workTree?: string | null, timeoutMs = 30000): Promise<GitResult> {
  const full = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '--git-dir', gitDir];
  if (workTree) {
    full.push('--work-tree', workTree);
  }
  full.push(...args);
  return new Promise((resolve) => {
    execFile(
      'git',
      full,
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
        cwd: workTree || undefined,
      },
      (err, stdout, stderr) => resolve(toResult(err, stdout, stderr)),
    );
  });
}

/** 不带 --git-dir 的普通 git（用于判断目录是否已是自管仓库）。 */
export function gitPlain(cwd: string, args: string[], timeoutMs = 15000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
        cwd,
      },
      (err, stdout, stderr) => resolve(toResult(err, stdout, stderr)),
    );
  });
}

/** 某个 rev:path（或 :path）在对象库中是否存在。 */
export async function existsInRev(gitDir: string, revPath: string): Promise<boolean> {
  const r = await git(gitDir, ['cat-file', '-e', revPath]);
  return r.code === 0;
}
