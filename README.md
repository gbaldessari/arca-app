<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="Logo de Arca">
</p>

<h1 align="center">Arca</h1>

<p align="center">
  Gestor de contraseñas para Windows.<br>
  La bóveda se queda en tu equipo: sin cuenta, sin servidor y sin internet.
</p>

<p align="center">
  <img alt="Licencia GPL v3" src="https://img.shields.io/badge/licencia-GPL_v3-7C5CFF">
  <img alt="Plataforma Windows" src="https://img.shields.io/badge/plataforma-Windows-2F6FEB">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB">
</p>

<p align="center">
  <a href="https://github.com/gbaldessari/arca-extension"><strong>Extensión para Chrome, Edge y Firefox →</strong></a>
</p>

<br>

## Funciones

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>Bóveda cifrada</h3>
      Título, usuario, contraseña, sitio y notas. Cada entrada se cifra completa antes de tocar el disco.
    </td>
    <td width="33%" valign="top">
      <h3>Generador</h3>
      Contraseñas aleatorias del sistema, con la longitud y los caracteres que elijas, y una estimación de fortaleza.
    </td>
    <td width="33%" valign="top">
      <h3>Windows Hello</h3>
      Desbloqueo con PIN, huella o rostro. La contraseña maestra sigue funcionando.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Copias</h3>
      Un backup <code>.arca</code> cifrado, para restaurar en otro equipo o combinar con la bóveda abierta.
    </td>
    <td valign="top">
      <h3>Importar</h3>
      CSV de Chrome, Edge, Firefox, Bitwarden, KeePass y 1Password.
    </td>
    <td valign="top">
      <h3>Se bloquea sola</h3>
      A mano, a los 5 minutos, al bloquear Windows o al suspender el equipo.
    </td>
  </tr>
</table>

Tema claro, oscuro o el de Windows. `F11` pone la ventana en pantalla completa.

## Cómo está hecha

La ventana es WebView2. La interfaz, en React y TypeScript, pide datos con comandos de Tauri. Rust cifra, descifra y responde. La lista solo muestra título, usuario y sitio: la contraseña y las notas aparecen al abrir la entrada.

| Carpeta | Qué hay |
| --- | --- |
| `src/` | Interfaz. No guarda claves. |
| `src-tauri/src/lib.rs` | Bóveda, cifrado y generador. |
| `src-tauri/src/bridge.rs` | Conexión local con la extensión. |
| `src-tauri/src/platform.rs` | Windows Hello y bloqueo de sesión. |

La bóveda es un archivo SQLite en `%APPDATA%\com.arca.vault\arca.db`. Copiarlo alcanza para llevarte los datos, y sin la contraseña maestra no se abre. Si la olvidás, no hay forma de recuperarla.

## Cifrado

1. Al crear la bóveda, Arca genera una clave aleatoria de 32 bytes. Con ella cifra cada entrada con XChaCha20-Poly1305. El nonce viaja delante del texto cifrado y no se repite.
2. La contraseña maestra no se guarda. Argon2id (64 MiB, 3 pasadas, paralelismo 4) y una sal de 16 bytes derivan la clave que envuelve a la anterior. Cambiar la contraseña maestra solo vuelve a envolver esos 32 bytes.

La tabla de metadatos admite una sola fila, así que una bóveda nueva no puede pisar la que ya existe. El material de clave se borra de memoria al soltarlo.

Windows Hello es opcional. Una clave del TPM firma un desafío, y de esa firma se deriva el sobre de la clave de la bóveda. Cada desbloqueo pide el PIN, la huella o el rostro. Desactivarlo borra el sobre y la clave del TPM.

## Extensión

La integración nace apagada. Al activarla en Ajustes, Arca se registra como host `com.arca.vault` para Chrome, Edge y Firefox, abre un puerto al azar en `127.0.0.1` y anota ese puerto junto con una clave nueva en `%LOCALAPPDATA%\com.arca.vault\bridge.json`. Esa clave vive solo mientras la app está abierta.

El navegador no entra a ese puerto. Arranca `arca.exe`, que reenvía el mensaje. El tramo local va cifrado con la clave de esa ejecución. Al cerrar Arca, el archivo desaparece.

Un sitio recibe contraseñas guardadas para su propio host. Hace falta `https`, o `http` en `localhost` y `127.0.0.1`. `www` no cuenta, y un subdominio coincide con su dominio padre. Con la bóveda bloqueada, la extensión puede saber que está bloqueada, generar una contraseña y copiar texto. No puede leer entradas.

## Portapapeles

Lo que copiás queda fuera del historial de Windows y de la sincronización en la nube. Se borra a los 30 segundos, al bloquear la bóveda y al cerrar la app. Si el proceso muere antes, el texto puede seguir en el portapapeles.

## Desarrollo

Hace falta Node.js, Rust con las herramientas de MSVC y WebView2, que Windows 11 ya incluye.

```bash
npm install
npm run tauri dev
```

```bash
cd src-tauri
cargo test
```

`npm run tauri build` genera el MSI y el instalador NSIS. Los iconos salen de `app-icon.svg`:

```bash
npx tauri icon app-icon.svg
```

## Licencia

Software libre bajo la [GNU GPL v3](LICENSE), solo la versión 3. Se puede usar, estudiar, modificar y compartir. Quien distribuya una versión modificada tiene que publicar el código bajo la misma licencia.

Copyright (C) 2026 Giacomo Baldessari.
