import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  logLevel: 'info',
};

// 扩展主入口
await build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/my-vscode.js' });
// 纯逻辑入口（给 node 冒烟测试用，不含 vscode 依赖）
await build({ ...common, entryPoints: ['src/pure.ts'], outfile: 'tmp/my-vscode-pure.cjs' });
