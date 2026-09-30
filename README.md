# Arca

Gestor de contraseñas de escritorio para Windows. La bóveda vive en el equipo: no hay cuenta, no hay servidor y la aplicación no necesita internet para funcionar.

La interfaz está hecha con React y TypeScript. Todo lo que toca una contraseña o una clave está en Rust. Este repositorio se publica para que ese código se pueda leer y auditar. La extensión de navegador, que es un proyecto aparte, está en [arca-extension](https://github.com/gbaldessari/arca-extension).

Todavía no hay una licencia de uso elegida. Publicar el repositorio permite revisarlo; no autoriza por sí solo a reutilizarlo.

## Qué hace

- Crea una bóveda con una contraseña maestra y guarda entradas (título, usuario, contraseña, sitio y notas).
- Genera contraseñas con el generador aleatorio del sistema y muestra una estimación de fortaleza (zxcvbn).
- Cifra un backup `.arca`, restaura uno en una instalación nueva o combina sus entradas con la bóveda abierta.
- Importa CSV de Chrome, Edge, Firefox, Bitwarden, KeePass y 1Password.
- Cambia la contraseña maestra sin volver a cifrar cada entrada.
- Se bloquea a mano, a los 5 minutos sin actividad, al bloquear Windows o al suspender el equipo.
- Puede desbloquearse con Windows Hello, además de la contraseña maestra.
- Tema claro, oscuro o el del sistema. `F11` alterna la pantalla completa.
- Si se activa en Ajustes, atiende a la extensión de navegador en este mismo equipo.

## Cómo está armada

```
src/                  React. No guarda claves ni descifra nada.
src-tauri/src/lib.rs  Bóveda, cifrado, generador y comandos de Tauri.
src-tauri/src/bridge.rs
                      Comunicación local con la extensión.
src-tauri/src/platform.rs
                      Windows Hello y avisos de bloqueo de sesión.
```

La ventana es WebView2. La interfaz llama comandos de Tauri (`invoke`) y Rust responde. La lista de entradas solo incluye título, usuario, sitio y si es favorita: la contraseña y las notas se descifran cuando se abre esa entrada.

SQLite guarda la bóveda en `%APPDATA%\com.arca.vault\arca.db`. Copiar ese archivo es un backup, pero sigue cifrado: sin la contraseña maestra no se abre.

## Cifrado

Hay dos niveles de clave.

1. Al crear la bóveda, Rust genera una clave aleatoria de 32 bytes. Con esa clave se cifra cada entrada completa (título incluido) con XChaCha20-Poly1305. El nonce de 24 bytes va delante del texto cifrado y no se reutiliza.
2. La contraseña maestra no se guarda. Argon2id (64 MiB, 3 pasadas, paralelismo 4) deriva una clave a partir de la contraseña y de una sal aleatoria de 16 bytes. Esa clave solo envuelve la clave de la bóveda. Cambiar la contraseña maestra genera otra sal y vuelve a envolver esos 32 bytes.

La tabla `meta` admite una sola fila, así que crear una bóveda no puede pisar una que ya existe. Argon2id y el cifrado autenticado borran su material de clave al soltarlo (`zeroize`).

Windows Hello es opcional. La clave de la bóveda queda envuelta por otra clave derivada con Argon2id a partir de la firma que produce una clave del TPM. Cada desbloqueo pide el PIN, la huella o el rostro, firma el mismo desafío y reconstruye esa clave. La contraseña maestra sigue sirviendo. Desactivar Hello borra ese sobre y la clave del TPM.

El generador usa el generador del sistema (`SysRng`), sin sesgo, y mete al menos un carácter de cada conjunto elegido antes de mezclar el resultado.

## Extensión de navegador

La integración está apagada hasta que se activa en Ajustes. Al activarla, la app:

- se registra como host de native messaging `com.arca.vault` para Chrome, Edge y Firefox;
- abre un puerto en `127.0.0.1` elegido al azar;
- escribe en `%LOCALAPPDATA%\com.arca.vault\bridge.json` el puerto y una clave nueva, que solo vive mientras la app está abierta.

El navegador no se conecta a ese puerto. Arranca `arca.exe` como host, y ese proceso solo reenvía cada mensaje. El intercambio usa el formato de native messaging (longitud de 32 bits y JSON) y, en el tramo local, cada línea va cifrada con la clave de esa ejecución. Al cerrar la app se borra `bridge.json`.

Un sitio solo recibe contraseñas guardadas para su propio host: hace falta `https`, o `http` si es `localhost` o `127.0.0.1`. `www` se ignora, y un subdominio coincide con su dominio padre en los dos sentidos. No se consulta la lista de sufijos públicos: una entrada guardada para `co.uk` coincidiría con cualquier `algo.co.uk`.

Con la bóveda bloqueada, la extensión puede saber que está bloqueada, generar una contraseña y copiar texto. No puede leer entradas. Generar y copiar texto tampoco exigen que la bóveda esté desbloqueada.

## Portapapeles

Lo que se copia se marca para que Windows no lo meta en el historial ni lo suba a la nube, y se borra a los 30 segundos si sigue ahí. También se borra al bloquear la bóveda y al cerrar la aplicación. Si el proceso muere antes de ese plazo, el texto puede quedar en el portapapeles.

## Desarrollo

Hace falta Node.js, Rust (MSVC) y el runtime de WebView2, que Windows 11 ya trae.

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

## Para auditar

El núcleo que conviene leer, y que tiene pruebas, está en `src-tauri/src/lib.rs` y `src-tauri/src/bridge.rs`. `cargo test` cubre el ciclo de la bóveda, el cambio de contraseña maestra, el sobre de Windows Hello, los backups, el CSV y las reglas con las que un sitio puede pedir una contraseña.

Puntos que el diseño deja abiertos:

- Con la bóveda desbloqueada, las entradas abiertas y la clave viven en memoria del proceso y del WebView. JavaScript no ofrece una forma fiable de borrarlas al bloquear.
- Cualquier programa que corra con el mismo usuario de Windows puede leer `bridge.json` mientras Arca está abierto. Si la integración está activa y la bóveda desbloqueada, ese programa puede pedir lo mismo que la extensión. El registro de native messaging solo limita qué extensión puede hablar con el host, no qué proceso local puede abrir el puerto.
- La extensión escribe la contraseña elegida en la página. A partir de ese momento el JavaScript de esa página puede leerla.
- No hay recuperación si se olvida la contraseña maestra.
- Cerrar la ventana no pregunta por cambios sin guardar. El aviso aparece al cambiar de entrada dentro de la app.
- Los instaladores no están firmados. Windows SmartScreen puede mostrar una advertencia hasta que el binario se firme con un certificado de firma de código.
