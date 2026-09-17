import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => ({
  // Library builds leave process.env untouched by default. This standalone
  // browser module must bundle React's production branch without a Node shim.
  ...(mode === 'widget' ? { define: { 'process.env.NODE_ENV': JSON.stringify('production') } } : {}),
  css: {
    postcss: { plugins: [] },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: mode === 'widget' ? 'dist/widget' : 'dist/ui',
    emptyOutDir: mode !== 'widget',
    ...(mode === 'widget' ? {
      lib: {
        entry: fileURLToPath(new URL('./src/ui/mount.tsx', import.meta.url)),
        name: 'DangooAgentWidget',
        formats: ['es'],
        fileName: () => 'dangoo-agent-widget.js',
      },
      rollupOptions: {
        // Bundle React in the widget. The host loads the generated module directly
        // and cannot be assumed to provide an import map for bare React specifiers.
        external: [],
      },
    } : {
      rollupOptions: {
        input: {
          demo: fileURLToPath(new URL('./index.html', import.meta.url)),
        },
      },
    }),
  },
}));
