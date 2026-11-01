import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Tesla's browser is a recent Chromium, but stay conservative.
    target: 'es2020',
    sourcemap: false,
  },
});
