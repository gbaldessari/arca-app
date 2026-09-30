import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Lang = "es" | "en";
export type LangPref = "system" | Lang;

const es = {
  masterCreates: "Crea la contraseña maestra que protegerá tu bóveda.",
  vaultLocked: "Tu bóveda está bloqueada.",
  masterPassword: "Contraseña maestra",
  repeatPassword: "Repite la contraseña",
  repeatMaster: "Repetir contraseña maestra",
  forgetHint: "Mínimo 8 caracteres. Si la olvidas, no hay forma de recuperar tus datos.",
  passwordsDontMatch: "Las contraseñas no coinciden",
  waitingHello: "Esperando a Windows Hello…",
  unlockHello: "Desbloquear con Windows Hello",
  oneMoment: "Un momento…",
  createVault: "Crear bóveda",
  useMaster: "Usar contraseña maestra",
  unlock: "Desbloquear",
  restoreBackup: "Restaurar desde un backup",
  restored: "Backup restaurado ({count}). Ingresa la contraseña maestra con la que lo creaste.",
  discardChanges: "Tienes cambios sin guardar. ¿Quieres descartarlos?",
  discard: "Descartar",
  search: "Buscar",
  searchPlaceholder: "Buscar…",
  newEntry: "Nueva entrada",
  entries: "Entradas",
  noUsername: "Sin usuario",
  favorite: "Favorito",
  noResults: "Sin resultados",
  noEntries: "Todavía no hay entradas",
  generator: "Generador",
  settings: "Ajustes",
  lock: "Bloquear",
  backToEntries: "Entradas",
  passwordGenerator: "Generador de contraseñas",
  savedEntry: "Entrada guardada",
  deleteConfirm: "¿Eliminar \"{title}\"? No se puede deshacer.",
  delete: "Eliminar",
  deletedEntry: "Entrada eliminada",
  noWebsite: "Sin sitio web",
  title: "Título",
  username: "Usuario",
  copyUsername: "Copiar usuario",
  usernameCopied: "Usuario copiado",
  password: "Contraseña",
  hidePassword: "Ocultar contraseña",
  showPassword: "Mostrar contraseña",
  copyPassword: "Copiar contraseña",
  passwordCopied: "Contraseña copiada",
  generatePassword: "Generar contraseña",
  website: "Sitio web",
  notes: "Notas",
  saved: "Guardado",
  save: "Guardar",
  appearance: "Apariencia",
  theme: "Tema",
  system: "Sistema",
  light: "Claro",
  dark: "Oscuro",
  themeHint: "\"Sistema\" sigue el modo claro u oscuro de Windows. Pulsa F11 para pantalla completa.",
  language: "Idioma",
  languageHint: "\"Sistema\" usa el idioma de Windows.",
  browserIntegration: "Integración con el navegador",
  integrationReady: "Listo: la extensión de Arca ya puede conectarse con esta app.",
  allowExtension: "Permitir que la extensión rellene, sugiera y guarde contraseñas",
  integrationHint:
    "La extensión para Chrome, Edge y Firefox habla solo con esta app, en tu equipo y cifrado. Solo recibe las contraseñas del sitio que tienes abierto, y únicamente mientras Arca está desbloqueada.",
  newPasswordsDontMatch: "Las contraseñas nuevas no coinciden",
  masterUpdated: "Contraseña maestra actualizada.",
  currentPassword: "Contraseña actual",
  newMaster: "Nueva contraseña maestra",
  newPassword: "Nueva contraseña",
  repeatNewMaster: "Repetir nueva contraseña maestra",
  repeatNew: "Repite la nueva contraseña",
  changePassword: "Cambiar contraseña",
  helloOff: "Windows Hello desactivado.",
  helloOn: "Windows Hello activado.",
  helloUnavailable: "No disponible: configura un PIN, huella o rostro en la configuración de Windows.",
  helloEnabledHint: "Puedes desbloquear Arca con tu PIN, huella o rostro.",
  helloDisabledHint: "Desbloquea Arca con tu PIN, huella o rostro. La contraseña maestra seguirá funcionando.",
  disable: "Desactivar",
  enable: "Activar",
  backupSaved: "Backup guardado. Está cifrado: para abrirlo hace falta tu contraseña maestra.",
  imported: "Se importaron {count}.",
  nothingNew: "No había entradas nuevas para importar.",
  oneEntry: "1 entrada",
  manyEntries: "{count} entradas",
  backups: "Copias de seguridad e importación",
  backupsHint:
    "El backup es una copia cifrada de tu bóveda. También puedes importar el CSV que exportan Chrome, Edge, Firefox, Bitwarden, KeePass o 1Password; después bórralo, porque guarda tus contraseñas sin cifrar.",
  exportBackup: "Exportar backup",
  importBackup: "Importar backup o CSV",
  regenerate: "Regenerar",
  copyGenerated: "Copiar contraseña generada",
  length: "Longitud",
  lowercase: "Minúsculas",
  uppercase: "Mayúsculas",
  digits: "Números",
  symbols: "Símbolos",
  useThis: "Usar esta",
  veryWeak: "Muy débil",
  weak: "Débil",
  fair: "Aceptable",
  good: "Buena",
  veryStrong: "Muy fuerte",
  copiedClear: "{text} · se borrará en 30 s",
} as const;

const en: { [K in keyof typeof es]: string } = {
  masterCreates: "Create the master password that will protect your vault.",
  vaultLocked: "Your vault is locked.",
  masterPassword: "Master password",
  repeatPassword: "Repeat the password",
  repeatMaster: "Repeat master password",
  forgetHint: "At least 8 characters. If you forget it, there is no way to recover your data.",
  passwordsDontMatch: "The passwords do not match",
  waitingHello: "Waiting for Windows Hello…",
  unlockHello: "Unlock with Windows Hello",
  oneMoment: "One moment…",
  createVault: "Create vault",
  useMaster: "Use master password",
  unlock: "Unlock",
  restoreBackup: "Restore from a backup",
  restored: "Backup restored ({count}). Enter the master password it was created with.",
  discardChanges: "You have unsaved changes. Do you want to discard them?",
  discard: "Discard",
  search: "Search",
  searchPlaceholder: "Search…",
  newEntry: "New entry",
  entries: "Entries",
  noUsername: "No username",
  favorite: "Favorite",
  noResults: "No results",
  noEntries: "There are no entries yet",
  generator: "Generator",
  settings: "Settings",
  lock: "Lock",
  backToEntries: "Entries",
  passwordGenerator: "Password generator",
  savedEntry: "Entry saved",
  deleteConfirm: "Delete \"{title}\"? This cannot be undone.",
  delete: "Delete",
  deletedEntry: "Entry deleted",
  noWebsite: "No website",
  title: "Title",
  username: "Username",
  copyUsername: "Copy username",
  usernameCopied: "Username copied",
  password: "Password",
  hidePassword: "Hide password",
  showPassword: "Show password",
  copyPassword: "Copy password",
  passwordCopied: "Password copied",
  generatePassword: "Generate password",
  website: "Website",
  notes: "Notes",
  saved: "Saved",
  save: "Save",
  appearance: "Appearance",
  theme: "Theme",
  system: "System",
  light: "Light",
  dark: "Dark",
  themeHint: "\"System\" follows Windows light or dark mode. Press F11 for full screen.",
  language: "Language",
  languageHint: "\"System\" uses the Windows language.",
  browserIntegration: "Browser integration",
  integrationReady: "Ready: the Arca extension can now connect to this app.",
  allowExtension: "Let the extension fill, suggest, and save passwords",
  integrationHint:
    "The Chrome, Edge, and Firefox extension talks only to this app, on your computer, and the channel is encrypted. It only receives passwords for the site you have open, and only while Arca is unlocked.",
  newPasswordsDontMatch: "The new passwords do not match",
  masterUpdated: "Master password updated.",
  currentPassword: "Current password",
  newMaster: "New master password",
  newPassword: "New password",
  repeatNewMaster: "Repeat new master password",
  repeatNew: "Repeat the new password",
  changePassword: "Change password",
  helloOff: "Windows Hello turned off.",
  helloOn: "Windows Hello turned on.",
  helloUnavailable: "Unavailable: set up a PIN, fingerprint, or face in Windows settings.",
  helloEnabledHint: "You can unlock Arca with your PIN, fingerprint, or face.",
  helloDisabledHint: "Unlock Arca with your PIN, fingerprint, or face. The master password will still work.",
  disable: "Turn off",
  enable: "Turn on",
  backupSaved: "Backup saved. It is encrypted: opening it requires your master password.",
  imported: "Imported {count}.",
  nothingNew: "There were no new entries to import.",
  oneEntry: "1 entry",
  manyEntries: "{count} entries",
  backups: "Backups and import",
  backupsHint:
    "A backup is an encrypted copy of your vault. You can also import the CSV exported by Chrome, Edge, Firefox, Bitwarden, KeePass, or 1Password; delete it afterwards, because it stores your passwords unencrypted.",
  exportBackup: "Export backup",
  importBackup: "Import backup or CSV",
  regenerate: "Regenerate",
  copyGenerated: "Copy generated password",
  length: "Length",
  lowercase: "Lowercase",
  uppercase: "Uppercase",
  digits: "Numbers",
  symbols: "Symbols",
  useThis: "Use this one",
  veryWeak: "Very weak",
  weak: "Weak",
  fair: "Fair",
  good: "Good",
  veryStrong: "Very strong",
  copiedClear: "{text} · cleared in 30 s",
};

export type Key = keyof typeof es;

const KEY = "arca-lang";

export function systemLang(): Lang {
  return navigator.language.toLowerCase().startsWith("en") ? "en" : "es";
}

export function savedLangPref(): LangPref {
  const value = localStorage.getItem(KEY);
  return value === "es" || value === "en" || value === "system" ? value : "system";
}

export function resolveLang(pref: LangPref): Lang {
  return pref === "system" ? systemLang() : pref;
}

function format(text: string, vars?: Record<string, string | number>) {
  if (!vars) return text;
  return Object.entries(vars).reduce((out, [name, value]) => out.split(`{${name}}`).join(String(value)), text);
}

type I18n = {
  pref: LangPref;
  lang: Lang;
  setPref: (pref: LangPref) => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
};

const Context = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<LangPref>(savedLangPref);
  const lang = resolveLang(pref);

  useEffect(() => {
    document.documentElement.lang = lang;
    invoke("set_language", { lang }).catch(() => {});
  }, [lang]);

  const setPref = (next: LangPref) => {
    localStorage.setItem(KEY, next);
    setPrefState(next);
  };

  const t = (key: Key, vars?: Record<string, string | number>) => format((lang === "en" ? en : es)[key], vars);

  return <Context.Provider value={{ pref, lang, setPref, t }}>{children}</Context.Provider>;
}

export function useI18n() {
  const value = useContext(Context);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}
