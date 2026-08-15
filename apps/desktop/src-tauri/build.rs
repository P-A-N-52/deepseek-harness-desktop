fn main() {
    // Re-embed the shell pages whenever the frontend directory changes.
    // tauri-build does not declare the frontendDist directory itself, so a
    // stale `tauri-codegen-assets` OUT_DIR would silently ship a binary whose
    // initial page resolves to "asset not found" (a blank window).
    println!("cargo:rerun-if-changed=ui");
    tauri_build::build()
}
