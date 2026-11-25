# Fuzzing rxpress-native

cargo-fuzz (libFuzzer) targets for the parsing/decoding code. Internals are exposed through the
`fuzzing` cargo feature (`rxpress_native::fuzz_api`), which is off in normal and release builds.

| Target | Entry point | Input layout |
| --- | --- | --- |
| `http_head` | `http_parse::try_parse_request` | u16 max_headers, u16 max_size, head bytes |
| `chunked` | `http_parse::read_chunked_body` (tokio current-thread, in-memory duplex) | 4 cap bytes, stream |
| `range` | `parse_single_range`, `if_range_matches`, `etag_matches` | u64 file size, three strings split on U+FFFD |
| `sendfile_payload` | `decode_sendfile_payload` | selector byte, payload |
| `response_batch` | `protocol::dispatch_response_batch` + header validators | selector byte, batch |

## Running

```sh
cd /path/to/rxpress
cargo +nightly fuzz run -s none http_head -- -max_total_time=180 -max_len=8192
```

`-s none` is required: the crate also builds as a `cdylib` (napi addon) and that fails to link with
AddressSanitizer. Coverage instrumentation, debug assertions and overflow checks stay on, so
panics and arithmetic overflows are still found. `fuzz/build.rs` lets the fuzz binaries link
without the N-API symbols Node would normally provide.

Targets: `http_head`, `chunked`, `range`, `sendfile_payload`, `response_batch`.

Seed corpora live in `fuzz/corpus/<target>/seed_*`; other generated corpus files and `artifacts/`
are git-ignored. Reproduce a crash with
`cargo +nightly fuzz run -s none <target> fuzz/artifacts/<target>/crash-...`.
Commit minimized reproducers to `fuzz/regressions/<target>/`.
