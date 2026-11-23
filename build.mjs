import { build } from 'esbuild'

const id = 'dsh-plugin-pathfinder-lab'
await Promise.all([
  build({
    entryPoints: ['src/host.ts'],
    outfile: 'dist/host.js',
    platform: 'node',
    target: 'node24',
    format: 'esm',
    bundle: true,
    packages: 'external',
  }),
  build({
    entryPoints: ['src/client.tsx'],
    outfile: 'dist/client.js',
    platform: 'browser',
    target: 'chrome120',
    format: 'cjs',
    bundle: true,
    jsx: 'automatic',
    loader: { '.css': 'text' },
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
    banner: {
      js: `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
    },
    footer: { js: 'return module.exports;}});' },
  }),
])
