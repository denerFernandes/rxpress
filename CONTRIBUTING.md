# Contributing

Thanks for helping. rxpress is an Express 5 compatible server with a Rust engine, so most changes are judged against one question: does it behave like Express 5, and does it keep the memory and CPU savings that are the reason the project exists.

## Setup

You need Node.js 22 or newer and a stable Rust toolchain. [`wrk`](https://github.com/wg/wrk) is only needed for the benchmarks.

```bash
npm install
npm run build        # Rust addon (release) and the TypeScript layer
```

## Checks

Run these before opening a pull request. CI runs them on Linux, macOS and Windows.

```bash
npm run lint         # cargo fmt --check, cargo clippy -D warnings, tsc --noEmit
cargo test           # engine unit tests
npm test             # unit and compatibility tests
npm run test:e2e     # end-to-end tests against the built package
npm run test:express # Express 5's own test suite run against rxpress
```

`npm run test:express` fails on any Express test that is not listed in `test/express-suite/known-failures.json`. If you fix one of the listed tests, remove it from the file (`node scripts/run-express-suite.mjs --update` rewrites it).

## Pull requests

- Keep a change focused; unrelated cleanups go in their own pull request.
- Add a test that fails without the change. For behaviour that differs from Express, check the real Express first and say what you compared in the description.
- Put user-visible changes under `Unreleased` in `CHANGELOG.md`.
- A claim about memory, CPU or throughput needs a number: `RUNS=5 npm run bench:resources` compares against Express 5 and reports medians. Say which machine produced it.
- Keep documentation and commit messages in English. A commit message is an imperative summary of at most 72 characters, then a body that explains why.

## Reporting bugs and vulnerabilities

Bugs go in an issue (the template asks for the details that matter). Vulnerabilities must not: see [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

1. Set the new version in `package.json`, run `npm run version-sync` and move the `Unreleased` entries in `CHANGELOG.md` under the new version.
2. Merge it and wait for CI to pass on that commit.
3. Tag the commit `vX.Y.Z` and push the tag. The release workflow checks that CI passed for the commit and that the tag matches `package.json`, builds the seven native binaries, publishes the platform packages and then `@rxpress/rxpress` with provenance, and creates the GitHub release from the changelog.

A published version cannot be reused. If a release fails halfway, fix the cause and re-run the failed jobs: publishing skips packages that already exist.
