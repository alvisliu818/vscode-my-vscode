// 纯逻辑：不依赖 vscode / child_process，便于用 node 直接冒烟测试。

/** 统一路径分隔符为 '/'，去掉尾部斜杠（根路径除外）。 */
export function normalizePath(p: string | undefined | null): string | undefined {
  if (!p) {
    return undefined;
  }
  let s = String(p).trim().replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) {
    s = s.slice(0, -1);
  }
  return s || undefined;
}

export interface WrapperMatch {
  gitDir?: string;
  workTree?: string;
}

/**
 * 解析 *-gl.sh 包装脚本中的 --git-dir / --work-tree。
 * 注释行忽略；两者都齐才算有效绑定（纯转发脚本会被自然跳过）。
 */
export function parseWrapperScript(text: string): WrapperMatch {
  const body = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const pick = (re: RegExp): string | undefined => {
    const m = body.match(re);
    if (!m) {
      return undefined;
    }
    return normalizePath(m[1] ?? m[2] ?? m[3]);
  };
  const gitDir = pick(/--git-dir\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
  const workTree = pick(/--work-tree\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
  return { gitDir, workTree };
}

export interface StatusEntry {
  /** index 状态位（porcelain v1 X） */
  x: string;
  /** 工作树状态位（porcelain v1 Y） */
  y: string;
  /** 相对工作树的 POSIX 路径（重命名/复制时为新路径） */
  path: string;
  /** 重命名/复制时的原路径 */
  origPath?: string;
}

export interface ParsedStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  entries: StatusEntry[];
}

/** porcelain v1 的冲突码（XY 组合）。 */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** 解析 `git status --porcelain -z -b` 的输出。 */
export function parseStatus(zText: string): ParsedStatus {
  const out: ParsedStatus = { entries: [] };
  const fields = zText.split('\0');
  let i = 0;
  if (fields[0] !== undefined && fields[0].startsWith('## ')) {
    const head = fields[0].slice(3).trim();
    const ab = head.match(/\[ahead (\d+)(?:, behind (\d+))?\]/) ?? head.match(/\[behind (\d+)\]/);
    if (ab) {
      out.ahead = ab[1] ? Number(ab[1]) : undefined;
      out.behind = ab[2] ? Number(ab[2]) : ab[3] ? Number(ab[3]) : undefined;
    }
    let br = head.split('...')[0];
    const bi = br.indexOf(' [');
    if (bi >= 0) {
      br = br.slice(0, bi);
    }
    br = br.trim();
    if (br.startsWith('No commits yet on ')) {
      br = br.slice('No commits yet on '.length).trim();
    }
    out.branch = br || undefined;
    i = 1;
  }
  for (; i < fields.length; i++) {
    const f = fields[i];
    if (!f || f.length < 3 || f[2] !== ' ') {
      continue;
    }
    const x = f[0];
    const y = f[1];
    const p = f.slice(3).replace(/\\/g, '/');
    let orig: string | undefined;
    if (x === 'R' || x === 'C') {
      i += 1;
      orig = (fields[i] ?? '').replace(/\\/g, '/') || undefined;
    }
    out.entries.push({ x, y, path: p, origPath: orig });
  }
  return out;
}

export interface GroupedStatus {
  index: StatusEntry[];
  worktree: StatusEntry[];
  conflict: StatusEntry[];
}

/** 把 status 条目拆进「暂存 / 工作树 / 冲突」三组；MM 这类条目会同时进两组。 */
export function splitGroups(entries: StatusEntry[]): GroupedStatus {
  const g: GroupedStatus = { index: [], worktree: [], conflict: [] };
  for (const e of entries) {
    if (CONFLICT_CODES.has(e.x + e.y)) {
      g.conflict.push(e);
    } else if (e.x === '?') {
      g.worktree.push(e);
    } else {
      if (e.x !== ' ') {
        g.index.push(e);
      }
      if (e.y !== ' ') {
        g.worktree.push(e);
      }
    }
  }
  return g;
}
