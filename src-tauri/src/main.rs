// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if arca_lib::is_native_host() {
        return arca_lib::run_native_host();
    }
    arca_lib::run()
}
