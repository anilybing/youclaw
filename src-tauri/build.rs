fn main() {
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
