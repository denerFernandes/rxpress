import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

describe('Dual ESM + CommonJS Package Exports', () => {
  it('loads and serves requests via CommonJS require("dist/index.cjs")', async () => {
    const req = createRequire(import.meta.url);
    const cjsExpress = req(join(process.cwd(), 'dist', 'index.cjs'));
    const factory = typeof cjsExpress === 'function' ? cjsExpress : cjsExpress.default;
    expect(typeof factory).toBe('function');
    expect(typeof factory.Router).toBe('function');
    expect(typeof factory.json).toBe('function');
    expect(typeof factory.static).toBe('function');

    const app = factory();
    app.get('/cjs', (_req: unknown, res: { json: (v: unknown) => void }) => {
      res.json({ format: 'cjs' });
    });
    const srv = app.listen(0, '127.0.0.1');
    try {
      const port = srv.address()!.port;
      const resp = await fetch(`http://127.0.0.1:${port}/cjs`);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ format: 'cjs' });
    } finally {
      await srv.close();
    }
  });

  it('loads and serves requests via ESM import("dist/index.mjs")', async () => {
    const esm = await import(join(process.cwd(), 'dist', 'index.mjs'));
    const factory = esm.default;
    expect(typeof factory).toBe('function');
    expect(typeof factory.Router).toBe('function');

    const app = factory();
    app.get('/esm', (_req: unknown, res: { json: (v: unknown) => void }) => {
      res.json({ format: 'esm' });
    });
    const srv = app.listen(0, '127.0.0.1');
    try {
      const port = srv.address()!.port;
      const resp = await fetch(`http://127.0.0.1:${port}/esm`);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ format: 'esm' });
    } finally {
      await srv.close();
    }
  });
});
