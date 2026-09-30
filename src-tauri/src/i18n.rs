use std::{
    cell::Cell,
    sync::atomic::{AtomicBool, Ordering},
};

static ENGLISH: AtomicBool = AtomicBool::new(false);
thread_local! {
    static OVERRIDE: Cell<Option<bool>> = const { Cell::new(None) };
}

pub fn set_english(english: bool) {
    ENGLISH.store(english, Ordering::Relaxed);
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// Runs `f` with a language that does not change the app-wide choice.
pub fn with_english<T>(english: bool, f: impl FnOnce() -> T) -> T {
    OVERRIDE.with(|cell| {
        let previous = cell.replace(Some(english));
        let value = f();
        cell.set(previous);
        value
    })
}

pub fn tr(es: &'static str, en: &'static str) -> String {
    let english = OVERRIDE.with(|cell| cell.get()).unwrap_or_else(|| ENGLISH.load(Ordering::Relaxed));
    if english { en } else { es }.to_string()
}
