import { defineConfig } from 'tsup';

const cjsInteropFooter = `
if (typeof module !== "undefined" && typeof index_exports !== "undefined" && typeof index_default !== "undefined") {
  var _cjsExport = index_default;
  for (var _k of Object.keys(index_exports)) {
    if (_k !== "default" && !Object.prototype.hasOwnProperty.call(_cjsExport, _k)) {
      Object.defineProperty(_cjsExport, _k, {
        get: (function(key) { return function() { return index_exports[key]; }; })(_k),
        enumerable: true,
        configurable: true
      });
    }
  }
  Object.defineProperty(_cjsExport, "default", {
    value: index_default,
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.defineProperty(_cjsExport, "__esModule", {
    value: true,
    enumerable: false,
    configurable: true
  });
  module.exports = _cjsExport;
}
`;

export default defineConfig({
  entry: ['js/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  outExtension({ format }) {
    return {
      js: format === 'cjs' ? '.cjs' : '.mjs',
    };
  },
  cjsInterop: true,
  shims: true,
  splitting: false,
  esbuildOptions(options, context) {
    if (context.format === 'cjs') {
      options.footer = {
        ...options.footer,
        js: `${options.footer?.js ?? ''}\n${cjsInteropFooter}`,
      };
    }
  },
});
