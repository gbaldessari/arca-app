use std::{error::Error, thread, time::Duration};

use tauri::{AppHandle, Manager, WebviewWindow};
use windows::{
    core::{w, Array, HSTRING, PCWSTR},
    Security::{
        Credentials::{KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus},
        Cryptography::CryptographicBuffer,
    },
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION},
        UI::{
            Shell::{DefSubclassProc, SetWindowSubclass},
            WindowsAndMessaging::{
                FindWindowW, GetForegroundWindow, SetForegroundWindow, PBT_APMSUSPEND,
                WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK,
            },
        },
    },
};

const HELLO_KEY: &str = "com.arca.vault";

type LockHandler = (AppHandle, fn(&AppHandle));

/// Calls `on_lock` when the Windows session is locked or the machine is about to sleep.
pub fn on_session_lock(window: &WebviewWindow, on_lock: fn(&AppHandle)) -> Result<(), Box<dyn Error>> {
    unsafe extern "system" fn subclass(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        let locking = (msg == WM_WTSSESSION_CHANGE && wparam.0 == WTS_SESSION_LOCK as usize)
            || (msg == WM_POWERBROADCAST && wparam.0 == PBT_APMSUSPEND as usize);
        if locking {
            let (app, on_lock) = &*(data as *const LockHandler);
            on_lock(app);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    let hwnd = window.hwnd()?;
    // Leaked on purpose: the subclass lives as long as the window, which is the whole app.
    let data = Box::into_raw(Box::new((window.app_handle().clone(), on_lock) as LockHandler));
    unsafe {
        WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)?;
        SetWindowSubclass(hwnd, Some(subclass), 1, data as usize).ok()?;
    }
    Ok(())
}

pub fn hello_available() -> bool {
    KeyCredentialManager::IsSupportedAsync()
        .and_then(|op| op.join())
        .unwrap_or(false)
}

/// Signs `challenge` with the TPM-backed Windows Hello key, prompting for PIN or biometrics.
/// KeyCredential signs with RSA PKCS#1 v1.5, so a given challenge always yields the same bytes.
pub fn hello_sign(challenge: &[u8], create: bool) -> Result<Vec<u8>, String> {
    let name = HSTRING::from(HELLO_KEY);
    focus_hello_prompt();
    let retrieval = if create {
        KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::ReplaceExisting)
    } else {
        KeyCredentialManager::OpenAsync(&name)
    }
    .and_then(|op| op.join())
    .map_err(|e| e.to_string())?;
    check(retrieval.Status())?;
    let challenge = CryptographicBuffer::CreateFromByteArray(challenge).map_err(|e| e.to_string())?;
    let signed = retrieval
        .Credential()
        .and_then(|credential| credential.RequestSignAsync(&challenge))
        .and_then(|op| op.join())
        .map_err(|e| e.to_string())?;
    check(signed.Status())?;
    let mut signature = Array::<u8>::new();
    signed
        .Result()
        .and_then(|buffer| CryptographicBuffer::CopyToByteArray(&buffer, &mut signature))
        .map_err(|e| e.to_string())?;
    Ok(signature.to_vec())
}

pub fn hello_delete() {
    let _ = KeyCredentialManager::DeleteAsync(&HSTRING::from(HELLO_KEY)).and_then(|op| op.join());
}

fn check(status: windows::core::Result<KeyCredentialStatus>) -> Result<(), String> {
    match status.map_err(|e| e.to_string())? {
        KeyCredentialStatus::Success => Ok(()),
        KeyCredentialStatus::UserCanceled => Err("Cancelaste Windows Hello".into()),
        KeyCredentialStatus::NotFound => {
            Err("Windows Hello no está configurado para Arca en este equipo".into())
        }
        _ => Err("Windows Hello no pudo verificar tu identidad".into()),
    }
}

// Windows may open the Hello prompt behind desktop apps; the foreground app can hand it the focus.
// Each prompt is focused once, so the user can still switch away from it.
fn focus_hello_prompt() {
    thread::spawn(|| {
        let mut focused = HWND::default();
        for _ in 0..60 {
            thread::sleep(Duration::from_millis(250));
            unsafe {
                if let Ok(prompt) = FindWindowW(w!("Credential Dialog Xaml Host"), PCWSTR::null()) {
                    if GetForegroundWindow() == prompt {
                        focused = prompt;
                    } else if prompt != focused {
                        let _ = SetForegroundWindow(prompt);
                    }
                }
            }
        }
    });
}
