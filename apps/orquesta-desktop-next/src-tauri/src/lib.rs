mod asset_catalog;
mod attachment_classification;
mod attachment_guard;
mod attachments;
mod commands;
mod dispatch_recovery;
mod error;
mod instance_lock;
mod logging;
mod paths;
mod process_containment;
mod projection_bridge;
mod projection_service;
mod protocol;
mod registry;
mod settings;
mod sidecar;
mod starter_creation;
mod storage;
mod validation;
mod voice;

include!("../../../../packages/contracts/generated/desktop/native_bridge_handler.rs");

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use commands::NativeState;

fn begin_confirmed_shutdown(app: AppHandle) {
    let state = app.state::<NativeState>();
    if state
        .exit_lifecycle_state
        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = {
            let state = app.state::<NativeState>();
            commands::shutdown_for_exit(&state).await
        };
        let state = app.state::<NativeState>();
        match result {
            Ok(()) => {
                state.exit_lifecycle_state.store(2, Ordering::Release);
                app.exit(0);
            }
            Err(error) => {
                // Never leave an invisible Desktop process behind.  The close
                // request is held until native shutdown is confirmed; if it is
                // not, restore command admission and keep the main window usable
                // so the user can retry or inspect the fault.
                eprintln!("Orquesta Next shutdown blocked: {error}");
                state.exit_lifecycle_state.store(0, Ordering::Release);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
    });
}

pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let native = NativeState::open(app.handle())?;
            app.manage(native);
            if std::env::var("ORQUESTA_MEASURE_MODE").ok().as_deref() == Some("1")
                && std::env::var("ORQUESTA_MEASURE_HEADLESS").ok().as_deref() == Some("1")
            {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| std::io::Error::other("measurement window is unavailable"))?;
                window.hide()?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<NativeState>();
                if state.exit_lifecycle_state.load(Ordering::Acquire) != 2 {
                    api.prevent_close();
                    begin_confirmed_shutdown(window.app_handle().clone());
                }
            }
        })
        .invoke_handler(generated_native_bridge_handler!())
        .build(tauri::generate_context!())
        .expect("failed to build Orquesta Desktop Next");

    application.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let state = app.state::<NativeState>();
            if state.exit_lifecycle_state.load(Ordering::Acquire) == 2 {
                return;
            }
            api.prevent_exit();
            begin_confirmed_shutdown(app.clone());
        }
    });
}

pub fn entrypoint() {
    #[cfg(all(windows, debug_assertions))]
    if let Some(exit_code) = process_containment::run_containment_canary_if_requested() {
        std::process::exit(exit_code);
    }
    if let Some(exit_code) = process_containment::run_contained_launcher_if_requested() {
        std::process::exit(exit_code);
    }
    run();
}
