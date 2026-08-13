import { defineConfig } from 'vite';

// COOP/COEP を立てて SharedArrayBuffer を有効化する。
// 密度場・地質場をメッシュ化ワーカーからゼロコピーで読むために必要。
// これらが無い環境では VoxelField 側が自動で ArrayBuffer にフォールバックし、
// ChunkManager が padded ブロックのコピー転送に切り替わる。
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use((_req: unknown, res: Record<string, unknown>, next: () => void) => {
      const setHeader = res.setHeader as (k: string, v: string) => void;
      setHeader.call(res, 'Cross-Origin-Opener-Policy', 'same-origin');
      setHeader.call(res, 'Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
  configurePreviewServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use((_req: unknown, res: Record<string, unknown>, next: () => void) => {
      const setHeader = res.setHeader as (k: string, v: string) => void;
      setHeader.call(res, 'Cross-Origin-Opener-Policy', 'same-origin');
      setHeader.call(res, 'Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

export default defineConfig({
  plugins: [crossOriginIsolation],
  server: { host: '127.0.0.1', port: 5173 },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
