import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Inline all JS/CSS into HTML so the app works in sandbox="allow-scripts"
    // without allow-same-origin (which would be a security risk)
    assetsInlineLimit: 1024 * 1024, // 1MB — inline everything
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
