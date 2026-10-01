# Arca

[Español](README.es.md)

![Arca logo](src-tauri/icons/128x128.png)

A password manager for Windows.
The vault stays on your computer: no account, no server, and no internet.

![GPL v3 license](https://img.shields.io/badge/license-GPL_v3-7C5CFF)
![Windows](https://img.shields.io/badge/platform-Windows-2F6FEB)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB)
![React](https://img.shields.io/badge/React-19-61DAFB)

[Extension for Chrome, Edge, and Firefox](https://github.com/gbaldessari/arca-extension)

## Features

| Encrypted vault | Generator | Windows Hello |
| --- | --- | --- |
| Title, username, password, site, and notes. Each entry is encrypted in full before it touches the disk. | Random passwords from the operating system, with the length and characters you choose, plus a strength estimate. | Unlock with a PIN, fingerprint, or face. The master password still works. |

| Backups | Import | Locks itself |
| --- | --- | --- |
| An encrypted `.arca` backup, to restore on another computer or merge into the open vault. | CSV from Chrome, Edge, Firefox, Bitwarden, KeePass, and 1Password. | Manually, after 5 minutes, when Windows locks, or when the computer sleeps. |

Light theme, dark theme, or the Windows theme. `F11` makes the window full screen.
The language follows Windows and can be changed in Settings.

## How it is built

The window is WebView2. The React and TypeScript interface asks for data through Tauri commands. Rust encrypts, decrypts, and answers. The list shows only the title, username, and site: the password and notes appear when you open the entry.

| Folder | What is there |
| --- | --- |
| `src/` | Interface. It does not store keys. |
| `src-tauri/src/lib.rs` | Vault, encryption, and generator. |
| `src-tauri/src/bridge.rs` | Local connection to the extension. |
| `src-tauri/src/platform.rs` | Windows Hello and session lock. |

The vault is a SQLite file at `%APPDATA%\com.arca.vault\arca.db`. Copying that file is enough to take your data with you, and it will not open without the master password. If you forget it, there is no way to recover it.

## Encryption

1. When the vault is created, Arca generates a random 32-byte key. It encrypts every entry with XChaCha20-Poly1305. The nonce travels in front of the ciphertext and is never reused.
2. The master password is not stored. Argon2id (64 MiB, 3 passes, parallelism 4) and a 16-byte salt derive the key that wraps the first one. Changing the master password only wraps those 32 bytes again.

The metadata table allows a single row, so a new vault cannot overwrite the one that already exists. Key material is wiped from memory when it is dropped.

Windows Hello is optional. A TPM key signs a challenge, and that signature derives the wrapping key for the vault key. Every unlock asks for the PIN, fingerprint, or face. Turning it off deletes the wrap and the TPM key.

## Extension

Integration starts turned off. When you turn it on in Settings, Arca registers itself as the `com.arca.vault` host for Chrome, Edge, and Firefox, opens a random port on `127.0.0.1`, and writes that port plus a new key to `%LOCALAPPDATA%\com.arca.vault\bridge.json`. That key lives only while the app is open.

The browser does not connect to that port. It starts `arca.exe`, which forwards the message. The local hop is encrypted with that run's key. When Arca closes, the file disappears. The host accepts the unpacked extension and the Edge Add-ons extension `peadbjdjjofiieihgijnjhlnmpeihiok`.

A site receives passwords saved for its own host. The page must be `https`, or `http` on `localhost` and `127.0.0.1`. `www` does not count, and a subdomain matches its parent domain. While the vault is locked, the extension can tell that it is locked, generate a password, and copy text. It cannot read entries. From the extension you can also open Arca, if it was closed, and unlock it with the master password or with Windows Hello.

## Clipboard

What you copy stays out of Windows history and cloud sync. It is cleared after 30 seconds, when the vault locks, and when the app closes. If the process is killed before that, the text can remain on the clipboard.

## Development

You need Node.js, Rust with the MSVC tools, and WebView2, which Windows 11 already includes.

```bash
npm install
npm run tauri dev
```

```bash
cd src-tauri
cargo test
```

`npm run tauri build` produces the MSI and the NSIS installer. Icons come from `app-icon.svg`:

```bash
npx tauri icon app-icon.svg
```

## License

Free software under the [GNU GPL v3](LICENSE), version 3 only. You can use, study, modify, and share it. Anyone who distributes a modified version must publish the source code under the same license.

Copyright © 2026 Giacomo Baldessari.
