# My VS Code

把「工作树目录」与「外迁的 `.git` 目录」（分离 git 仓库）直接绑定，在 VSCode
源代码管理面板里原生操作这些仓库 —— **不在项目目录里放任何 `.git` 指针文件**。

适用布局（.git 外迁）：

```
E:\HOME\Code                     ← 工作区根（父仓/私有仓，交给内置 git 扩展）
├── myobsidian-gl.sh             ← 绑定来源：--git-dir=… --work-tree=…
├── obsidian-my-obsidian-git/    ← 外迁的 git-dir
└── obsidian/obsidian-my-obsidian/  ← 项目工作树（目录内无有效 .git）
```

## 安装

1. `Extensions: Install from VSIX…`，选择 `my-vscode-<版本>.vsix`
2. Reload Window
3. 打开 `E:\HOME\Code` 作为工作区，源代码管理面板会出现每个分离仓库的分区

## 绑定从哪来

- **自动发现**：扫描工作区根目录下的 `*-gl.sh` / `gl.sh` 包装脚本，解析其中的
  `--git-dir=…` 与 `--work-tree=…`。纯转发脚本（如已并入聚合仓的 `gl.sh`）会被自然跳过。
- **手动配置**：`myVscode.bindings`（工作树、外迁 git-dir、可选显示名）。
- 目录里已有有效 `.git`（含指针文件）的项目会被跳过，交给内置 git 扩展，避免重复条目。

## 功能

- Python 路径补全：输入 `[[` 提示工作区文件路径（类 Obsidian wiki-link），
  `[[` 后跟 `./`、`../` 则按当前文件相对路径提示；单独输入 `./`、`../` 也按相对路径提示文件/子目录，选中目录后继续下钻
- 每个分离仓库一个 SCM 分区：暂存的更改 / 更改（含冲突），角标计数、状态栏分支显示
- 打开差异（HEAD ↔ 暂存区 ↔ 工作树，重命名以原路径为基准）、打开文件、行内 Quick Diff
- 暂存 / 取消暂存 / 暂存全部 / 取消全部暂存；放弃更改（强确认，未跟踪文件会被删除）
- 提交（输入框 Ctrl+Enter）、暂存全部并提交；提交失败（例如 pre-commit 钩子拦截）会弹窗显示完整原因
- 切换分支（QuickPick）、推送 / 拉取
- 文件保存、窗口聚焦、文件监听（含外迁 git-dir 的 index/HEAD/refs）自动刷新

## 与隐私防护的关系

所有 git 操作都以显式 `--git-dir` + `--work-tree` 执行（与 `*-gl.sh` 等价），
pre-commit 钩子仍在外迁 git-dir 的 `hooks/` 下生效 —— 钩子拦截时弹窗会显示完整输出。

## 设置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `myVscode.autoDiscover` | `true` | 自动解析根目录 `*-gl.sh` 脚本生成绑定 |
| `myVscode.bindings` | `[]` | 手动绑定 `[{ workTree, gitDir, label }]` |

## 已知限制

- 需要把 `E:\HOME\Code`（含 `*-gl.sh` 的目录）作为工作区打开，才能自动发现；
  打开单个子项目文件夹时请用 `myVscode.bindings` 手动配置。
- 未实现：stash、rebase、远端管理、子模块操作。
