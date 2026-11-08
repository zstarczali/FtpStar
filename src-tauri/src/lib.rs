mod commands;
pub mod conn;
pub mod ftp;
pub mod onedrive;
pub mod s3;
pub mod settings;
pub mod sftp;
pub mod xfer;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // macOS: only the application menu and Edit (needed for Cmd+C/V in fields)
    #[cfg(target_os = "macos")]
    let builder = builder.enable_macos_default_menu(false).menu(|app| {
        use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
        let app_menu = Submenu::with_items(app, "FtpStar", true, &[
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ])?;
        let edit = Submenu::with_items(app, "Edit", true, &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ])?;
        Menu::with_items(app, &[&app_menu, &edit])
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(commands::window_state_flags())
                .with_denylist(&["splashscreen"])
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("FtpStar"));
            app.manage(AppState::new(settings::Store::load(dir)));
            // the windows are created only now, so their first calls find the state
            for label in ["splashscreen", "main"] {
                if let Err(e) = commands::create_window(app.handle(), label) {
                    eprintln!("FtpStar: could not create the {label} window: {e}");
                }
            }
            // fallback: never leave the user with only the splash
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                commands::finish_splash(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "splashscreen" && matches!(event, tauri::WindowEvent::Destroyed) {
                commands::finish_splash(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_sites,
            commands::save_sites,
            commands::app_info,
            commands::set_zoom,
            commands::ui_ready,
            commands::local_home,
            commands::local_list,
            commands::local_mkdir,
            commands::local_remove,
            commands::local_rename,
            commands::local_stat,
            commands::local_walk,
            commands::temp_dir,
            commands::open_path,
            commands::reveal_path,
            commands::open_url,
            commands::connect,
            commands::disconnect,
            commands::remote_list,
            commands::remote_walk,
            commands::remote_mkdir,
            commands::remote_remove,
            commands::remote_rename,
            commands::transfer,
            commands::cancel_transfer,
            commands::onedrive_device_start,
            commands::onedrive_device_poll,
            commands::clipboard_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FtpStar");
}
