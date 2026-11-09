import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function pickEnv(...candidates: Array<string | undefined>) {
  // Netlify CLI redacts secret env vars locally as "****************XX"; reject those so we never bake a placeholder.
  for (const value of candidates) {
    if (!value) continue;
    if (/^\*+[A-Za-z0-9]{0,8}$/.test(value)) continue;
    return value;
  }
  return '';
}

export default defineConfig(({ mode }) => {
  // Prefer process.env (Netlify / CI) over .env files — loadEnv alone misses injected secrets.
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const url = pickEnv(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_URL, fileEnv.VITE_SUPABASE_URL, fileEnv.SUPABASE_URL);
  const anon = pickEnv(process.env.VITE_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY, fileEnv.VITE_SUPABASE_ANON_KEY, fileEnv.SUPABASE_ANON_KEY);
  // FLOOR_CI_BUILD=1: compile-only check in CI (no keys baked, never deployed). Real deploys still require both.
  const ciCompileOnly = process.env.FLOOR_CI_BUILD === '1';
  if (mode === 'production' && !ciCompileOnly && (!url || !anon)) throw new Error('Admin build requires Supabase URL and anon key');
  const buildSha = process.env.COMMIT_REF || process.env.GITHUB_SHA || 'dev';
  const buildDate = process.env.BUILD_DATE || new Date().toISOString();
  return {
    plugins: [
      react(),
      {
        name: 'floor-build-json',
        closeBundle() {
          const out = resolve(process.cwd(), 'dist/build.json');
          writeFileSync(out, `${JSON.stringify({ sha: buildSha, builtAt: buildDate }, null, 0)}\n`);
        },
      },
      {
        name: 'floor-pwa-cache-bust',
        transformIndexHtml: {
          order: 'post',
          handler(html) {
            const key = 'floor_shell_v12_20261109';
            const script = `(function(){try{var k=${JSON.stringify(key)};if(localStorage.getItem(k))return;localStorage.setItem(k,"1");var done=function(){location.reload()};if(window.caches&&caches.keys){caches.keys().then(function(ks){return Promise.all(ks.map(function(x){return caches.delete(x)}))}).then(done).catch(done)}else done()}catch(e){}})();`;
            return html.replace('</body>', `<script>${script}</script></body>`);
          },
        },
      },
    ],
    base: '/',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(url || ''),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(anon || ''),
      'import.meta.env.VITE_FLOOR_BUILD_SHA': JSON.stringify(buildSha),
      'import.meta.env.VITE_FLOOR_BUILD_DATE': JSON.stringify(buildDate),
    },
  };
});
