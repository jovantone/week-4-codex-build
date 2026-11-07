import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  devToolbar: { enabled: false },
  output: 'server', adapter: node({ mode: 'standalone' }),
  vite: { plugins: [tailwindcss()], ssr: { external: ['pg'] } },
  security: { allowedDomains: [{ hostname: 'localhost' }, { hostname: '127.0.0.1' }] }
});
