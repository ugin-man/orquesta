fn main() {
    // Tauri command completion and WebView2 IPC run on the Windows main
    // thread.  The default PE reserve (1 MiB) is insufficient for the
    // production-optimized command graph and can overflow while returning an
    // otherwise valid project-selection response.  This reserves address
    // space only; committed stack pages still grow on demand.
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() == Some("msvc")
    {
        println!("cargo:rustc-link-arg-bin=orquesta-desktop-next=/STACK:8388608");
    }
    tauri_build::build()
}
