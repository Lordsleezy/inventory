import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const anon = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
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
