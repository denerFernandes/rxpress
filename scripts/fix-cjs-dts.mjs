// Rewrites the tail of dist/index.d.cts into the `function + namespace` + `export =` shape
// used by @types/express.
//
// tsup emits `export = rxpress;` followed by `export { ... }` (guarded by @ts-ignore), which is
// not valid for a CommonJS module: TypeScript then resolves `import type { Router } from 'rxpress'`
// to the *property* type `RxpressFactory['Router']` instead of the `Router` class, so CJS
// consumers using `moduleResolution: NodeNext` fail to type-check.
//
// The runtime CJS entry (see tsup.config.ts footer) exports the `rxpress` factory with every named
// export attached as a property, so the namespace below mirrors exactly that object.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../dist/index.d.cts', import.meta.url));
const src = readFileSync(file, 'utf8');

const exportRe = /\n\/\/ @ts-ignore\nexport = rxpress;\nexport \{([^}]*)\};\s*$/;
const m = exportRe.exec(src);
if (!m) {
  if (src.includes('declare namespace rxpress')) process.exit(0); // already rewritten
  throw new Error('fix-cjs-dts: unexpected dist/index.d.cts tail; update scripts/fix-cjs-dts.mjs');
}

const body = src.slice(0, m.index).replace(/\ndeclare const rxpress: RxpressFactory;\n/, '\n');
const entries = m[1].split(',').map((s) => s.trim()).filter(Boolean);

// Factory-object members whose runtime value differs from the same-named export.
const MEMBER_VALUE = {
  Router: 'createRouter',
  static: 'serveStatic',
};
// Express parity: these members are the prototypes, typed as instances.
const MEMBER_INSTANCE = {
  application: 'Application',
  request: 'RxRequest',
  response: 'RxResponse',
};

const outer = [];
const inner = [];
const typeNames = new Set();

for (const entry of entries) {
  const typeOnly = entry.startsWith('type ');
  const name = typeOnly ? entry.slice(5) : entry;
  if (name === 'rxpress') continue;
  const isClass = new RegExp(`\\ndeclare class ${name}\\b`).test(body);
  if (typeOnly || isClass) {
    const decl = new RegExp(`\\n(?:type|interface|declare class) ${name}(<[^>]*>)?`).exec(body);
    const params = decl?.[1] ?? '';
    const args = params
      ? `<${params.slice(1, -1).split(',').map((p) => p.trim().split(/[\s=]/)[0]).join(', ')}>`
      : '';
    outer.push(`type $${name}${params} = ${name}${args};`);
    inner.push(`    type ${name}${params} = $${name}${args};`);
    typeNames.add(name);
  }
  if (!typeOnly) {
    outer.push(`declare const $$${name}: typeof ${name};`);
    if (!(name in MEMBER_VALUE) && !(name in MEMBER_INSTANCE)) inner.push(`    var ${name}: typeof $$${name};`);
  }
}
for (const [member, valueOf] of Object.entries(MEMBER_VALUE)) {
  inner.push(`    var ${member}: typeof $$${valueOf};`);
}
for (const [member, typeOf] of Object.entries(MEMBER_INSTANCE)) {
  inner.push(`    var ${member}: $${typeOf};`);
}
if (!typeNames.has('RxpressFactory')) {
  outer.push('type $RxpressFactory = RxpressFactory;');
  inner.push('    type RxpressFactory = $RxpressFactory;');
}

const out = `${body}
${outer.join('\n')}
declare function rxpress(): Application;
declare namespace rxpress {
${inner.join('\n')}
}

export = rxpress;
`;
writeFileSync(file, out);
