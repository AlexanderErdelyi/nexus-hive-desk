// @ts-check
const esbuild = require('esbuild');
const path = require('path');
const args = process.argv.slice(2);
const watch = args.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  bundle: true,
  // 'vscode' is provided by VS Code at runtime — do not bundle it
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: path.join(__dirname, 'dist', 'extension.js'),
  sourcemap: true,
  treeShaking: true,
  // Resolve workspace packages from their TypeScript sources
  alias: {
    '@nexus/ai': path.join(__dirname, '../../packages/ai/src/index.ts'),
    '@nexus/xliff': path.join(__dirname, '../../packages/xliff/src/index.ts'),
    '@nexus/types': path.join(__dirname, '../../packages/types/src/index.ts'),
  },
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes…');
  } else {
    await esbuild.build(buildOptions);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
