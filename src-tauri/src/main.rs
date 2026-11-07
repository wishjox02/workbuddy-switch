// Keep the desktop client a GUI subsystem in both debug and release builds.
// Otherwise every locally generated debug client opens an extra console window.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    wb_switch_rust_lib::run()
}
