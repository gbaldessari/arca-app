import {
  ButtonHTMLAttributes,
  ChangeEvent,
  FormEvent,
  RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArchiveRestore,
  ArrowLeft,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  DatabaseBackup,
  Download,
  Eye,
  EyeOff,
  FingerprintPattern,
  Globe,
  KeyRound,
  LoaderCircle,
  Lock,
  LockOpen,
  LucideProvider,
  Monitor,
  Moon,
  Palette,
  Plus,
  Puzzle,
  RefreshCw,
  Save,
  Search,
  SearchX,
  Settings as SettingsIcon,
  ShieldCheck,
  Star,
  Sun,
  Trash,
  Upload,
  User,
  Vault as VaultIcon,
  WandSparkles,
} from "lucide-react";
import logo from "../app-icon.svg?no-inline";
import { applyTheme, savedTheme, ThemePref } from "./theme";
import "./App.css";

type Status = "new" | "locked" | "unlocked";
type Summary = { id: number; title: string; username: string; url: string; favorite: boolean };
type Entry = {
  id: number | null;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  favorite: boolean;
};
type Pane = Entry | "generator" | "settings";
type Notice = { text: string; error?: boolean } | null;
type HelloStatus = { available: boolean; enabled: boolean };
type GeneratorOptions = {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
};

const EMPTY_ENTRY: Entry = {
  id: null,
  title: "",
  username: "",
  password: "",
  url: "",
  notes: "",
  favorite: false,
};
const AUTO_LOCK_MS = 5 * 60 * 1000;
const CHARSETS = [
  ["lower", "Minúsculas"],
  ["upper", "Mayúsculas"],
  ["digits", "Números"],
  ["symbols", "Símbolos"],
] as const;
const STRENGTH = ["Muy débil", "Débil", "Aceptable", "Buena", "Muy fuerte"];
const THEMES = [
  ["system", "Sistema", Monitor],
  ["light", "Claro", Sun],
  ["dark", "Oscuro", Moon],
] as const;

const confirmDialog = (message: string, ok: string) => invoke<boolean>("confirm", { message, ok });
const entriesText = (count: number) => (count === 1 ? "1 entrada" : `${count} entradas`);
const host = (url: string) => url.replace(/^\w+:\/\//, "").split(/[/?#]/)[0];
const toast = (text: string) => window.dispatchEvent(new CustomEvent("arca-toast", { detail: text }));

export default function App() {
  const [status, setStatus] = useState<Status>();

  useEffect(() => {
    const refresh = () => invoke<Status>("status").then(setStatus);
    refresh();
    const unlisten = listen("locked", refresh);
    const fullscreen = async (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      e.preventDefault();
      const window = getCurrentWindow();
      await window.setFullscreen(!(await window.isFullscreen()));
    };
    addEventListener("keydown", fullscreen);
    return () => {
      unlisten.then((stop) => stop());
      removeEventListener("keydown", fullscreen);
    };
  }, []);

  return (
    <LucideProvider size={16} strokeWidth={2}>
      {status === "unlocked" ? (
        <Vault onLock={() => invoke("lock")} />
      ) : (
        status && <Unlock isNew={status === "new"} onStatus={setStatus} />
      )}
      <Toast />
    </LucideProvider>
  );
}

function Unlock({ isNew, onStatus }: { isNew: boolean; onStatus: (status: Status) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [hello, setHello] = useState(false);
  const [shaking, setShaking] = useState(false);

  useEffect(() => {
    if (!isNew) invoke<HelloStatus>("hello_status").then((h) => setHello(h.available && h.enabled));
  }, [isNew]);

  const fail = (text: string) => {
    setNotice({ text, error: true });
    setShaking(true);
  };

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      onStatus("unlocked");
    } catch (err) {
      fail(String(err));
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (isNew && password !== confirm) return fail("Las contraseñas no coinciden");
    run(() => invoke(isNew ? "create_vault" : "unlock", { password }));
  }

  async function restore() {
    try {
      const count = await invoke<number | null>("import_file");
      if (count === null) return;
      setNotice({
        text: `Backup restaurado (${entriesText(count)}). Ingresa la contraseña maestra con la que lo creaste.`,
      });
      onStatus("locked");
    } catch (err) {
      fail(String(err));
    }
  }

  return (
    <div className="unlock-screen">
      <form
        className={shaking ? "unlock shake" : "unlock"}
        onSubmit={submit}
        onAnimationEnd={(e) => e.animationName === "shake" && setShaking(false)}
      >
        <img src={logo} alt="" className="unlock-logo" />
        <h1>Arca</h1>
        <p className="muted">
          {isNew ? "Crea la contraseña maestra que protegerá tu bóveda." : "Tu bóveda está bloqueada."}
        </p>
        <div className="field">
          <KeyRound className="field-icon" />
          <input
            type="password"
            aria-label="Contraseña maestra"
            placeholder="Contraseña maestra"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {isNew && (
          <>
            <Strength password={password} />
            <div className="field">
              <KeyRound className="field-icon" />
              <input
                type="password"
                aria-label="Repetir contraseña maestra"
                placeholder="Repite la contraseña"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <p className="hint">Mínimo 8 caracteres. Si la olvidas, no hay forma de recuperar tus datos.</p>
          </>
        )}
        <Message notice={notice} />
        <button className="primary big" disabled={busy || !password}>
          {busy ? <LoaderCircle className="spin" /> : isNew ? <ShieldCheck /> : <LockOpen />}
          {busy ? "Un momento…" : isNew ? "Crear bóveda" : "Desbloquear"}
        </button>
        {hello && (
          <button type="button" className="big" disabled={busy} onClick={() => run(() => invoke("unlock_with_hello"))}>
            <FingerprintPattern />
            Usar Windows Hello
          </button>
        )}
        {isNew && (
          <button type="button" className="link" onClick={restore}>
            <ArchiveRestore />
            Restaurar desde un backup
          </button>
        )}
      </form>
    </div>
  );
}

function Vault({ onLock }: { onLock: () => void }) {
  const [entries, setEntries] = useState<Summary[]>([]);
  const [pane, setPane] = useState<Pane>("generator");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  // Narrow windows show either the list or the open pane; wide ones ignore this.
  const [view, setView] = useState<"list" | "detail">("list");
  const dirty = useRef(false);

  const showError = (err: unknown) => setError(String(err));
  const load = () => invoke<Summary[]>("list_entries").then(setEntries, showError);
  const show = (next: Pane) => {
    setPane(next);
    setView("detail");
  };
  const open = (id: number) => invoke<Entry>("get_entry", { id }).then(show, showError);

  async function leave(next: () => void) {
    if (dirty.current && !(await confirmDialog("Tienes cambios sin guardar. ¿Quieres descartarlos?", "Descartar")))
      return;
    dirty.current = false;
    next();
  }

  useEffect(() => {
    load();
    const unlisten = listen("entries-changed", load);
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    let timer = window.setTimeout(onLock, AUTO_LOCK_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onLock, AUTO_LOCK_MS);
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"];
    events.forEach((name) => window.addEventListener(name, reset));
    return () => {
      window.clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, reset));
    };
  }, [onLock]);

  const q = query.toLowerCase();
  const shown = entries
    .filter((e) => [e.title, e.username, e.url].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title));
  const current = typeof pane === "object" ? pane : null;

  return (
    <div className="vault" data-view={view}>
      <aside className="sidebar">
        <div className="brand">
          <img src={logo} alt="" />
          Arca
        </div>
        <div className="field">
          <Search className="field-icon" />
          <input
            type="search"
            aria-label="Buscar"
            placeholder="Buscar…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="primary" onClick={() => leave(() => show({ ...EMPTY_ENTRY }))}>
          <Plus />
          Nueva entrada
        </button>
        <p className="section-label">
          Entradas <span>{entries.length}</span>
        </p>
        <nav aria-label="Entradas" className="list">
          {shown.map((e) => (
            <button
              key={e.id}
              className="item"
              aria-current={e.id === current?.id}
              onClick={() => leave(() => open(e.id))}
            >
              <Avatar title={e.title} />
              <span className="item-text">
                <strong>{e.title}</strong>
                <span>{e.username || "Sin usuario"}</span>
              </span>
              {e.favorite && <Star className="fav" aria-label="Favorito" />}
            </button>
          ))}
          {!shown.length && (
            <div className="empty">
              {entries.length ? <SearchX /> : <VaultIcon />}
              <p>{entries.length ? "Sin resultados" : "Todavía no hay entradas"}</p>
            </div>
          )}
        </nav>
        <div className="sidebar-footer">
          <button
            className="nav"
            title="Generador"
            aria-current={pane === "generator"}
            onClick={() => leave(() => show("generator"))}
          >
            <WandSparkles />
            <span>Generador</span>
          </button>
          <button
            className="nav"
            title="Ajustes"
            aria-current={pane === "settings"}
            onClick={() => leave(() => show("settings"))}
          >
            <SettingsIcon />
            <span>Ajustes</span>
          </button>
          <button className="nav" title="Bloquear" onClick={() => leave(onLock)}>
            <Lock />
            <span>Bloquear</span>
          </button>
        </div>
      </aside>
      <main>
        <button className="link back" onClick={() => setView("list")}>
          <ArrowLeft />
          Entradas
        </button>
        <Message notice={error ? { text: error, error: true } : null} />
        <div className="pane" key={current ? `entry-${current.id ?? "new"}` : String(pane)}>
          {current ? (
            <EntryForm
              key={current.id ?? "new"}
              entry={current}
              dirty={dirty}
              onSaved={(id) => {
                load();
                open(id);
              }}
              onDeleted={() => {
                load();
                setPane("generator");
                setView("list");
              }}
            />
          ) : pane === "settings" ? (
            <Settings onImported={load} />
          ) : (
            <>
              <h2>Generador de contraseñas</h2>
              <Generator />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function EntryForm({
  entry,
  dirty,
  onSaved,
  onDeleted,
}: {
  entry: Entry;
  dirty: RefObject<boolean>;
  onSaved: (id: number) => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState(entry);
  const [saved, setSaved] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [error, setError] = useState("");

  const changed = (Object.keys(entry) as (keyof Entry)[]).some((key) => form[key] !== entry[key]);
  useEffect(() => {
    dirty.current = changed;
  }, [changed, dirty]);
  useEffect(
    () => () => {
      dirty.current = false;
    },
    [dirty],
  );

  const update = (patch: Partial<Entry>) => {
    setForm({ ...form, ...patch });
    setSaved(false);
  };
  const field = (key: Exclude<keyof Entry, "id" | "favorite">) => ({
    id: key,
    value: form[key],
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update({ [key]: e.target.value }),
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const id = await invoke<number>("save_entry", { entry: form });
      dirty.current = false;
      setSaved(true);
      toast("Entrada guardada");
      onSaved(id);
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove() {
    if (!(await confirmDialog(`¿Eliminar "${form.title}"? No se puede deshacer.`, "Eliminar"))) return;
    try {
      await invoke("delete_entry", { id: form.id });
      dirty.current = false;
      toast("Entrada eliminada");
      onDeleted();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form className="entry" onSubmit={save}>
      <header className="entry-header">
        <Avatar title={form.title} large />
        <div className="entry-heading">
          <h2>{form.title || "Nueva entrada"}</h2>
          <p className="muted">{host(form.url) || "Sin sitio web"}</p>
        </div>
        <IconButton
          label="Favorito"
          className="icon-btn star-btn"
          aria-pressed={form.favorite}
          onClick={() => update({ favorite: !form.favorite })}
        >
          <Star size={20} />
        </IconButton>
      </header>

      <label htmlFor="title">Título</label>
      <div className="field">
        <input required autoFocus={form.id === null} {...field("title")} />
      </div>

      <label htmlFor="username">Usuario</label>
      <div className="field">
        <User className="field-icon" />
        <input {...field("username")} />
        <CopyButton text={form.username} label="Copiar usuario" done="Usuario copiado" />
      </div>

      <label htmlFor="password">Contraseña</label>
      <div className="field">
        <KeyRound className="field-icon" />
        <input type={showPassword ? "text" : "password"} className="mono" {...field("password")} />
        <IconButton
          label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
          onClick={() => setShowPassword(!showPassword)}
        >
          {showPassword ? <EyeOff /> : <Eye />}
        </IconButton>
        <CopyButton text={form.password} label="Copiar contraseña" done="Contraseña copiada" />
        <IconButton
          label="Generar contraseña"
          aria-expanded={showGenerator}
          onClick={() => setShowGenerator(!showGenerator)}
        >
          <WandSparkles />
        </IconButton>
      </div>
      <Strength password={form.password} inputs={[form.title, form.username, form.url]} />
      {showGenerator && (
        <Generator
          onUse={(password) => {
            update({ password });
            setShowGenerator(false);
          }}
        />
      )}

      <label htmlFor="url">Sitio web</label>
      <div className="field">
        <Globe className="field-icon" />
        <input placeholder="https://" {...field("url")} />
      </div>

      <label htmlFor="notes">Notas</label>
      <div className="field">
        <textarea rows={3} {...field("notes")} />
      </div>

      <Message notice={error ? { text: error, error: true } : null} />
      <div className="actions">
        {form.id !== null && (
          <button type="button" className="danger" onClick={remove}>
            <Trash />
            Eliminar
          </button>
        )}
        <button type="submit" className="primary">
          {saved ? <Check /> : <Save />}
          {saved ? "Guardado" : "Guardar"}
        </button>
      </div>
    </form>
  );
}

function Settings({ onImported }: { onImported: () => void }) {
  return (
    <div className="settings">
      <h2>Ajustes</h2>
      <Appearance />
      <ChangePassword />
      <HelloSettings />
      <BrowserIntegration />
      <Backups onImported={onImported} />
    </div>
  );
}

function Appearance() {
  const [theme, setTheme] = useState<ThemePref>(savedTheme);

  const choose = (pref: ThemePref) => {
    setTheme(pref);
    applyTheme(pref);
  };

  return (
    <section className="panel">
      <h3>
        <Palette />
        Apariencia
      </h3>
      <div className="segmented" role="radiogroup" aria-label="Tema">
        {THEMES.map(([value, label, Icon]) => (
          <label key={value} className="segment">
            <input type="radio" name="theme" checked={theme === value} onChange={() => choose(value)} />
            <Icon />
            {label}
          </label>
        ))}
      </div>
      <p className="muted">"Sistema" sigue el modo claro u oscuro de Windows. Pulsa F11 para pantalla completa.</p>
    </section>
  );
}

function BrowserIntegration() {
  const [enabled, setEnabled] = useState<boolean>();
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    invoke<boolean>("browser_integration").then(setEnabled);
  }, []);

  async function toggle(next: boolean) {
    try {
      await invoke("set_browser_integration", { enabled: next });
      setEnabled(next);
      setNotice(next ? { text: "Listo: la extensión de Arca ya puede conectarse con esta app." } : null);
    } catch (err) {
      setNotice({ text: String(err), error: true });
    }
  }

  if (enabled === undefined) return null;
  return (
    <section className="panel">
      <h3>
        <Puzzle />
        Integración con el navegador
      </h3>
      <label className="switch">
        <input type="checkbox" role="switch" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        Permitir que la extensión rellene, sugiera y guarde contraseñas
      </label>
      <p className="muted">
        La extensión para Chrome, Edge y Firefox habla solo con esta app, en tu equipo y cifrado. Solo recibe las
        contraseñas del sitio que tienes abierto, y únicamente mientras Arca está desbloqueada.
      </p>
      <Message notice={notice} />
    </section>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) return setNotice({ text: "Las contraseñas nuevas no coinciden", error: true });
    setBusy(true);
    try {
      await invoke("change_master_password", { current, newPassword: next });
      setCurrent("");
      setNext("");
      setRepeat("");
      setNotice({ text: "Contraseña maestra actualizada." });
    } catch (err) {
      setNotice({ text: String(err), error: true });
    }
    setBusy(false);
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h3>
        <KeyRound />
        Contraseña maestra
      </h3>
      <div className="field">
        <input
          type="password"
          aria-label="Contraseña actual"
          placeholder="Contraseña actual"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="field">
        <input
          type="password"
          aria-label="Nueva contraseña maestra"
          placeholder="Nueva contraseña"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </div>
      <Strength password={next} />
      <div className="field">
        <input
          type="password"
          aria-label="Repetir nueva contraseña maestra"
          placeholder="Repite la nueva contraseña"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </div>
      <Message notice={notice} />
      <button className="primary" disabled={busy || !current || !next}>
        {busy && <LoaderCircle className="spin" />}
        {busy ? "Un momento…" : "Cambiar contraseña"}
      </button>
    </form>
  );
}

function HelloSettings() {
  const [hello, setHello] = useState<HelloStatus>();
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => invoke<HelloStatus>("hello_status").then(setHello);
  useEffect(() => {
    refresh();
  }, []);

  async function toggle(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await invoke(hello?.enabled ? "disable_hello" : "enable_hello", { password });
      setPassword("");
      setNotice({ text: hello?.enabled ? "Windows Hello desactivado." : "Windows Hello activado." });
      await refresh();
    } catch (err) {
      setNotice({ text: String(err), error: true });
    }
    setBusy(false);
  }

  if (!hello) return null;
  return (
    <form className="panel" onSubmit={toggle}>
      <h3>
        <FingerprintPattern />
        Windows Hello
      </h3>
      {!hello.available ? (
        <p className="muted">No disponible: configura un PIN, huella o rostro en la configuración de Windows.</p>
      ) : (
        <>
          <p className="muted">
            {hello.enabled
              ? "Puedes desbloquear Arca con tu PIN, huella o rostro."
              : "Desbloquea Arca con tu PIN, huella o rostro. La contraseña maestra seguirá funcionando."}
          </p>
          {!hello.enabled && (
            <div className="field">
              <input
                type="password"
                aria-label="Contraseña maestra"
                placeholder="Contraseña maestra"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          <Message notice={notice} />
          <button className={hello.enabled ? undefined : "primary"} disabled={busy || (!hello.enabled && !password)}>
            {busy ? <LoaderCircle className="spin" /> : <FingerprintPattern />}
            {busy ? "Esperando a Windows Hello…" : hello.enabled ? "Desactivar" : "Activar"}
          </button>
        </>
      )}
    </form>
  );
}

function Backups({ onImported }: { onImported: () => void }) {
  const [notice, setNotice] = useState<Notice>(null);
  const fail = (err: unknown) => setNotice({ text: String(err), error: true });

  const exportBackup = () =>
    invoke<boolean>("export_backup").then((saved) => {
      if (saved) setNotice({ text: "Backup guardado. Está cifrado: para abrirlo hace falta tu contraseña maestra." });
    }, fail);

  const importFile = () =>
    invoke<number | null>("import_file").then((count) => {
      if (count === null) return;
      setNotice({ text: count ? `Se importaron ${entriesText(count)}.` : "No había entradas nuevas para importar." });
      onImported();
    }, fail);

  return (
    <section className="panel">
      <h3>
        <DatabaseBackup />
        Copias de seguridad e importación
      </h3>
      <p className="muted">
        El backup es una copia cifrada de tu bóveda. También puedes importar el CSV que exportan Chrome, Edge,
        Firefox, Bitwarden, KeePass o 1Password; después bórralo, porque guarda tus contraseñas sin cifrar.
      </p>
      <div className="row">
        <button onClick={exportBackup}>
          <Download />
          Exportar backup
        </button>
        <button onClick={importFile}>
          <Upload />
          Importar backup o CSV
        </button>
      </div>
      <Message notice={notice} />
    </section>
  );
}

function Generator({ onUse }: { onUse?: (password: string) => void }) {
  const [options, setOptions] = useState<GeneratorOptions>({
    length: 20,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
  });
  const [password, setPassword] = useState("");

  useEffect(() => {
    invoke<string>("generate_password", options).then(setPassword);
  }, [options]);

  const enabledSets = CHARSETS.filter(([key]) => options[key]).length;

  return (
    <section className="panel generator" aria-label="Generador de contraseñas">
      <div className="generated">
        <output key={password} className="mono">
          {password}
        </output>
        <IconButton label="Regenerar" className="icon-btn regenerate" onClick={() => setOptions({ ...options })}>
          <RefreshCw />
        </IconButton>
        <CopyButton text={password} label="Copiar contraseña generada" done="Contraseña copiada" />
      </div>
      <Strength password={password} />
      <label className="slider">
        <span>Longitud</span>
        <strong>{options.length}</strong>
        <input
          type="range"
          min={8}
          max={64}
          value={options.length}
          onChange={(e) => setOptions({ ...options, length: Number(e.target.value) })}
        />
      </label>
      <div className="chips">
        {CHARSETS.map(([key, label]) => (
          <label key={key} className="chip">
            <input
              type="checkbox"
              checked={options[key]}
              disabled={options[key] && enabledSets === 1}
              onChange={(e) => setOptions({ ...options, [key]: e.target.checked })}
            />
            <Check />
            {label}
          </label>
        ))}
      </div>
      {onUse && (
        <button type="button" className="primary" onClick={() => onUse(password)}>
          <Check />
          Usar esta
        </button>
      )}
    </section>
  );
}

function Strength({ password, inputs = [] }: { password: string; inputs?: string[] }) {
  const [score, setScore] = useState(0);

  useEffect(() => {
    invoke<number>("password_strength", { password, inputs }).then(setScore);
  }, [password, inputs.join("\n")]);

  if (!password) return null;
  return (
    <div className="strength" data-score={score}>
      <span className="bar" />
      <span className="label">{STRENGTH[score]}</span>
    </div>
  );
}

function Avatar({ title, large }: { title: string; large?: boolean }) {
  const hash = [...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
  return (
    <span className={large ? "avatar large" : "avatar"} data-color={hash % 8} aria-hidden="true">
      {title.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function IconButton({ label, className = "icon-btn", ...props }: { label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={className} aria-label={label} title={label} {...props} />;
}

function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () =>
    invoke("copy_to_clipboard", { text }).then(() => {
      setCopied(true);
      toast(`${done} · se borrará en 30 s`);
      window.setTimeout(() => setCopied(false), 1500);
    });

  return (
    <IconButton label={label} onClick={copy} disabled={!text} data-copied={copied}>
      {copied ? <Check /> : <Copy />}
    </IconButton>
  );
}

function Message({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p className={notice.error ? "notice error" : "notice success"} role={notice.error ? "alert" : "status"}>
      {notice.error ? <CircleAlert /> : <CircleCheck />}
      {notice.text}
    </p>
  );
}

function Toast() {
  const [current, setCurrent] = useState<{ text: string; visible: boolean }>({ text: "", visible: false });

  useEffect(() => {
    let timer = 0;
    const show = (e: Event) => {
      setCurrent({ text: (e as CustomEvent<string>).detail, visible: true });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCurrent((t) => ({ ...t, visible: false })), 2600);
    };
    window.addEventListener("arca-toast", show);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("arca-toast", show);
    };
  }, []);

  return (
    <div className={current.visible ? "toast show" : "toast"} role="status" aria-live="polite">
      <CircleCheck />
      {current.text}
    </div>
  );
}
