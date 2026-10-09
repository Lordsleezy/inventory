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
  if (mode === 'production' && (!url || !anon)) throw new Error('Admin build requires Supabase URL and anon key');
  return {
    plugins: [react()],
    base: '/',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(url || ''),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(anon || '')
    }
  };
});
