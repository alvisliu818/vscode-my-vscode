import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseWrapperScript, parseStatus, splitGroups } from '../tmp/my-vscode-pure.cjs';

const CODE = 'E:/HOME/Code';

// 1) 真实包装脚本解析
const my = parseWrapperScript(readFileSync(`${CODE}/myobsidian-gl.sh`, 'utf8'));
assert.equal(my.gitDir, 'E:/HOME/Code/obsidian-my-obsidian-git');
assert.equal(my.workTree, 'E:/HOME/Code/obsidian/obsidian-my-obsidian');

const fwd = parseWrapperScript(readFileSync(`${CODE}/gl.sh`, 'utf8'));
assert.ok(!fwd.gitDir && !fwd.workTree, '转发脚本（gl.sh）应被自然跳过');

console.log('✓ myobsidian-gl.sh 解析正确；gl.sh 转发脚本被跳过');
console.log('  — 工作区根目录全部 gl 脚本的发现结果 —');
for (const f of readdirSync(CODE)) {
  if (/^(?:[\w.-]+-)?gl\.sh$/.test(f)) {
    const m = parseWrapperScript(readFileSync(`${CODE}/${f}`, 'utf8'));
    console.log(`  ${f} → ${m.gitDir ? `${m.workTree} ⇄ ${m.gitDir}` : '(转发/无绑定，跳过)'}`);
  }
}

// 2) 合成 status：中文路径 + 重命名 + 暂存后又修改 + 删除 + 未跟踪
const z = '## main...origin/main [ahead 1, behind 2]\0MM 工作/文件.md\0R  新位置/新名.md\0旧位置/旧名.md\0?? 未跟踪 新文件.md\0 D 删了.md\0';
const parsed = parseStatus(z);
assert.equal(parsed.branch, 'main');
assert.equal(parsed.ahead, 1);
assert.equal(parsed.behind, 2);
assert.equal(parsed.entries.length, 4);
const g = splitGroups(parsed.entries);
assert.equal(g.index.length, 2, 'index 组应为 MM + R');
assert.equal(g.worktree.length, 3, 'worktree 组应为 MM + ?? + D');
const ren = parsed.entries.find((e) => e.x === 'R');
assert.equal(ren.origPath, '旧位置/旧名.md');
console.log('✓ status 解析（中文路径/重命名/双状态/删除）正确');

// 3) 真实分离仓库只读探测：与扩展运行时的命令完全一致
const out = execFileSync(
  'git',
  [
    '-c', 'core.quotepath=false',
    '--git-dir', 'E:/HOME/Code/obsidian-my-obsidian-git',
    '--work-tree', 'E:/HOME/Code/obsidian/obsidian-my-obsidian',
    'status', '--porcelain', '-z', '-b', '--untracked-files=normal',
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const real = parseStatus(out);
console.log(`✓ 真实 myobsidian 仓库只读探测：分支 ${real.branch}，变更条目 ${real.entries.length}`);

console.log('全部冒烟测试通过');
