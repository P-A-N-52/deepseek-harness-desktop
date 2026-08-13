//! Tauri host for the sealed DeepSeek Harness Web runtime.

mod runtime;

use runtime::{RuntimeEvent, RuntimeLaunch, RuntimeProcess};
use signal_hook::consts::signal::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::ffi::OsString;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WindowEvent};

const RUNNING: u8 = 0;
const STOPPING: u8 = 1;
const STOPPED: u8 = 2;
const MAIN_WINDOW: &str = "main";

#[derive(Clone, Default)]
struct NavigationPolicy {
    runtime_origin: Arc<RwLock<Option<Origin>>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Origin {
    scheme: String,
    host: String,
    port: u16,
}

impl NavigationPolicy {
    fn set_runtime(&self, url: &Url) {
        *self
            .runtime_origin
            .write()
            .expect("navigation policy lock poisoned") = Origin::from_url(url);
    }

    fn clear_runtime(&self) {
        *self
            .runtime_origin
            .write()
            .expect("navigation policy lock poisoned") = None;
    }

    fn allows(&self, url: &Url) -> bool {
        if is_bundled_page(url) {
            return true;
        }
        let accepted = self
            .runtime_origin
            .read()
            .expect("navigation policy lock poisoned");
        accepted
            .as_ref()
            .is_some_and(|origin| Origin::from_url(url).as_ref() == Some(origin))
    }
}

impl Origin {
    fn from_url(url: &Url) -> Option<Self> {
        Some(Self {
            scheme: url.scheme().to_owned(),
            host: url.host_str()?.to_owned(),
            port: url.port()?,
        })
    }
}

fn is_bundled_page(url: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

struct DesktopState {
    runtime: Mutex<Option<RuntimeProcess>>,
    lifecycle: AtomicU8,
}

impl DesktopState {
    fn new(runtime: Option<RuntimeProcess>) -> Self {
        Self {
            runtime: Mutex::new(runtime),
            lifecycle: AtomicU8::new(RUNNING),
        }
    }

    fn install_runtime(&self, runtime: RuntimeProcess) -> Result<(), RuntimeProcess> {
        let mut current = self
            .runtime
            .lock()
            .expect("desktop runtime lock poisoned");
        if self.lifecycle.load(Ordering::Acquire) != RUNNING {
            return Err(runtime);
        }
        *current = Some(runtime);
        Ok(())
    }
}

/// Build and run the Desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("failed to build DeepSeek Harness Desktop");
    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let state = handle.state::<DesktopState>();
            if state.lifecycle.load(Ordering::Acquire) != STOPPED {
                api.prevent_exit();
                begin_shutdown(handle.clone());
            }
        }
    });
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(DesktopState::new(None));
    install_termination_signals(app.handle().clone())?;

    let policy = NavigationPolicy::default();
    let navigation_policy = policy.clone();
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("DeepSeek Harness")
        .inner_size(1180.0, 780.0)
        .min_inner_size(780.0, 560.0)
        .center()
        .on_navigation(move |url| navigation_policy.allows(url))
        .build()?;

    let (events_tx, events_rx) = mpsc::channel();
    let runtime = match runtime_launch(app).and_then(|launch| {
        RuntimeProcess::spawn(launch, events_tx).map_err(|error| error.to_string())
    }) {
        Ok(runtime) => runtime,
        Err(_) => {
            navigate_to_error(&window, &policy);
            return Ok(());
        }
    };
    if let Err(runtime) = app.state::<DesktopState>().install_runtime(runtime) {
        runtime.stop();
        return Ok(());
    }

    let close_handle = app.handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            begin_shutdown(close_handle.clone());
        }
    });

    thread::spawn(move || {
        while let Ok(event) = events_rx.recv() {
            match event {
                RuntimeEvent::Ready(url) => {
                    policy.set_runtime(&url);
                    if window.navigate(url).is_err() {
                        navigate_to_error(&window, &policy);
                    }
                }
                RuntimeEvent::Unavailable => navigate_to_error(&window, &policy),
            }
        }
    });
    Ok(())
}

fn install_termination_signals(handle: AppHandle) -> std::io::Result<()> {
    let mut signals = Signals::new([SIGHUP, SIGINT, SIGTERM])?;
    thread::spawn(move || {
        for _signal in signals.forever() {
            begin_shutdown(handle.clone());
        }
    });
    Ok(())
}

fn begin_shutdown(handle: AppHandle) {
    let state = handle.state::<DesktopState>();
    if state
        .lifecycle
        .compare_exchange(RUNNING, STOPPING, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    thread::spawn(move || {
        if let Some(runtime) = handle
            .state::<DesktopState>()
            .runtime
            .lock()
            .expect("desktop runtime lock poisoned")
            .as_ref()
        {
            runtime.stop();
        }
        handle
            .state::<DesktopState>()
            .lifecycle
            .store(STOPPED, Ordering::Release);
        handle.exit(0);
    });
}

fn navigate_to_error(window: &WebviewWindow, policy: &NavigationPolicy) {
    policy.clear_runtime();
    if let Ok(url) = Url::parse("tauri://localhost/error.html") {
        let _ = window.navigate(url);
    }
}

fn runtime_launch(app: &tauri::App) -> Result<RuntimeLaunch, String> {
    let cwd = app.path().home_dir().map_err(|error| error.to_string())?;
    #[cfg(debug_assertions)]
    {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .map_err(|error| error.to_string())?;
        Ok(RuntimeLaunch {
            program: OsString::from("node"),
            args: vec![
                OsString::from("--import"),
                repository
                    .join("node_modules/tsx/dist/esm/index.mjs")
                    .into_os_string(),
                repository
                    .join("apps/cli/src/bin.ts")
                    .into_os_string(),
                OsString::from("web"),
                OsString::from("--host"),
                OsString::from("127.0.0.1"),
                OsString::from("--port"),
                OsString::from("0"),
            ],
            cwd,
            env: vec![(
                OsString::from("DSH_DESKTOP_OWN_PROCESS_GROUP"),
                OsString::from("1"),
            )],
        })
    }
    #[cfg(not(debug_assertions))]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let sidecar = executable
            .parent()
            .ok_or_else(|| "desktop executable has no parent directory".to_owned())?
            .join("dsh-desktop-runtime");
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let ripgrep = resource_dir.join("runtime/rg");
        let spawn_helper = resource_dir.join("runtime/spawn-helper");
        for path in [&sidecar, &ripgrep, &spawn_helper] {
            require_executable(path)?;
        }
        Ok(RuntimeLaunch {
            program: sidecar.into_os_string(),
            args: Vec::new(),
            cwd,
            env: vec![
                (
                    OsString::from("DSH_DESKTOP_OWN_PROCESS_GROUP"),
                    OsString::from("1"),
                ),
                (OsString::from("DSH_RIPGREP_PATH"), ripgrep.into_os_string()),
                (
                    OsString::from("DSH_NODE_PTY_SPAWN_HELPER"),
                    spawn_helper.into_os_string(),
                ),
            ],
        })
    }
}

#[cfg(not(debug_assertions))]
fn require_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = path
        .metadata()
        .map_err(|error| format!("required Desktop runtime file is unavailable: {error}"))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err("required Desktop runtime file is not executable".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_allows_only_bundled_pages_until_runtime_is_ready() {
        let policy = NavigationPolicy::default();
        assert!(policy.allows(&Url::parse("tauri://localhost/index.html").unwrap()));
        assert!(policy.allows(&Url::parse("http://tauri.localhost/error.html").unwrap()));
        assert!(!policy.allows(&Url::parse("http://127.0.0.1:43127/").unwrap()));
        assert!(!policy.allows(&Url::parse("https://example.com/").unwrap()));
    }

    #[test]
    fn ready_origin_allows_its_routes_and_rejects_every_other_origin() {
        let policy = NavigationPolicy::default();
        let ready = Url::parse("http://127.0.0.1:43127/").unwrap();
        policy.set_runtime(&ready);
        assert!(policy.allows(&Url::parse("http://127.0.0.1:43127/session/one").unwrap()));
        assert!(!policy.allows(&Url::parse("http://127.0.0.1:43128/").unwrap()));
        assert!(!policy.allows(&Url::parse("http://localhost:43127/").unwrap()));
        assert!(!policy.allows(&Url::parse("https://127.0.0.1:43127/").unwrap()));
        policy.clear_runtime();
        assert!(!policy.allows(&ready));
    }
}
