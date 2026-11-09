import { defineConfig } from 'tsdown'

export default defineConfig({ entry: ['src/index.ts', 'src/budgeted/index.ts', 'src/recall/index.ts'], outDir: 'dist', format: 'esm', platform: 'node', target: 'es2024', dts: true, clean: true, fixedExtension: false })
