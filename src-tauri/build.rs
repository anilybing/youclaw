// [XJC-PATCH] Build-time updater key/provenance metadata.
use std::process::Command;

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir("..")
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn emit_build_metadata() {
    println!("cargo:rerun-if-env-changed=XJC_UPDATE_BASE");
    println!("cargo:rerun-if-env-changed=XJC_PORTABLE_UPDATE_PUBLIC_KEY_ID");
    println!("cargo:rerun-if-env-changed=XJC_PORTABLE_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=XJC_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=XJC_BUILD_DIRTY");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=../web/src");

    let commit = std::env::var("XJC_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git_output(&["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());
    let commit = commit.trim();
    let commit = if commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        commit
    } else {
        "unknown"
    };
    let dirty = std::env::var("XJC_BUILD_DIRTY")
        .ok()
        .and_then(|value| value.parse::<bool>().ok())
        .unwrap_or_else(|| {
            git_output(&["status", "--porcelain"])
                .map(|status| !status.is_empty())
                .unwrap_or(true)
        });
    println!("cargo:rustc-env=XJC_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=XJC_BUILD_DIRTY={dirty}");
}

fn main() {
    emit_build_metadata();
    #[cfg(target_os = "windows")]
    {
        let mut res = tauri_build::WindowsAttributes::new();
        res = res.app_manifest(include_str!("app.manifest"));
        let attrs = tauri_build::Attributes::new().windows_attributes(res);
        tauri_build::try_build(attrs).expect("failed to run tauri build");
    }
    #[cfg(not(target_os = "windows"))]
    {
        tauri_build::build()
    }
}
