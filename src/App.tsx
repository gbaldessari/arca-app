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
  Languages,
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
import { I18nProvider, useI18n } from "./i18n";
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
const CHARSET_KEYS = ["lower", "upper", "digits", "symbols"] as const;
const THEME_OPTIONS = [
  ["system", Monitor],
  ["light", Sun],
  ["dark", Moon],
] as const;

const confirmDialog = (message: string, ok: string) => invoke<boolean>("confirm", { message, ok });
const LANG_OPTIONS = ["system", "es", "en"] as const;
const host = (url: string) => url.replace(/^\w+:\/\//, "").split(/[/?#]/)[0];
const toast = (text: string) => window.dispatchEvent(new CustomEvent("arca-toast", { detail: text }));

export default function App() {
  const [status, setStatus] = useState<Status>();

  useEffect(() => {
    const refresh = () => invoke<Status>("status").then(setStatus);
    refresh();
    const locked = listen("locked", refresh);
    const unlocked = listen("unlocked", refresh);
    const fullscreen = async (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      e.preventDefault();
      const window = getCurrentWindow();
      await window.setFullscreen(!(await window.isFullscreen()));
    };
    addEventListener("keydown", fullscreen);
    return () => {
      locked.then((stop) => stop());
      unlocked.then((stop) => stop());
      removeEventListener("keydown", fullscreen);
    };
  }, []);

  return (
    <I18nProvider>
    <LucideProvider size={16} strokeWidth={2}>
      {status === "unlocked" ? (
        <Vault onLock={() => invoke("lock")} />
      ) : (
        status && <Unlock isNew={status === "new"} onStatus={setStatus} />
      )}
      <Toast />
    </LucideProvider>
    </I18nProvider>
  );
}

function Unlock({ isNew, onStatus }: { isNew: boolean; onStatus: (status: Status) => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [hello, setHello] = useState<boolean | null>(isNew ? false : null);
  const [shaking, setShaking] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    invoke<HelloStatus>("hello_status").then((h) => {
      if (cancelled) return;
      const enabled = h.available && h.enabled;
      setHello(enabled);
      if (enabled) run(() => invoke("unlock_with_hello"));
    });
    return () => {
      cancelled = true;
    };
  }, [isNew]);

  useEffect(() => {
    if (hello === false) passwordRef.current?.focus();
  }, [hello]);

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
    if (isNew && password !== confirm) return fail(t("passwordsDontMatch"));
    run(() => invoke(isNew ? "create_vault" : "unlock", { password }));
  }

  async function restore() {
    try {
      const count = await invoke<number | null>("import_file");
      if (count === null) return;
      setNotice({
        text: t("restored", { count: count === 1 ? t("oneEntry") : t("manyEntries", { count }) }),
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
          {isNew ? t("masterCreates") : t("vaultLocked")}
        </p>
        <div className="field">
          <KeyRound className="field-icon" />
          <input
            type="password"
            aria-label={t("masterPassword")}
            placeholder={t("masterPassword")}
            ref={passwordRef}
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
                aria-label={t("repeatMaster")}
                placeholder={t("repeatPassword")}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <p className="hint">{t("forgetHint")}</p>
          </>
        )}
        <Message notice={notice} />
        {hello && (
          <button type="button" className="primary big" disabled={busy} onClick={() => run(() => invoke("unlock_with_hello"))}>
            {busy ? <LoaderCircle className="spin" /> : <FingerprintPattern />}
            {busy ? t("waitingHello") : t("unlockHello")}
          </button>
        )}
        <button className={hello ? "big" : "primary big"} disabled={busy || !password}>
          {busy && !hello ? <LoaderCircle className="spin" /> : isNew ? <ShieldCheck /> : <LockOpen />}
          {busy && !hello ? t("oneMoment") : isNew ? t("createVault") : hello ? t("useMaster") : t("unlock")}
        </button>
        {isNew && (
          <button type="button" className="link" onClick={restore}>
            <ArchiveRestore />
            {t("restoreBackup")}
          </button>
        )}
      </form>
    </div>
  );
}

function Vault({ onLock }: { onLock: () => void }) {
  const { t } = useI18n();
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
    if (dirty.current && !(await confirmDialog(t("discardChanges"), t("discard"))))
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
            aria-label={t("search")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="primary" onClick={() => leave(() => show({ ...EMPTY_ENTRY }))}>
          <Plus />
          {t("newEntry")}
        </button>
        <p className="section-label">
          {t("entries")} <span>{entries.length}</span>
        </p>
        <nav aria-label={t("entries")} className="list">
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
                <span>{e.username || t("noUsername")}</span>
              </span>
              {e.favorite && <Star className="fav" aria-label={t("favorite")} />}
            </button>
          ))}
          {!shown.length && (
            <div className="empty">
              {entries.length ? <SearchX /> : <VaultIcon />}
              <p>{entries.length ? t("noResults") : t("noEntries")}</p>
            </div>
          )}
        </nav>
        <div className="sidebar-footer">
          <button
            className="nav"
            title={t("generator")}
            aria-current={pane === "generator"}
            onClick={() => leave(() => show("generator"))}
          >
            <WandSparkles />
            <span>{t("generator")}</span>
          </button>
          <button
            className="nav"
            title={t("settings")}
            aria-current={pane === "settings"}
            onClick={() => leave(() => show("settings"))}
          >
            <SettingsIcon />
            <span>{t("settings")}</span>
          </button>
          <button className="nav" title={t("lock")} onClick={() => leave(onLock)}>
            <Lock />
            <span>{t("lock")}</span>
          </button>
        </div>
      </aside>
      <main>
        <button className="link back" onClick={() => setView("list")}>
          <ArrowLeft />
          {t("backToEntries")}
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
              <h2>{t("passwordGenerator")}</h2>
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
  const { t } = useI18n();
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
      toast(t("savedEntry"));
      onSaved(id);
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove() {
    if (!(await confirmDialog(t("deleteConfirm", { title: form.title }), t("delete")))) return;
    try {
      await invoke("delete_entry", { id: form.id });
      dirty.current = false;
      toast(t("deletedEntry"));
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
          <h2>{form.title || t("newEntry")}</h2>
          <p className="muted">{host(form.url) || t("noWebsite")}</p>
        </div>
        <IconButton
          label={t("favorite")}
          className="icon-btn star-btn"
          aria-pressed={form.favorite}
          onClick={() => update({ favorite: !form.favorite })}
        >
          <Star size={20} />
        </IconButton>
      </header>

      <label htmlFor="title">{t("title")}</label>
      <div className="field">
        <input required autoFocus={form.id === null} {...field("title")} />
      </div>

      <label htmlFor="username">{t("username")}</label>
      <div className="field">
        <User className="field-icon" />
        <input {...field("username")} />
        <CopyButton text={form.username} label={t("copyUsername")} done={t("usernameCopied")} />
      </div>

      <label htmlFor="password">{t("password")}</label>
      <div className="field">
        <KeyRound className="field-icon" />
        <input type={showPassword ? "text" : "password"} className="mono" {...field("password")} />
        <IconButton
          label={showPassword ? t("hidePassword") : t("showPassword")}
          onClick={() => setShowPassword(!showPassword)}
        >
          {showPassword ? <EyeOff /> : <Eye />}
        </IconButton>
        <CopyButton text={form.password} label={t("copyPassword")} done={t("passwordCopied")} />
        <IconButton
          label={t("generatePassword")}
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

      <label htmlFor="url">{t("website")}</label>
      <div className="field">
        <Globe className="field-icon" />
        <input placeholder="https://" {...field("url")} />
      </div>

      <label htmlFor="notes">{t("notes")}</label>
      <div className="field">
        <textarea rows={3} {...field("notes")} />
      </div>

      <Message notice={error ? { text: error, error: true } : null} />
      <div className="actions">
        {form.id !== null && (
          <button type="button" className="danger" onClick={remove}>
            <Trash />
            {t("delete")}
          </button>
        )}
        <button type="submit" className="primary">
          {saved ? <Check /> : <Save />}
          {saved ? t("saved") : t("save")}
        </button>
      </div>
    </form>
  );
}

function Settings({ onImported }: { onImported: () => void }) {
  const { t } = useI18n();
  return (
    <div className="settings">
      <h2>{t("settings")}</h2>
      <Appearance />
      <ChangePassword />
      <HelloSettings />
      <BrowserIntegration />
      <Backups onImported={onImported} />
    </div>
  );
}

function Appearance() {
  const { t, pref, setPref } = useI18n();
  const [theme, setTheme] = useState<ThemePref>(savedTheme);
  const themeLabel = { system: t("system"), light: t("light"), dark: t("dark") };
  const langLabel = { system: t("system"), es: "Español", en: "English" };

  const choose = (next: ThemePref) => {
    setTheme(next);
    applyTheme(next);
  };

  return (
    <section className="panel">
      <h3>
        <Palette />
        {t("appearance")}
      </h3>
      <div className="segmented" role="radiogroup" aria-label={t("theme")}>
        {THEME_OPTIONS.map(([value, Icon]) => (
          <label key={value} className="segment">
            <input type="radio" name="theme" checked={theme === value} onChange={() => choose(value)} />
            <Icon />
            {themeLabel[value]}
          </label>
        ))}
      </div>
      <p className="muted">{t("themeHint")}</p>
      <h3>
        <Languages />
        {t("language")}
      </h3>
      <div className="segmented" role="radiogroup" aria-label={t("language")}>
        {LANG_OPTIONS.map((value) => (
          <label key={value} className="segment">
            <input type="radio" name="language" checked={pref === value} onChange={() => setPref(value)} />
            {langLabel[value]}
          </label>
        ))}
      </div>
      <p className="muted">{t("languageHint")}</p>
    </section>
  );
}

function BrowserIntegration() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean>();
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    invoke<boolean>("browser_integration").then(setEnabled);
  }, []);

  async function toggle(next: boolean) {
    try {
      await invoke("set_browser_integration", { enabled: next });
      setEnabled(next);
      setNotice(next ? { text: t("integrationReady") } : null);
    } catch (err) {
      setNotice({ text: String(err), error: true });
    }
  }

  if (enabled === undefined) return null;
  return (
    <section className="panel">
      <h3>
        <Puzzle />
        {t("browserIntegration")}
      </h3>
      <label className="switch">
        <input type="checkbox" role="switch" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        {t("allowExtension")}
      </label>
      <p className="muted">
        {t("integrationHint")}
      </p>
      <Message notice={notice} />
    </section>
  );
}

function ChangePassword() {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) return setNotice({ text: t("newPasswordsDontMatch"), error: true });
    setBusy(true);
    try {
      await invoke("change_master_password", { current, newPassword: next });
      setCurrent("");
      setNext("");
      setRepeat("");
      setNotice({ text: t("masterUpdated") });
    } catch (err) {
      setNotice({ text: String(err), error: true });
    }
    setBusy(false);
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h3>
        <KeyRound />
        {t("masterPassword")}
      </h3>
      <div className="field">
        <input
          type="password"
          aria-label={t("currentPassword")}
          placeholder={t("currentPassword")}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="field">
        <input
          type="password"
          aria-label={t("newMaster")}
          placeholder={t("newPassword")}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </div>
      <Strength password={next} />
      <div className="field">
        <input
          type="password"
          aria-label={t("repeatNewMaster")}
          placeholder={t("repeatNew")}
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </div>
      <Message notice={notice} />
      <button className="primary" disabled={busy || !current || !next}>
        {busy && <LoaderCircle className="spin" />}
        {busy ? t("oneMoment") : t("changePassword")}
      </button>
    </form>
  );
}

function HelloSettings() {
  const { t } = useI18n();
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
      setNotice({ text: hello?.enabled ? t("helloOff") : t("helloOn") });
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
        <p className="muted">{t("helloUnavailable")}</p>
      ) : (
        <>
          <p className="muted">
            {hello.enabled ? t("helloEnabledHint") : t("helloDisabledHint")}
          </p>
          {!hello.enabled && (
            <div className="field">
              <input
                type="password"
                aria-label={t("masterPassword")}
                placeholder={t("masterPassword")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          <Message notice={notice} />
          <button className={hello.enabled ? undefined : "primary"} disabled={busy || (!hello.enabled && !password)}>
            {busy ? <LoaderCircle className="spin" /> : <FingerprintPattern />}
            {busy ? t("waitingHello") : hello.enabled ? t("disable") : t("enable")}
          </button>
        </>
      )}
    </form>
  );
}

function Backups({ onImported }: { onImported: () => void }) {
  const { t } = useI18n();
  const [notice, setNotice] = useState<Notice>(null);
  const fail = (err: unknown) => setNotice({ text: String(err), error: true });

  const exportBackup = () =>
    invoke<boolean>("export_backup").then((saved) => {
      if (saved) setNotice({ text: t("backupSaved") });
    }, fail);

  const importFile = () =>
    invoke<number | null>("import_file").then((count) => {
      if (count === null) return;
      setNotice({
        text: count ? t("imported", { count: count === 1 ? t("oneEntry") : t("manyEntries", { count }) }) : t("nothingNew"),
      });
      onImported();
    }, fail);

  return (
    <section className="panel">
      <h3>
        <DatabaseBackup />
        {t("backups")}
      </h3>
      <p className="muted">
        {t("backupsHint")}
      </p>
      <div className="row">
        <button onClick={exportBackup}>
          <Download />
          {t("exportBackup")}
        </button>
        <button onClick={importFile}>
          <Upload />
          {t("importBackup")}
        </button>
      </div>
      <Message notice={notice} />
    </section>
  );
}

function Generator({ onUse }: { onUse?: (password: string) => void }) {
  const { t } = useI18n();
  const charsets = [
    ["lower", t("lowercase")],
    ["upper", t("uppercase")],
    ["digits", t("digits")],
    ["symbols", t("symbols")],
  ] as const;
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

  const enabledSets = CHARSET_KEYS.filter((key) => options[key]).length;

  return (
    <section className="panel generator" aria-label={t("passwordGenerator")}>
      <div className="generated">
        <output key={password} className="mono">
          {password}
        </output>
        <IconButton label={t("regenerate")} className="icon-btn regenerate" onClick={() => setOptions({ ...options })}>
          <RefreshCw />
        </IconButton>
        <CopyButton text={password} label={t("copyGenerated")} done={t("passwordCopied")} />
      </div>
      <Strength password={password} />
      <label className="slider">
        <span>{t("length")}</span>
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
        {charsets.map(([key, label]) => (
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
          {t("useThis")}
        </button>
      )}
    </section>
  );
}

function Strength({ password, inputs = [] }: { password: string; inputs?: string[] }) {
  const { t } = useI18n();
  const strength = [t("veryWeak"), t("weak"), t("fair"), t("good"), t("veryStrong")];
  const [score, setScore] = useState(0);

  useEffect(() => {
    invoke<number>("password_strength", { password, inputs }).then(setScore);
  }, [password, inputs.join("\n")]);

  if (!password) return null;
  return (
    <div className="strength" data-score={score}>
      <span className="bar" />
      <span className="label">{strength[score]}</span>
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
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = () =>
    invoke("copy_to_clipboard", { text }).then(() => {
      setCopied(true);
      toast(t("copiedClear", { text: done }));
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
