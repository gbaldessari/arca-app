mod bridge;
mod i18n;
mod platform;

use std::{
    collections::HashSet,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use arboard::{Clipboard, SetExtWindows};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rand_core::UnwrapErr, rngs::SysRng, seq::SliceRandom, RngExt};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub use bridge::{is_native_host, run_native_host};

const LOCKED: &str = "La bóveda está bloqueada";
const NONCE_LEN: usize = 24;
const CHARSETS: [&str; 4] = [
    "abcdefghijklmnopqrstuvwxyz",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "0123456789",
    "!@#$%^&*()-_=+[]{};:,.<>?/",
];

/// Last secret Arca put on the clipboard, cleared on lock and on exit.
static COPIED: Mutex<Option<String>> = Mutex::new(None);
static BRIDGE_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
struct Entry {
    id: Option<i64>,
    title: String,
    username: String,
    password: String,
    url: String,
    notes: String,
    // Older payloads lack this field.
    #[serde(default)]
    favorite: bool,
}

/// What the entry list shows; passwords and notes only reach the UI when an entry is opened.
#[derive(Serialize)]
struct Summary {
    id: i64,
    title: String,
    username: String,
    url: String,
    favorite: bool,
}

struct Vault {
    db: Connection,
    cipher: Option<XChaCha20Poly1305>,
}

type AppState = Mutex<Vault>;

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn os_rng() -> UnwrapErr<SysRng> {
    UnwrapErr(SysRng)
}

// Changing these parameters locks out existing vaults unless they are migrated.
fn derive_key(secret: &[u8], salt: &[u8]) -> Result<XChaCha20Poly1305, String> {
    let params = Params::new(64 * 1024, 3, 4, Some(32)).map_err(err)?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(secret, salt, &mut key)
        .map_err(err)?;
    Ok(XChaCha20Poly1305::new(&Key::from(key)))
}

fn encrypt(cipher: &XChaCha20Poly1305, plain: &[u8]) -> Result<Vec<u8>, String> {
    let nonce: [u8; NONCE_LEN] = os_rng().random();
    let mut out = nonce.to_vec();
    out.extend(cipher.encrypt(&XNonce::from(nonce), plain).map_err(err)?);
    Ok(out)
}

fn decrypt(cipher: &XChaCha20Poly1305, data: &[u8]) -> Result<Vec<u8>, String> {
    let (nonce, ciphertext) = data.split_at_checked(NONCE_LEN).ok_or_else(|| i18n::tr("Datos dañados", "Damaged data"))?;
    let nonce = XNonce::try_from(nonce).map_err(err)?;
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|_| i18n::tr("No se pudo descifrar", "Could not decrypt"))
}

fn decode(cipher: &XChaCha20Poly1305, data: &[u8]) -> Result<Entry, String> {
    serde_json::from_slice(&decrypt(cipher, data)?).map_err(err)
}

/// Wraps the vault key with a key derived from the master password; returns (salt, wrapped key).
fn wrap(password: &str, vault_key: &[u8]) -> Result<([u8; 16], Vec<u8>), String> {
    if password.chars().count() < 8 {
        return Err(i18n::tr(
            "La contraseña maestra debe tener al menos 8 caracteres",
            "The master password must be at least 8 characters",
        ));
    }
    let salt: [u8; 16] = os_rng().random();
    Ok((salt, encrypt(&derive_key(password.as_bytes(), &salt)?, vault_key)?))
}

impl Vault {
    fn open(db: Connection) -> rusqlite::Result<Self> {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 salt BLOB NOT NULL,
                 vault_key BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, data BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS hello (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 challenge BLOB NOT NULL,
                 vault_key BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self { db, cipher: None })
    }

    fn cipher(&self) -> Result<&XChaCha20Poly1305, String> {
        self.cipher.as_ref().ok_or_else(|| i18n::tr(LOCKED, "The vault is locked"))
    }

    fn browser_integration(&self) -> Result<bool, String> {
        self.db
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM settings WHERE key = 'browser_integration')",
                [],
                |r| r.get(0),
            )
            .map_err(err)
    }

    fn set_browser_integration(&self, enabled: bool) -> Result<(), String> {
        let sql = if enabled {
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('browser_integration', '1')"
        } else {
            "DELETE FROM settings WHERE key = 'browser_integration'"
        };
        self.db.execute(sql, []).map_err(err)?;
        Ok(())
    }

    /// Entries saved for the site of `url`. Only https pages (and localhost) get credentials.
    fn logins(&self, url: &str) -> Result<Vec<Entry>, String> {
        let Some(site) = page_site(url) else {
            return Ok(Vec::new());
        };
        Ok(self
            .entries()?
            .into_iter()
            .filter(|e| same_site(&host(&e.url), &site))
            .collect())
    }

    fn login(&self, url: &str, id: i64) -> Result<Entry, String> {
        self.logins(url)?
            .into_iter()
            .find(|e| e.id == Some(id))
            .ok_or_else(|| i18n::tr("Esa entrada no pertenece a este sitio", "That entry does not belong to this site"))
    }

    /// Whether the credentials are "new", an "update" of a saved login or the "same"; writes them if `write`.
    fn save_login(&self, url: &str, username: &str, password: &str, write: bool) -> Result<&'static str, String> {
        let site = page_site(url).ok_or_else(|| {
            i18n::tr(
                "Arca solo guarda contraseñas de sitios https",
                "Arca only saves passwords from https sites",
            )
        })?;
        let status = match self.logins(url)?.into_iter().find(|e| e.username == username) {
            Some(e) if e.password == password => "same",
            Some(e) => {
                if write {
                    self.save(Entry { password: password.into(), ..e })?;
                }
                "update"
            }
            None => {
                if write {
                    let scheme = url.split_once("://").map_or("https", |(scheme, _)| scheme);
                    self.save(Entry {
                        id: None,
                        title: site,
                        username: username.into(),
                        password: password.into(),
                        url: format!("{scheme}://{}", host(url)),
                        notes: String::new(),
                        favorite: false,
                    })?;
                }
                "new"
            }
        };
        Ok(status)
    }

    fn exists(&self) -> Result<bool, String> {
        self.db
            .query_row("SELECT EXISTS (SELECT 1 FROM meta)", [], |r| r.get(0))
            .map_err(err)
    }

    fn status(&self) -> Result<&'static str, String> {
        Ok(if self.cipher.is_some() {
            "unlocked"
        } else if self.exists()? {
            "locked"
        } else {
            "new"
        })
    }

    /// Entries are encrypted with a random vault key, which is stored wrapped by the
    /// master-password key, so changing the master password only re-wraps that key.
    fn create(&mut self, password: &str) -> Result<(), String> {
        let vault_key: [u8; 32] = os_rng().random();
        let (salt, wrapped) = wrap(password, &vault_key)?;
        // Fails instead of overwriting when a vault already exists (meta holds a single row).
        self.db
            .execute(
                "INSERT INTO meta (id, salt, vault_key) VALUES (1, ?1, ?2)",
                params![salt, wrapped],
            )
            .map_err(err)?;
        self.set_key(&vault_key)
    }

    fn vault_key(&self, password: &str) -> Result<Vec<u8>, String> {
        let (salt, wrapped): (Vec<u8>, Vec<u8>) = self
            .db
            .query_row("SELECT salt, vault_key FROM meta", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(err)?;
        decrypt(&derive_key(password.as_bytes(), &salt)?, &wrapped)
            .map_err(|_| i18n::tr("Contraseña incorrecta", "Wrong password"))
    }

    fn set_key(&mut self, vault_key: &[u8]) -> Result<(), String> {
        self.cipher = Some(XChaCha20Poly1305::new_from_slice(vault_key).map_err(err)?);
        Ok(())
    }

    fn unlock(&mut self, password: &str) -> Result<(), String> {
        let vault_key = self.vault_key(password)?;
        self.set_key(&vault_key)
    }

    fn change_password(&self, current: &str, new: &str) -> Result<(), String> {
        self.cipher()?;
        let (salt, wrapped) = wrap(new, &self.vault_key(current)?)?;
        self.db
            .execute("UPDATE meta SET salt = ?1, vault_key = ?2", params![salt, wrapped])
            .map_err(err)?;
        Ok(())
    }

    fn hello_challenge(&self) -> Result<Option<Vec<u8>>, String> {
        self.db
            .query_row("SELECT challenge FROM hello", [], |r| r.get(0))
            .optional()
            .map_err(err)
    }

    /// Stores the vault key wrapped by a key derived from the Windows Hello signature of `challenge`.
    fn enable_hello(&self, vault_key: &[u8], challenge: &[u8], signature: &[u8]) -> Result<(), String> {
        let wrapped = encrypt(&derive_key(signature, challenge)?, vault_key)?;
        self.db
            .execute(
                "INSERT OR REPLACE INTO hello (id, challenge, vault_key) VALUES (1, ?1, ?2)",
                params![challenge, wrapped],
            )
            .map_err(err)?;
        Ok(())
    }

    fn unlock_with_signature(&mut self, signature: &[u8]) -> Result<(), String> {
        let (challenge, wrapped): (Vec<u8>, Vec<u8>) = self
            .db
            .query_row("SELECT challenge, vault_key FROM hello", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(err)?;
        let vault_key = decrypt(&derive_key(signature, &challenge)?, &wrapped)
            .map_err(|_| i18n::tr("Windows Hello no pudo desbloquear la bóveda", "Windows Hello could not unlock the vault"))?;
        self.set_key(&vault_key)
    }

    fn entries(&self) -> Result<Vec<Entry>, String> {
        let cipher = self.cipher()?;
        let rows: Vec<(i64, Vec<u8>)> = self
            .db
            .prepare("SELECT id, data FROM entries")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect()
            })
            .map_err(err)?;
        rows.into_iter()
            .map(|(id, data)| Ok(Entry { id: Some(id), ..decode(cipher, &data)? }))
            .collect()
    }

    fn list(&self) -> Result<Vec<Summary>, String> {
        Ok(self
            .entries()?
            .into_iter()
            .map(|e| Summary {
                id: e.id.unwrap_or_default(),
                title: e.title,
                username: e.username,
                url: e.url,
                favorite: e.favorite,
            })
            .collect())
    }

    fn get(&self, id: i64) -> Result<Entry, String> {
        let cipher = self.cipher()?;
        let data: Vec<u8> = self
            .db
            .query_row("SELECT data FROM entries WHERE id = ?1", [id], |r| r.get(0))
            .map_err(err)?;
        Ok(Entry { id: Some(id), ..decode(cipher, &data)? })
    }

    fn save(&self, mut entry: Entry) -> Result<i64, String> {
        let id = entry.id.take();
        let data = encrypt(self.cipher()?, &serde_json::to_vec(&entry).map_err(err)?)?;
        match id {
            Some(id) => self
                .db
                .execute("UPDATE entries SET data = ?1 WHERE id = ?2", params![data, id])
                .map(|_| id),
            None => self
                .db
                .execute("INSERT INTO entries (data) VALUES (?1)", params![data])
                .map(|_| self.db.last_insert_rowid()),
        }
        .map_err(err)
    }

    fn delete(&self, id: i64) -> Result<(), String> {
        self.cipher()?;
        self.db
            .execute("DELETE FROM entries WHERE id = ?1", [id])
            .map_err(err)?;
        Ok(())
    }

    /// Adds the entries that are not in the vault yet, matching on title, username, password and URL.
    fn add_entries(&self, entries: Vec<Entry>) -> Result<usize, String> {
        let key = |e: &Entry| (e.title.clone(), e.username.clone(), e.password.clone(), e.url.clone());
        let mut known: HashSet<_> = self.entries()?.iter().map(key).collect();
        let tx = self.db.unchecked_transaction().map_err(err)?;
        let mut added = 0;
        for entry in entries {
            if known.insert(key(&entry)) {
                self.save(Entry { id: None, ..entry })?;
                added += 1;
            }
        }
        tx.commit().map_err(err)?;
        Ok(added)
    }

    /// Restores the backup into an empty vault, or merges its entries into the open one.
    fn import_backup(&self, path: &Path) -> Result<usize, String> {
        let (salt, vault_key, blobs) =
            read_backup(path).map_err(|_| i18n::tr("El archivo no es un backup de Arca", "This file is not an Arca backup"))?;
        if !self.exists()? {
            let tx = self.db.unchecked_transaction().map_err(err)?;
            tx.execute(
                "INSERT INTO meta (id, salt, vault_key) VALUES (1, ?1, ?2)",
                params![salt, vault_key],
            )
            .map_err(err)?;
            for data in &blobs {
                tx.execute("INSERT INTO entries (data) VALUES (?1)", [data])
                    .map_err(err)?;
            }
            tx.commit().map_err(err)?;
            return Ok(blobs.len());
        }
        let cipher = self.cipher()?;
        let entries = blobs
            .iter()
            .map(|data| {
                decode(cipher, data).map_err(|_| i18n::tr("Este backup es de otra bóveda", "This backup belongs to another vault"))
            })
            .collect::<Result<_, _>>()?;
        self.add_entries(entries)
    }

    fn export(&self, path: &Path) -> Result<(), String> {
        self.cipher()?;
        // Written next to the target and renamed, so a failed export never clobbers an older backup.
        let tmp = path.with_extension("tmp");
        let _ = std::fs::remove_file(&tmp);
        self.db
            .execute("VACUUM INTO ?1", [tmp.to_string_lossy().into_owned()])
            .map_err(err)?;
        std::fs::rename(&tmp, path).map_err(err)
    }
}

type Backup = (Vec<u8>, Vec<u8>, Vec<Vec<u8>>);

fn read_backup(path: &Path) -> rusqlite::Result<Backup> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let (salt, vault_key): (Vec<u8>, Vec<u8>) =
        db.query_row("SELECT salt, vault_key FROM meta", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let blobs: Vec<Vec<u8>> = db
        .prepare("SELECT data FROM entries")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok((salt, vault_key, blobs))
}

/// RFC 4180 CSV: quoted fields may contain commas, newlines and doubled quotes.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut field, mut quoted) = (Vec::new(), Vec::new(), String::new(), false);
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => row.push(std::mem::take(&mut field)),
            '\n' if !quoted => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\r' if !quoted => {}
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    rest.split(['/', '?', '#']).next().unwrap_or_default().to_string()
}

/// The host of a page that may receive credentials: https, or plain http only on this machine.
fn page_site(url: &str) -> Option<String> {
    let scheme = url.split_once("://")?.0;
    let site = host(url).to_lowercase();
    let local = matches!(site.split(':').next(), Some("localhost" | "127.0.0.1"));
    (scheme == "https" || (scheme == "http" && local)).then(|| site.trim_start_matches("www.").into())
}

/// A saved host matches the page when they are the same or one is a subdomain of the other.
fn same_site(saved: &str, site: &str) -> bool {
    let saved = saved.to_lowercase();
    let saved = saved.trim_start_matches("www.");
    !saved.is_empty()
        && (saved == site || site.ends_with(&format!(".{saved}")) || saved.ends_with(&format!(".{site}")))
}

/// Reads the CSV exports of Chrome, Edge, Firefox, Bitwarden, KeePass, 1Password and similar.
fn entries_from_csv(text: &str) -> Result<Vec<Entry>, String> {
    let mut rows = parse_csv(text).into_iter();
    let header: Vec<String> = rows
        .next()
        .unwrap_or_default()
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();
    let column = |names: &[&str]| header.iter().position(|h| names.contains(&h.as_str()));
    let names: [&[&str]; 6] = [
        &["name", "title", "account"],
        &["username", "login_username", "login name", "user name", "login"],
        &["password", "login_password"],
        &["url", "login_uri", "web site", "website", "uri"],
        &["notes", "note", "comments", "extra"],
        &["favorite", "fav"],
    ];
    let [title, username, password, url, notes, favorite] = names.map(column);
    if password.is_none() {
        return Err(i18n::tr(
            "El CSV no tiene una columna de contraseñas",
            "The CSV has no password column",
        ));
    }
    Ok(rows
        .filter(|row| row.iter().any(|field| !field.is_empty()))
        .map(|row| {
            let get = |i: Option<usize>| i.and_then(|i| row.get(i)).cloned().unwrap_or_default();
            let url = get(url);
            Entry {
                id: None,
                title: [get(title), host(&url)]
                    .into_iter()
                    .find(|t| !t.is_empty())
                    .unwrap_or_else(|| i18n::tr("Sin título", "Untitled")),
                username: get(username),
                password: get(password),
                notes: get(notes),
                favorite: matches!(get(favorite).to_lowercase().as_str(), "1" | "true"),
                url,
            }
        })
        .collect())
}

fn clear_clipboard_if(text: &str) {
    if let Ok(mut clipboard) = Clipboard::new() {
        if clipboard.get_text().is_ok_and(|current| current == text) {
            let _ = clipboard.clear();
        }
    }
}

fn clear_copied_secret() {
    if let Some(text) = COPIED.lock().unwrap().take() {
        clear_clipboard_if(&text);
    }
}

fn lock_vault(app: &AppHandle) {
    if let Ok(mut vault) = app.state::<AppState>().lock() {
        vault.cipher = None;
    }
    clear_copied_secret();
    let _ = app.emit("locked", ());
}

/// Answers the browser extension. `url` is always the page the extension acts on, as reported by
/// the browser, so a site can only ever reach its own logins.
fn bridge_request(vault: &mut Vault, request: &Value) -> Result<Value, String> {
    if !vault.browser_integration()? {
        return Err(i18n::tr(
            "Activa la integración con el navegador en los ajustes de Arca",
            "Turn on browser integration in Arca's settings",
        ));
    }
    let text = |key: &str| request[key].as_str().unwrap_or_default();
    let (url, id) = (text("url"), request["id"].as_i64().unwrap_or_default());
    let unlocked = vault.cipher.is_some();
    match text("type") {
        "status" | "open" => Ok(json!({ "unlocked": unlocked, "opened": text("type") == "open" })),
        "hello_status" => {
            let enabled = vault.hello_challenge()?.is_some();
            Ok(json!({ "available": platform::hello_available() && enabled, "enabled": enabled }))
        }
        "unlock" => {
            if vault.cipher.is_none() {
                vault.unlock(text("password"))?;
            }
            Ok(json!({ "unlocked": true }))
        }
        "generate" => Ok(json!({ "password": generate_password(20, true, true, true, true)? })),
        "copy_text" => copy_to_clipboard(text("text").into()).map(|_| json!({})),
        _ if !unlocked => Ok(json!({ "locked": true })),
        "logins" => Ok(json!({
            "logins": vault
                .logins(url)?
                .into_iter()
                .map(|e| json!({ "id": e.id, "title": e.title, "username": e.username }))
                .collect::<Vec<_>>()
        })),
        "fill" => vault
            .login(url, id)
            .map(|e| json!({ "username": e.username, "password": e.password })),
        "copy" => copy_to_clipboard(vault.login(url, id)?.password).map(|_| json!({})),
        "save_status" | "save" => vault
            .save_login(url, text("username"), text("password"), text("type") == "save")
            .map(|status| json!({ "status": status })),
        _ => Err(i18n::tr("Solicitud desconocida", "Unknown request")),
    }
}

/// Windows Hello prompts outside the vault lock, so the window stays responsive.
fn unlock_from_hello(app: &AppHandle) -> Value {
    let result = (|| -> Result<(), String> {
        let challenge = {
            let state = app.state::<AppState>();
            let vault = state.lock().map_err(err)?;
            if !vault.browser_integration()? {
                return Err(i18n::tr(
                    "Activa la integración con el navegador en los ajustes de Arca",
                    "Turn on browser integration in Arca's settings",
                ));
            }
            if vault.cipher.is_some() {
                return Ok(());
            }
            vault
                .hello_challenge()?
                .ok_or_else(|| i18n::tr("Windows Hello no está activado para Arca", "Windows Hello is not turned on for Arca"))?
        };
        let signature = platform::hello_sign(&challenge, false)?;
        app.state::<AppState>().lock().map_err(err)?.unlock_with_signature(&signature)
    })();
    match result {
        Ok(()) => {
            let _ = app.emit("unlocked", ());
            json!({ "unlocked": true })
        }
        Err(error) => json!({ "error": error }),
    }
}

fn bridge_message(app: &AppHandle, request: serde_json::Value) -> serde_json::Value {
    if request["type"] == "unlock_hello" {
        return unlock_from_hello(app);
    }
    let kind = request["type"].as_str().unwrap_or("").to_string();
    let response = match app.state::<AppState>().lock() {
        Ok(mut vault) => bridge_request(&mut vault, &request),
        Err(_) => Err(i18n::tr("Arca no está disponible", "Arca is not available")),
    };
    if response.is_ok() && kind == "unlock" {
        let _ = app.emit("unlocked", ());
    }
    if response.is_ok() && kind == "open" {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    if response.is_ok() && kind == "save" {
        let _ = app.emit("entries-changed", ());
    }
    response.unwrap_or_else(|e| json!({ "error": e }))
}

fn start_bridge(app: &AppHandle) -> Result<(), String> {
    if BRIDGE_STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let app = app.clone();
    bridge::serve(&bridge::bridge_file(), move |request| {
        let english = request["lang"].as_str().map(|lang| lang == "en").unwrap_or_else(i18n::is_english);
        i18n::with_english(english, || bridge_message(&app, request))
    })
    .map_err(err)
}

#[tauri::command]
fn set_language(lang: String) {
    i18n::set_english(lang == "en");
}

#[tauri::command]
fn status(state: State<AppState>) -> Result<&'static str, String> {
    state.lock().unwrap().status()
}

// The commands that run Argon2 or wait on a dialog are async so they stay off the main thread.
#[tauri::command]
async fn create_vault(state: State<'_, AppState>, password: String) -> Result<(), String> {
    state.lock().unwrap().create(&password)
}

#[tauri::command]
async fn unlock(state: State<'_, AppState>, password: String) -> Result<(), String> {
    state.lock().unwrap().unlock(&password)
}

#[tauri::command]
fn lock(app: AppHandle) {
    lock_vault(&app);
}

#[tauri::command]
fn browser_integration(state: State<AppState>) -> Result<bool, String> {
    state.lock().unwrap().browser_integration()
}

#[tauri::command]
fn set_browser_integration(app: AppHandle, state: State<AppState>, enabled: bool) -> Result<(), String> {
    if enabled {
        bridge::register()?;
        start_bridge(&app)?;
    } else {
        bridge::unregister();
    }
    state.lock().unwrap().set_browser_integration(enabled)
}

#[tauri::command]
fn list_entries(state: State<AppState>) -> Result<Vec<Summary>, String> {
    state.lock().unwrap().list()
}

#[tauri::command]
fn get_entry(state: State<AppState>, id: i64) -> Result<Entry, String> {
    state.lock().unwrap().get(id)
}

#[tauri::command]
fn save_entry(state: State<AppState>, entry: Entry) -> Result<i64, String> {
    state.lock().unwrap().save(entry)
}

#[tauri::command]
fn delete_entry(state: State<AppState>, id: i64) -> Result<(), String> {
    state.lock().unwrap().delete(id)
}

#[tauri::command]
async fn change_master_password(
    state: State<'_, AppState>,
    current: String,
    new_password: String,
) -> Result<(), String> {
    state.lock().unwrap().change_password(&current, &new_password)
}

#[tauri::command]
async fn export_backup(window: WebviewWindow, state: State<'_, AppState>) -> Result<bool, String> {
    state.lock().unwrap().cipher()?;
    let Some(path) = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name("arca-backup.arca")
        .add_filter(i18n::tr("Backup de Arca", "Arca backup"), &["arca"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    state.lock().unwrap().export(&path.into_path().map_err(err)?)?;
    Ok(true)
}

/// Picks an Arca backup (or a CSV, once a vault exists) and returns how many entries were added.
#[tauri::command]
async fn import_file(window: WebviewWindow, state: State<'_, AppState>) -> Result<Option<usize>, String> {
    let (label, extensions): (String, &[&str]) = if state.lock().unwrap().exists()? {
        (i18n::tr("Backup de Arca o CSV", "Arca backup or CSV"), &["arca", "csv"])
    } else {
        (i18n::tr("Backup de Arca", "Arca backup"), &["arca"])
    };
    let Some(path) = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter(label, extensions)
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(err)?;
    let vault = state.lock().unwrap();
    if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("csv")) {
        let text = std::fs::read_to_string(&path)
            .map_err(|_| i18n::tr("No se pudo leer el CSV; debe estar en UTF-8", "Could not read the CSV; it must be UTF-8"))?;
        vault.add_entries(entries_from_csv(&text)?).map(Some)
    } else {
        vault.import_backup(&path).map(Some)
    }
}

#[tauri::command]
async fn hello_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let enabled = state.lock().unwrap().hello_challenge()?.is_some();
    Ok(serde_json::json!({ "available": platform::hello_available(), "enabled": enabled }))
}

#[tauri::command]
async fn enable_hello(state: State<'_, AppState>, password: String) -> Result<(), String> {
    let vault_key = state.lock().unwrap().vault_key(&password)?;
    let challenge: [u8; 32] = os_rng().random();
    let signature = platform::hello_sign(&challenge, true)?;
    state.lock().unwrap().enable_hello(&vault_key, &challenge, &signature)
}

#[tauri::command]
async fn unlock_with_hello(state: State<'_, AppState>) -> Result<(), String> {
    let challenge = state
        .lock()
        .unwrap()
        .hello_challenge()?
        .ok_or_else(|| i18n::tr("Windows Hello no está activado", "Windows Hello is not turned on"))?;
    let signature = platform::hello_sign(&challenge, false)?;
    state.lock().unwrap().unlock_with_signature(&signature)
}

#[tauri::command]
async fn disable_hello(state: State<'_, AppState>) -> Result<(), String> {
    state
        .lock()
        .unwrap()
        .db
        .execute("DELETE FROM hello", [])
        .map_err(err)?;
    platform::hello_delete();
    Ok(())
}

/// zxcvbn score from 0 (trivial) to 4 (very strong); `inputs` are words the password should avoid.
#[tauri::command]
fn password_strength(password: String, inputs: Vec<String>) -> u8 {
    let inputs: Vec<&str> = inputs.iter().map(String::as_str).collect();
    zxcvbn::zxcvbn(&password, &inputs).score().into()
}

#[tauri::command]
async fn confirm(window: WebviewWindow, message: String, ok: String) -> bool {
    window
        .dialog()
        .message(message)
        .title("Arca")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok, i18n::tr("Cancelar", "Cancel")))
        .parent(&window)
        .blocking_show()
}

#[tauri::command]
fn generate_password(
    length: usize,
    lower: bool,
    upper: bool,
    digits: bool,
    symbols: bool,
) -> Result<String, String> {
    let sets: Vec<&[u8]> = CHARSETS
        .iter()
        .zip([lower, upper, digits, symbols])
        .filter(|(_, on)| *on)
        .map(|(set, _)| set.as_bytes())
        .collect();
    if sets.is_empty() {
        return Err(i18n::tr("Elige al menos un tipo de carácter", "Choose at least one character type"));
    }
    let mut rng = os_rng();
    let pool = sets.concat();
    // One character from each chosen set first, so every set is guaranteed to appear.
    let mut chars: Vec<u8> = sets
        .iter()
        .map(|set| set[rng.random_range(..set.len())])
        .collect();
    chars.extend((chars.len()..length).map(|_| pool[rng.random_range(..pool.len())]));
    chars.shuffle(&mut rng);
    Ok(chars.into_iter().map(char::from).collect())
}

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    // Keeps secrets out of Win+V history and cloud clipboard sync.
    Clipboard::new()
        .and_then(|mut c| c.set().exclude_from_monitoring().text(text.as_str()))
        .map_err(err)?;
    *COPIED.lock().unwrap() = Some(text.clone());
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(30));
        clear_clipboard_if(&text);
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let vault = Vault::open(Connection::open(dir.join("arca.db"))?)?;
            let integration = vault.browser_integration()?;
            app.manage(Mutex::new(vault));
            // Re-registering keeps the native host pointing at this executable after updates.
            if integration && bridge::register().is_ok() {
                start_bridge(app.handle())?;
            }

            let window = app.get_webview_window("main").ok_or("main window missing")?;
            platform::on_session_lock(&window, lock_vault)?;
            if let Some(monitor) = window.current_monitor()? {
                let (area, size) = (monitor.work_area().size, window.outer_size()?);
                if size.width > area.width || size.height > area.height {
                    window.maximize()?;
                }
            }
            // The UI shows the window once its theme is applied; this covers a UI that fails to load.
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(3));
                let _ = window.show();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            create_vault,
            unlock,
            lock,
            list_entries,
            get_entry,
            save_entry,
            delete_entry,
            change_master_password,
            export_backup,
            import_file,
            hello_status,
            enable_hello,
            unlock_with_hello,
            disable_hello,
            password_strength,
            confirm,
            generate_password,
            copy_to_clipboard,
            browser_integration,
            set_browser_integration,
            set_language
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if let RunEvent::Exit = event {
                clear_copied_secret();
                let _ = std::fs::remove_file(bridge::bridge_file());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "una clave maestra";

    fn entry(title: &str, password: &str) -> Entry {
        Entry {
            id: None,
            title: title.into(),
            username: "giaco".into(),
            password: password.into(),
            url: String::new(),
            notes: String::new(),
            favorite: false,
        }
    }

    fn new_vault(password: &str) -> Vault {
        let mut vault = Vault::open(Connection::open_in_memory().unwrap()).unwrap();
        vault.create(password).unwrap();
        vault
    }

    #[test]
    fn vault_lifecycle() {
        let mut vault = Vault::open(Connection::open_in_memory().unwrap()).unwrap();
        assert_eq!(vault.status().unwrap(), "new");
        assert!(vault.create("corta").is_err());
        vault.create(MASTER).unwrap();
        let id = vault
            .save(Entry { favorite: true, ..entry("GitHub", "s3cr3t-p4ss") })
            .unwrap();

        let blob: Vec<u8> = vault
            .db
            .query_row("SELECT data FROM entries", [], |r| r.get(0))
            .unwrap();
        assert!(!blob.windows(11).any(|w| w == b"s3cr3t-p4ss"), "stored in plaintext");
        let listed = serde_json::to_string(&vault.list().unwrap()).unwrap();
        assert!(listed.contains("GitHub") && !listed.contains("s3cr3t-p4ss"), "list leaks passwords");

        vault.cipher = None;
        assert_eq!(vault.status().unwrap(), "locked");
        assert_eq!(vault.list().err().as_deref(), Some(LOCKED));
        assert_eq!(vault.unlock("otra clave").unwrap_err(), "Contraseña incorrecta");
        vault.unlock(MASTER).unwrap();

        vault.save(Entry { id: Some(id), ..entry("GitHub", "nueva") }).unwrap();
        let saved = vault.get(id).unwrap();
        assert_eq!((saved.password.as_str(), saved.favorite), ("nueva", false));

        assert!(vault.change_password("otra clave", "clave nueva segura").is_err());
        vault.change_password(MASTER, "clave nueva segura").unwrap();
        vault.cipher = None;
        assert!(vault.unlock(MASTER).is_err());
        vault.unlock("clave nueva segura").unwrap();
        assert_eq!(vault.get(id).unwrap().password, "nueva");

        assert!(vault.create(MASTER).is_err(), "overwrote the vault");
        vault.delete(id).unwrap();
        assert!(vault.list().unwrap().is_empty());
    }

    #[test]
    fn hello_signature_unlocks() {
        let mut vault = new_vault(MASTER);
        vault.save(entry("GitHub", "s3cr3t")).unwrap();
        let vault_key = vault.vault_key(MASTER).unwrap();
        vault
            .enable_hello(&vault_key, b"challenge-bytes!", b"firma de windows hello")
            .unwrap();
        assert_eq!(vault.hello_challenge().unwrap().as_deref(), Some(&b"challenge-bytes!"[..]));

        vault.cipher = None;
        assert!(vault.unlock_with_signature(b"otra firma").is_err());
        vault.unlock_with_signature(b"firma de windows hello").unwrap();
        assert_eq!(vault.list().unwrap().len(), 1);
    }

    #[test]
    fn backups() {
        let path = std::env::temp_dir().join(format!("arca-test-{}.arca", std::process::id()));
        let vault = new_vault(MASTER);
        let first = vault.save(entry("A", "1")).unwrap();
        vault.save(entry("B", "2")).unwrap();
        vault.export(&path).unwrap();
        vault.export(&path).unwrap();

        let mut restored = Vault::open(Connection::open_in_memory().unwrap()).unwrap();
        assert_eq!(restored.import_backup(&path).unwrap(), 2);
        assert_eq!(restored.status().unwrap(), "locked");
        restored.unlock(MASTER).unwrap();
        assert_eq!(restored.list().unwrap().len(), 2);

        vault.delete(first).unwrap();
        assert_eq!(vault.import_backup(&path).unwrap(), 1, "only the missing entry comes back");
        assert_eq!(vault.list().unwrap().len(), 2);

        assert!(new_vault(MASTER).import_backup(&path).is_err(), "merged another vault");
        std::fs::remove_file(&path).unwrap();
        assert!(vault.import_backup(&path).is_err());
    }

    #[test]
    fn csv_import() {
        let rows = parse_csv("\u{feff}a,\"b,\"\"c\"\"\"\r\n\"multi\nline\",\r\n");
        assert_eq!(rows, [vec!["a", "b,\"c\""], vec!["multi\nline", ""]]);

        let chrome = entries_from_csv(
            "name,url,username,password,note\nGitHub,https://github.com/login,giaco,\" p,w \",nota\n",
        )
        .unwrap();
        let e = &chrome[0];
        assert_eq!((e.title.as_str(), e.password.as_str(), e.notes.as_str()), ("GitHub", " p,w ", "nota"));
        let firefox = entries_from_csv(
            "\"url\",\"username\",\"password\",\"httpRealm\"\n\"https://mail.example.com/x\",\"yo\",\"pw\",\"\"\n",
        )
        .unwrap();
        assert_eq!(firefox[0].title, "mail.example.com");
        let bitwarden = entries_from_csv(
            "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n\
             ,1,login,Banco,,,0,https://banco.example,yo,pw,\n",
        )
        .unwrap();
        assert!(bitwarden[0].favorite && bitwarden[0].url == "https://banco.example");
        assert!(entries_from_csv("a,b\n1,2\n").is_err());

        let vault = new_vault(MASTER);
        assert_eq!(vault.add_entries(chrome).unwrap(), 1);
        let again = entries_from_csv(
            "name,url,username,password\nGitHub,https://github.com/login,giaco,\" p,w \"\n",
        )
        .unwrap();
        assert_eq!(vault.add_entries(again).unwrap(), 0, "re-import duplicated an entry");
    }

    #[test]
    fn browser_requests() {
        let mut vault = new_vault(MASTER);
        let github = vault
            .save(Entry { url: "https://github.com".into(), ..entry("GitHub", "s3cr3t") })
            .unwrap();
        vault
            .save(Entry { url: "https://bank.example".into(), ..entry("Banco", "b4nk") })
            .unwrap();
        assert!(bridge_request(&mut vault, &json!({ "type": "status" })).is_err(), "answered with the integration off");
        vault.set_browser_integration(true).unwrap();

        let logins = bridge_request(&mut vault, &json!({ "type": "logins", "url": "https://gist.github.com/new" })).unwrap();
        assert_eq!(logins["logins"].as_array().unwrap().len(), 1);
        assert!(logins.to_string().contains("GitHub") && !logins.to_string().contains("s3cr3t"));
        for url in ["http://github.com/login", "https://evil-github.com", "https://github.com.evil.io"] {
            let logins = bridge_request(&mut vault, &json!({ "type": "logins", "url": url })).unwrap();
            assert_eq!(logins["logins"], json!([]), "{url} got GitHub's login");
        }
        let fill = json!({ "type": "fill", "url": "https://github.com/login", "id": github });
        assert_eq!(bridge_request(&mut vault, &fill).unwrap()["password"], "s3cr3t");
        let foreign = json!({ "type": "fill", "url": "https://bank.example", "id": github });
        assert!(bridge_request(&mut vault, &foreign).is_err(), "filled another site's login");

        let save = |vault: &mut Vault, kind: &str, password: &str| {
            let request = json!({
                "type": kind,
                "url": "https://github.com/session",
                "username": "giaco",
                "password": password,
            });
            bridge_request(vault, &request).unwrap()["status"].clone()
        };
        assert_eq!(save(&mut vault, "save_status", "s3cr3t"), "same");
        assert_eq!(save(&mut vault, "save_status", "nueva"), "update");
        assert_eq!(vault.get(github).unwrap().password, "s3cr3t", "save_status wrote");
        assert_eq!(save(&mut vault, "save", "nueva"), "update");
        assert_eq!(vault.get(github).unwrap().password, "nueva");
        let request = json!({ "type": "save", "url": "https://news.example/login?next=/", "username": "yo", "password": "pw" });
        assert_eq!(bridge_request(&mut vault, &request).unwrap()["status"], "new");
        let saved = vault.entries().unwrap().into_iter().find(|e| e.username == "yo").unwrap();
        assert_eq!((saved.title.as_str(), saved.url.as_str()), ("news.example", "https://news.example"));

        vault.cipher = None;
        let logins = bridge_request(&mut vault, &json!({ "type": "logins", "url": "https://github.com" })).unwrap();
        assert_eq!(logins, json!({ "locked": true }));
        assert!(bridge_request(&mut vault, &json!({ "type": "unlock", "password": "otra" })).is_err());
        assert_eq!(bridge_request(&mut vault, &json!({ "type": "unlock", "password": MASTER })).unwrap()["unlocked"], true);
        assert_eq!(bridge_request(&mut vault, &json!({ "type": "logins", "url": "https://github.com" })).unwrap()["logins"].as_array().unwrap().len(), 1);
        vault.cipher = None;
        let generated = bridge_request(&mut vault, &json!({ "type": "generate" })).unwrap();
        assert_eq!(generated["password"].as_str().unwrap().len(), 20);
    }

    #[test]
    fn generated_passwords() {
        for length in [8, 20, 64] {
            let p = generate_password(length, true, true, true, true).unwrap();
            assert_eq!(p.len(), length);
            assert!(p.chars().any(|c| c.is_ascii_lowercase()));
            assert!(p.chars().any(|c| c.is_ascii_uppercase()));
            assert!(p.chars().any(|c| c.is_ascii_digit()));
            assert!(p.chars().any(|c| CHARSETS[3].contains(c)));
        }
        let digits = generate_password(12, false, false, true, false).unwrap();
        assert!(digits.len() == 12 && digits.chars().all(|c| c.is_ascii_digit()));
        assert!(generate_password(12, false, false, false, false).is_err());
    }
}
