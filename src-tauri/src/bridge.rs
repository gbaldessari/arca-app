//! Connects the browser extension with the running app, entirely on this machine.
//!
//! Browsers start `arca.exe` as a native messaging host; in that mode it only relays each message
//! to the running app over a loopback socket. Every line on that socket is sealed with a key that
//! is new on each app start and lives in a file only the current Windows user can read, so another
//! process listening on the port only ever sees ciphertext.

use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305};
use rand::RngExt;
use serde_json::{json, Value};
use windows::{
    core::{HSTRING, PCWSTR},
    Win32::System::Registry::{RegDeleteKeyW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ},
};

use crate::{decrypt, encrypt, err, os_rng};

const HOST_NAME: &str = "com.arca.vault";
const CHROME_ORIGIN: &str = "chrome-extension://jnjphfockignkgdhnlpmobbcgchmbeab/";
const FIREFOX_ID: &str = "arca@arca.vault";
const MAX_MESSAGE: usize = 1 << 20;
const NOT_RUNNING: &str = "Arca no está abierta";
const REGISTRY_KEYS: [&str; 3] = [
    r"Software\Google\Chrome\NativeMessagingHosts\com.arca.vault",
    r"Software\Microsoft\Edge\NativeMessagingHosts\com.arca.vault",
    r"Software\Mozilla\NativeMessagingHosts\com.arca.vault",
];

fn data_dir() -> PathBuf {
    PathBuf::from(env::var_os("LOCALAPPDATA").unwrap_or_default()).join(HOST_NAME)
}

pub fn bridge_file() -> PathBuf {
    data_dir().join("bridge.json")
}

/// Browsers start the host with the extension's origin (Chrome, Edge) or ID (Firefox) as an argument.
pub fn is_native_host() -> bool {
    env::args().skip(1).any(|arg| arg == CHROME_ORIGIN || arg == FIREFOX_ID)
}

/// Relays native messages (32-bit length + JSON) between the browser and the running app.
pub fn run_native_host() {
    let (mut input, mut output) = (io::stdin().lock(), io::stdout().lock());
    while let Some(message) = read_message(&mut input) {
        let reply = forward(&bridge_file(), &message).unwrap_or_else(|e| json!({ "error": e }).to_string());
        if write_message(&mut output, &reply).is_err() {
            break;
        }
    }
}

fn read_message(input: &mut impl Read) -> Option<String> {
    let mut len = [0u8; 4];
    input.read_exact(&mut len).ok()?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_MESSAGE {
        return None;
    }
    let mut body = vec![0; len];
    input.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

fn write_message(output: &mut impl Write, message: &str) -> io::Result<()> {
    output.write_all(&(message.len() as u32).to_le_bytes())?;
    output.write_all(message.as_bytes())?;
    output.flush()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

fn seal(cipher: &XChaCha20Poly1305, message: &str) -> Result<String, String> {
    Ok(to_hex(&encrypt(cipher, message.as_bytes())?))
}

fn open(cipher: &XChaCha20Poly1305, line: &str) -> Result<String, String> {
    let data = from_hex(line.trim()).ok_or("Mensaje dañado")?;
    String::from_utf8(decrypt(cipher, &data)?).map_err(err)
}

fn forward(bridge: &Path, message: &str) -> Result<String, String> {
    let info: Value = fs::read_to_string(bridge)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or(NOT_RUNNING)?;
    let cipher = info["key"]
        .as_str()
        .and_then(from_hex)
        .and_then(|key| XChaCha20Poly1305::new_from_slice(&key).ok())
        .ok_or(NOT_RUNNING)?;
    let port = info["port"].as_u64().and_then(|p| u16::try_from(p).ok()).ok_or(NOT_RUNNING)?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|_| NOT_RUNNING)?;
    stream.set_read_timeout(Some(Duration::from_secs(60))).map_err(err)?;
    writeln!(stream, "{}", seal(&cipher, message)?).map_err(err)?;
    let mut reply = String::new();
    BufReader::new(&stream).read_line(&mut reply).map_err(|_| NOT_RUNNING)?;
    open(&cipher, &reply).map_err(|_| "Arca respondió algo inesperado".into())
}

/// Answers extension requests on a random loopback port for as long as the app runs.
pub fn serve(bridge: &Path, handle: impl Fn(Value) -> Value + Send + 'static) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let key: [u8; 32] = os_rng().random();
    if let Some(dir) = bridge.parent() {
        fs::create_dir_all(dir)?;
    }
    let info = json!({ "port": listener.local_addr()?.port(), "key": to_hex(&key) });
    fs::write(bridge, info.to_string())?;
    let cipher = XChaCha20Poly1305::new(&Key::from(key));
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = answer(&cipher, &mut stream, &handle);
        }
    });
    Ok(())
}

// Requests that do not decrypt with this run's key are dropped without an answer.
fn answer(
    cipher: &XChaCha20Poly1305,
    stream: &mut TcpStream,
    handle: &impl Fn(Value) -> Value,
) -> Result<(), String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(err)?;
    let mut line = String::new();
    BufReader::new(&*stream)
        .take(4 * MAX_MESSAGE as u64)
        .read_line(&mut line)
        .map_err(err)?;
    let request = serde_json::from_str(&open(cipher, &line)?).map_err(err)?;
    writeln!(stream, "{}", seal(cipher, &handle(request).to_string())?).map_err(err)
}

/// Registers this executable as the native messaging host for Chrome, Edge and Firefox.
pub fn register() -> Result<(), String> {
    let exe = env::current_exe().map_err(err)?;
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(err)?;
    let chrome = write_manifest(&dir.join("chrome-host.json"), &exe, "allowed_origins", CHROME_ORIGIN)?;
    let firefox = write_manifest(&dir.join("firefox-host.json"), &exe, "allowed_extensions", FIREFOX_ID)?;
    for (key, manifest) in REGISTRY_KEYS.iter().zip([&chrome, &chrome, &firefox]) {
        set_default_value(key, manifest)?;
    }
    Ok(())
}

pub fn unregister() {
    for key in REGISTRY_KEYS {
        let _ = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, &HSTRING::from(key)) };
    }
}

fn write_manifest(path: &Path, exe: &Path, allowed_key: &str, allowed: &str) -> Result<PathBuf, String> {
    let mut manifest = json!({
        "name": HOST_NAME,
        "description": "Arca",
        "path": exe.to_string_lossy(),
        "type": "stdio",
    });
    manifest[allowed_key] = json!([allowed]);
    fs::write(path, manifest.to_string()).map_err(err)?;
    Ok(path.to_path_buf())
}

fn set_default_value(key: &str, value: &Path) -> Result<(), String> {
    let data: Vec<u16> = value.as_os_str().encode_wide().chain([0]).collect();
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(key),
            PCWSTR::null(),
            REG_SZ.0,
            Some(data.as_ptr().cast()),
            (data.len() * 2) as u32,
        )
    }
    .ok()
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_messages_round_trip() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, r#"{"type":"status"}"#).unwrap();
        assert_eq!(buffer[..4], 17u32.to_le_bytes());
        assert_eq!(read_message(&mut buffer.as_slice()).as_deref(), Some(r#"{"type":"status"}"#));
        assert!(read_message(&mut &buffer[..10]).is_none(), "accepted a truncated message");
    }

    #[test]
    fn relays_sealed_requests_only() {
        let file = env::temp_dir().join(format!("arca-bridge-test-{}.json", std::process::id()));
        serve(&file, |request| json!({ "echo": request["type"] })).unwrap();
        assert_eq!(forward(&file, r#"{"type":"status"}"#).unwrap(), r#"{"echo":"status"}"#);

        let info: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", info["port"].as_u64().unwrap() as u16)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        writeln!(stream, r#"{{"type":"status"}}"#).unwrap();
        let mut reply = String::new();
        let read = BufReader::new(&stream).read_line(&mut reply).unwrap_or(0);
        assert_eq!(read, 0, "answered a request that was not sealed with the key");
        fs::remove_file(&file).unwrap();
    }
}
