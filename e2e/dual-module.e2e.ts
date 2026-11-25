import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect } from 'vitest';
import { createTempWorkspace, setupConsumerPackage, type TempWorkspace } from './helpers/fixtures.js';
import { itRxpress } from './helpers/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
// Run tsc through node so it works on Windows too (no .cmd shim needed).
const TSC_JS = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const workspaces: TempWorkspace[] = [];

function makeWorkspace(prefix: string): TempWorkspace {
  const ws = createTempWorkspace(prefix);
  workspaces.push(ws);
  return ws;
}

function runNode(
  scriptPath: string,
  cwd: string
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function runTsc(
  cwd: string,
  args: string[] = ['--noEmit']
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TSC_JS, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

afterEach(() => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop();
    ws?.cleanup();
  }
});

const INTERNAL_DECLARATION_NAMES = new Set([
  'ResponseBatchWriter',
  'NativeServerInstance',
  'NativeServerConfig',
  'NativeStaticMount',
  'NativeBodyRule',
  'NativeTlsConfig',
  'NativeAddressInfo',
  'NativeServerMetrics',
  'NativeMiddlewareMeta',
]);

const ALLOWED_GLOBAL_UNDERSCORE_NAMES = new Set(['__dirname', '__filename']);

function getPropertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return expr.text;
    }
  }
  return null;
}

function getContainerLabel(
  node: ts.ClassDeclaration | ts.ClassExpression | ts.InterfaceDeclaration | ts.TypeLiteralNode
): string {
  if (ts.isTypeLiteralNode(node)) {
    return '<type-literal>';
  }
  return node.name?.text ?? '<anonymous>';
}

function collectLeakedDeclarationSymbols(sourceText: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const leaked = new Set<string>();

  const checkDeclName = (name: string | undefined) => {
    if (!name || ALLOWED_GLOBAL_UNDERSCORE_NAMES.has(name)) return;
    if (name.startsWith('_') || INTERNAL_DECLARATION_NAMES.has(name)) {
      leaked.add(name);
    }
  };

  const inspectMembers = (
    containerName: string,
    members: ts.NodeArray<ts.ClassElement | ts.TypeElement>
  ) => {
    for (const member of members) {
      if (
        ts.isPropertyDeclaration(member) ||
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member) ||
        ts.isPropertySignature(member) ||
        ts.isMethodSignature(member)
      ) {
        const propName = getPropertyNameText(member.name);
        if (propName && propName.startsWith('_')) {
          leaked.add(`${containerName}.${propName}`);
        }
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      checkDeclName(node.name?.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      checkDeclName(node.name.text);
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        checkDeclName(spec.name.text);
        if (spec.propertyName) {
          checkDeclName(spec.propertyName.text);
        }
      }
    }

    if (
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeLiteralNode(node)
    ) {
      inspectMembers(getContainerLabel(node), node.members);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return [...leaked];
}

describe('Dual-Module Loading (ESM/CJS) & Strict TypeScript Declarations', () => {
  itRxpress(
    'ESM child process imports rxpress, boots server on port 0, serves /esm -> 200',
    () => {
      const ws = makeWorkspace('rxpress-fg07-t1-01-');
      setupConsumerPackage(ws, REPO_ROOT, { type: 'module' });

      const script = ws.writeFile(
        'app.mjs',
        `
import rxpress, { Router, json, serveStatic, createHttpsServer } from 'rxpress';

if (typeof rxpress !== 'function') throw new Error('rxpress default is not a function');
if (typeof Router !== 'function') throw new Error('Router is not a function');
if (typeof json !== 'function') throw new Error('json is not a function');
if (typeof serveStatic !== 'function') throw new Error('serveStatic is not a function');
if (typeof createHttpsServer !== 'function') throw new Error('createHttpsServer is not a function');

const app = rxpress();
app.use(json());
const router = rxpress.Router();
router.get('/esm', (_req, res) => res.json({ ok: true }));
app.use(router);

const srv = app.listen(0, '127.0.0.1');
try {
  const port = srv.address().port;
  const resp = await fetch(\`http://127.0.0.1:\${port}/esm\`);
  if (resp.status !== 200) throw new Error('Unexpected status: ' + resp.status);
  const body = await resp.json();
  if (body.ok !== true) throw new Error('Unexpected body: ' + JSON.stringify(body));
} finally {
  await srv.close();
}
`
      );

      const res = runNode(script, ws.dir);
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
  );

  itRxpress(
    'CJS child process requires rxpress as callable factory with Router/json/static and serves /cjs -> 200',
    () => {
      const ws = makeWorkspace('rxpress-fg07-t1-02-');
      setupConsumerPackage(ws, REPO_ROOT, { type: 'commonjs' });
      const pubDir = ws.mkdir('public');
      ws.writeFile('public/hello.txt', 'hello-cjs');

      const script = ws.writeFile(
        'app.cjs',
        `
const rxpress = require('rxpress');

if (typeof rxpress !== 'function') {
  throw new Error('Expected require("rxpress") to be a callable function, got ' + typeof rxpress);
}
if (typeof rxpress.Router !== 'function') throw new Error('rxpress.Router missing');
if (typeof rxpress.json !== 'function') throw new Error('rxpress.json missing');
if (typeof rxpress.static !== 'function') throw new Error('rxpress.static missing');

const app = rxpress();
app.use(rxpress.json());
app.use('/static', rxpress.static(${JSON.stringify(pubDir)}));
const router = rxpress.Router();
router.get('/cjs', (_req, res) => res.json({ ok: true }));
app.use(router);

(async () => {
  const srv = app.listen(0, '127.0.0.1');
  try {
    const port = srv.address().port;
    const resp = await fetch(\`http://127.0.0.1:\${port}/cjs\`);
    if (resp.status !== 200) throw new Error('Unexpected status: ' + resp.status);
    const body = await resp.json();
    if (body.ok !== true) throw new Error('Unexpected body: ' + JSON.stringify(body));

    const st = await fetch(\`http://127.0.0.1:\${port}/static/hello.txt\`);
    if (st.status !== 200 || (await st.text()) !== 'hello-cjs') {
      throw new Error('Unexpected static response');
    }
  } finally {
    await srv.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`
      );

      const res = runNode(script, ws.dir);
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
  );

  itRxpress(
    'ESM TypeScript consumer (NodeNext, strict: true) compiles with zero diagnostics',
    () => {
      const ws = makeWorkspace('rxpress-fg07-t1-03-');
      setupConsumerPackage(ws, REPO_ROOT, {
        type: 'module',
        linkDeps: [
          'cors',
          'helmet',
          'morgan',
          '@types/cors',
          '@types/morgan',
          '@types/node',
          '@types/express',
        ],
      });

      ws.writeFile(
        'tsconfig.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ['./app.ts'],
          },
          null,
          2
        )
      );

      ws.writeFile(
        'app.ts',
        `
import rxpress, {
  Router,
  json,
  type ErrorRequestHandler,
  type RequestHandler,
} from 'rxpress';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

const app = rxpress();
app.use(json());
app.use(cors());
app.use(helmet());
app.use(morgan('tiny'));

const router = rxpress.Router();
const ping: RequestHandler = (_req, res) => {
  res.json({ ok: true });
};
router.get('/ping', ping);
router.get('/auto', (req, res) => {
  res.json({ path: req.path });
});
app.use('/api', router);
export type { Router };

const errMw: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(500).json({ error: String(err) });
};
app.use(errMw);

export function start(): void {
  const srv = app.listenTls(
    { key: Buffer.from('key'), cert: Buffer.from('cert') },
    0,
    '127.0.0.1'
  );
  void srv.close();
}
`
      );

      const res = runTsc(ws.dir);
      expect(res.stdout + res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
  );

  itRxpress(
    'CJS TypeScript consumer (CommonJS + NodeNext CJS) compiles and resolves dist/index.d.cts cleanly',
    () => {
      const ws = makeWorkspace('rxpress-fg07-t1-04-');
      setupConsumerPackage(ws, REPO_ROOT, {
        type: 'commonjs',
        linkDeps: ['@types/node'],
      });

      // 1) Classic CommonJS / node resolution check
      ws.writeFile(
        'tsconfig.commonjs.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'CommonJS',
              moduleResolution: 'node',
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ['./cjs-classic.ts'],
          },
          null,
          2
        )
      );

      ws.writeFile(
        'cjs-classic.ts',
        `
import rxpress, { type ServerHandle, type RequestHandler } from 'rxpress';

const app = rxpress();
const handler: RequestHandler = (_req, res) => {
  res.json({ ok: true });
};
app.get('/cjs-ts', handler);

export function boot(): ServerHandle {
  return app.listen(0, '127.0.0.1');
}
`
      );

      // 2) NodeNext CJS resolution verifying package.json exports["."].require.types -> dist/index.d.cts
      ws.writeFile(
        'tsconfig.nodenext.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ['./cjs-nodenext.ts'],
          },
          null,
          2
        )
      );

      ws.writeFile(
        'cjs-nodenext.ts',
        `
import rxpress = require('rxpress');
import type { ServerHandle, RequestHandler } from 'rxpress';

const app = rxpress();
const handler: RequestHandler = (_req, res) => {
  res.json({ ok: true });
};
app.get('/cjs-nodenext', handler);

export function boot(): ServerHandle {
  return app.listen(0, '127.0.0.1');
}
`
      );

      const classicRes = runTsc(ws.dir, ['-p', 'tsconfig.commonjs.json', '--noEmit']);
      expect(classicRes.stdout + classicRes.stderr).toBe('');
      expect(classicRes.status).toBe(0);

      const nodeNextRes = runTsc(ws.dir, [
        '-p',
        'tsconfig.nodenext.json',
        '--noEmit',
        '--listFiles',
      ]);
      expect(nodeNextRes.stderr).toBe('');
      expect(nodeNextRes.status).toBe(0);
      expect(nodeNextRes.stdout).toContain('dist/index.d.cts');
    }
  );

  itRxpress(
    'package.json exports["."] defines import/require types and loads cleanly in Node via import() and require()',
    () => {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        exports?: Record<string, Record<string, unknown>>;
      };

      const rootExport = pkg.exports?.['.'];
      expect(rootExport).toBeDefined();
      expect(rootExport?.import).toEqual({
        types: './dist/index.d.ts',
        default: './dist/index.mjs',
      });
      expect(rootExport?.require).toEqual({
        types: './dist/index.d.cts',
        default: './dist/index.cjs',
      });

      const ws = makeWorkspace('rxpress-fg07-t1-05-');
      setupConsumerPackage(ws, REPO_ROOT, { type: 'module' });

      const script = ws.writeFile(
        'dual-load.mjs',
        `
import { createRequire } from 'node:module';

const esm = await import('rxpress');
if (typeof esm.default !== 'function') {
  throw new Error('ESM default export is not a function: ' + typeof esm.default);
}

const require = createRequire(import.meta.url);
const cjs = require('rxpress');
if (typeof cjs !== 'function') {
  throw new Error('CJS require("rxpress") is not a function: ' + typeof cjs);
}
`
      );

      const res = runNode(script, ws.dir);
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
  );

  itRxpress(
    'negative @ts-expect-error checks catch invalid path, status, port, and TlsOptions in strict TS',
    () => {
      const ws = makeWorkspace('rxpress-fg07-t2-01-');
      setupConsumerPackage(ws, REPO_ROOT, {
        type: 'module',
        linkDeps: ['@types/node'],
      });

      ws.writeFile(
        'tsconfig.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ['./neg.ts'],
          },
          null,
          2
        )
      );

      ws.writeFile(
        'neg.ts',
        `
import rxpress, { type Request, type Response, type TlsOptions } from 'rxpress';

const app = rxpress();

// @ts-expect-error numeric route path is invalid
app.get(123, (_req: Request, res: Response) => {
  res.send('bad');
});

app.get('/bad-status', (_req, res) => {
  // @ts-expect-error string status code is invalid
  res.status('bad');
});

// @ts-expect-error string port is invalid
app.listen('not-a-port');

// @ts-expect-error TlsOptions requires key
const invalidTls: TlsOptions = { cert: Buffer.from('only-cert') };
void invalidTls;
`
      );

      const res = runTsc(ws.dir);
      expect(res.stdout + res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
  );

  itRxpress(
    'dist/index.d.ts and dist/index.d.cts do not expose internal _-prefixed or private bridge symbols',
    () => {
      const dts = readFileSync(join(REPO_ROOT, 'dist', 'index.d.ts'), 'utf8');
      const dcts = readFileSync(join(REPO_ROOT, 'dist', 'index.d.cts'), 'utf8');

      const dtsLeaks = collectLeakedDeclarationSymbols(dts, 'index.d.ts');
      const dctsLeaks = collectLeakedDeclarationSymbols(dcts, 'index.d.cts');

      expect(
        dtsLeaks,
        `dist/index.d.ts leaked internal symbols: ${dtsLeaks.join(', ')}`
      ).toEqual([]);
      expect(
        dctsLeaks,
        `dist/index.d.cts leaked internal symbols: ${dctsLeaks.join(', ')}`
      ).toEqual([]);
    }
  );

  itRxpress(
    'CJS default callable and named destructuring interop both work without .default boilerplate',
    () => {
      const ws = makeWorkspace('rxpress-fg07-t2-03-');
      setupConsumerPackage(ws, REPO_ROOT, { type: 'commonjs' });

      const script = ws.writeFile(
        'interop.cjs',
        `
const rxpress = require('rxpress');
const { rxpress: namedRx, Router, json } = require('rxpress');

if (typeof rxpress !== 'function') {
  throw new Error('Default require("rxpress") must be callable function, got ' + typeof rxpress);
}
if (typeof namedRx !== 'function') {
  throw new Error('Named { rxpress } must be a function, got ' + typeof namedRx);
}
if (typeof Router !== 'function') throw new Error('Named { Router } missing');
if (typeof json !== 'function') throw new Error('Named { json } missing');
if (rxpress !== namedRx) throw new Error('Default and named rxpress should reference same factory');

(async () => {
  const app = rxpress();
  const r = rxpress.Router();
  app.use(json());
  r.get('/interop', (_req, res) => res.json({ interop: true }));
  app.use(r);

  const srv = app.listen(0, '127.0.0.1');
  try {
    const port = srv.address().port;
    const resp = await fetch(\`http://127.0.0.1:\${port}/interop\`);
    if (resp.status !== 200) throw new Error('Unexpected status: ' + resp.status);
    const data = await resp.json();
    if (data.interop !== true) throw new Error('Unexpected payload');
  } finally {
    await srv.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`
      );

      const res = runNode(script, ws.dir);
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
  );

  itRxpress(
    'strict TS validates app.get(setting), unannotated route handlers, nested MiddlewareLike arrays, and errorHandler',
    () => {
      const ws = makeWorkspace('rxpress-fg07-t2-04-');
      setupConsumerPackage(ws, REPO_ROOT, {
        type: 'module',
        linkDeps: ['@types/node'],
      });

      ws.writeFile(
        'tsconfig.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ['./overloads.ts'],
          },
          null,
          2
        )
      );

      ws.writeFile(
        'overloads.ts',
        `
import rxpress, {
  Router,
  type RequestHandler,
  type ErrorRequestHandler,
} from 'rxpress';

const app = rxpress();
const env = app.get('env');

const mw1: RequestHandler = (_req, _res, next) => {
  next();
};
const mw2: RequestHandler = (_req, _res, next) => {
  next();
};
const subRouter = rxpress.Router();
subRouter.get('/sub', (req, res) => {
  res.json({ path: req.path });
});
export type { Router };

app.use([mw1, [mw2, subRouter]]);

app.get('/path', (req, res) => {
  res.json({ env, url: req.url });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
};
app.use(errorHandler);
`
      );

      const res = runTsc(ws.dir);
      expect(res.stdout + res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
  );

  itRxpress(
    'ESM and CJS child processes load native addon and serve /health -> 200 regardless of process.cwd()',
    () => {
      const outsideCwd = makeWorkspace('rxpress-fg07-t2-05-cwd-');
      const consumerWs = makeWorkspace('rxpress-fg07-t2-05-pkg-');
      const distMjs = join(REPO_ROOT, 'dist', 'index.mjs');
      const distCjs = join(REPO_ROOT, 'dist', 'index.cjs');

      const esmScript = consumerWs.writeFile(
        'cwd-esm.mjs',
        `
import rxpress from ${JSON.stringify(distMjs)};

const app = rxpress();
app.get('/health', (_req, res) => res.json({ status: 'ok', cwd: process.cwd() }));

const srv = app.listen(0, '127.0.0.1');
try {
  const port = srv.address().port;
  const resp = await fetch(\`http://127.0.0.1:\${port}/health\`);
  if (resp.status !== 200) throw new Error('Unexpected ESM status: ' + resp.status);
  const body = await resp.json();
  if (body.status !== 'ok') throw new Error('Unexpected ESM body');
} finally {
  await srv.close();
}
`
      );

      const cjsScript = consumerWs.writeFile(
        'cwd-cjs.cjs',
        `
const mod = require(${JSON.stringify(distCjs)});
const rxpress = typeof mod === 'function' ? mod : mod.default;

const app = rxpress();
app.get('/health', (_req, res) => res.json({ status: 'ok', cwd: process.cwd() }));

(async () => {
  const srv = app.listen(0, '127.0.0.1');
  try {
    const port = srv.address().port;
    const resp = await fetch(\`http://127.0.0.1:\${port}/health\`);
    if (resp.status !== 200) throw new Error('Unexpected CJS status: ' + resp.status);
    const body = await resp.json();
    if (body.status !== 'ok') throw new Error('Unexpected CJS body');
  } finally {
    await srv.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`
      );

      const esmRes = runNode(esmScript, outsideCwd.dir);
      expect(esmRes.stderr).toBe('');
      expect(esmRes.status).toBe(0);

      const cjsRes = runNode(cjsScript, outsideCwd.dir);
      expect(cjsRes.stderr).toBe('');
      expect(cjsRes.status).toBe(0);
    }
  );
});
