// rxpress-native is a napi addon: its N-API symbols are normally provided by the Node binary at
// load time. The fuzz binaries link the rlib but never call into N-API, so let the linker leave
// those symbols unresolved.
fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "macos" {
        println!("cargo:rustc-link-arg-bins=-Wl,-undefined,dynamic_lookup");
    } else if os == "linux" {
        println!("cargo:rustc-link-arg-bins=-Wl,--unresolved-symbols=ignore-all");
    }
}
