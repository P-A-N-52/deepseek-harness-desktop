//! Sealed Web-sidecar process ownership for the Desktop shell.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Url;

const READY_PREFIX: &str = "dsh web: ";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(6);
const FORCE_KILL_WAIT: Duration = Duration::from_secs(2);

/// A child launch vector with an explicit working directory and environment.
pub(crate) struct RuntimeLaunch {
    pub(crate) program: OsString,
    pub(crate) args: Vec<OsString>,
    pub(crate) cwd: PathBuf,
    pub(crate) env: Vec<(OsString, OsString)>,
}

/// Product-safe runtime state changes; raw sidecar output never crosses here.
#[derive(Debug)]
pub(crate) enum RuntimeEvent {
    Ready(Url),
    Unavailable,
}

#[derive(Clone, Copy)]
struct RuntimeTiming {
    startup: Duration,
    shutdown_grace: Duration,
    force_kill_wait: Duration,
}

impl Default for RuntimeTiming {
    fn default() -> Self {
        Self {
            startup: STARTUP_TIMEOUT,
            shutdown_grace: SHUTDOWN_GRACE,
            force_kill_wait: FORCE_KILL_WAIT,
        }
    }
}

struct ExitState {
    status: Mutex<Option<ExitStatus>>,
    changed: Condvar,
}

/// Handle for one process group whose child is reaped by a monitor thread.
pub(crate) struct RuntimeProcess {
    pid: u32,
    stopping: Arc<AtomicBool>,
    exit: Arc<ExitState>,
    timing: RuntimeTiming,
}

impl RuntimeProcess {
    /// Spawn the sidecar in a fresh process group and begin readiness supervision.
    pub(crate) fn spawn(
        launch: RuntimeLaunch,
        events: mpsc::Sender<RuntimeEvent>,
    ) -> std::io::Result<Self> {
        Self::spawn_with_timing(launch, events, RuntimeTiming::default())
    }

    fn spawn_with_timing(
        launch: RuntimeLaunch,
        events: mpsc::Sender<RuntimeEvent>,
        timing: RuntimeTiming,
    ) -> std::io::Result<Self> {
        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .current_dir(&launch.cwd)
            .envs(launch.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_process_group(&mut command);
        let mut child = command.spawn()?;
        let pid = child.id();
        let stdout = child
            .stdout
            .take()
            .expect("piped sidecar stdout must be available");
        let stopping = Arc::new(AtomicBool::new(false));
        let exit = Arc::new(ExitState {
            status: Mutex::new(None),
            changed: Condvar::new(),
        });
        let monitor_stopping = Arc::clone(&stopping);
        let monitor_exit = Arc::clone(&exit);
        thread::spawn(move || {
            monitor_child(
                &mut child,
                stdout,
                pid,
                timing,
                &monitor_stopping,
                &monitor_exit,
                events,
            );
        });
        Ok(Self {
            pid,
            stopping,
            exit,
            timing,
        })
    }

    /// Request graceful shutdown once, then force only the owned tree after the deadline.
    pub(crate) fn stop(&self) {
        let first_request = !self.stopping.swap(true, Ordering::AcqRel);
        if self.has_exited() {
            return;
        }
        if first_request {
            signal_process_group(self.pid, libc::SIGTERM);
        }
        if self.wait_for_exit(self.timing.shutdown_grace) {
            return;
        }
        force_kill_tree(self.pid);
        let _ = self.wait_for_exit(self.timing.force_kill_wait);
    }

    fn has_exited(&self) -> bool {
        self.exit
            .status
            .lock()
            .expect("runtime exit lock poisoned")
            .is_some()
    }

    fn wait_for_exit(&self, timeout: Duration) -> bool {
        let status = self.exit.status.lock().expect("runtime exit lock poisoned");
        if status.is_some() {
            return true;
        }
        let (status, _) = self
            .exit
            .changed
            .wait_timeout_while(status, timeout, |value| value.is_none())
            .expect("runtime exit wait poisoned");
        status.is_some()
    }
}

fn monitor_child(
    child: &mut Child,
    stdout: impl std::io::Read + Send + 'static,
    pid: u32,
    timing: RuntimeTiming,
    stopping: &AtomicBool,
    exit: &ExitState,
    events: mpsc::Sender<RuntimeEvent>,
) {
    let (lines_tx, lines_rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if lines_tx.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + timing.startup;
    let mut ready = false;
    let mut failed = false;
    loop {
        if let Some(status) = child.try_wait().unwrap_or(None) {
            if !stopping.load(Ordering::Acquire) && !failed {
                let _ = events.send(RuntimeEvent::Unavailable);
            }
            publish_exit(exit, status);
            return;
        }

        if !ready && Instant::now() >= deadline {
            failed = true;
            let _ = events.send(RuntimeEvent::Unavailable);
            signal_process_group(pid, libc::SIGTERM);
        }

        match lines_rx.recv_timeout(Duration::from_millis(25)) {
            Ok(Ok(line)) => match parse_ready_line(&line) {
                None => {}
                Some(Ok(url)) if !ready && !failed => {
                    ready = true;
                    let _ = events.send(RuntimeEvent::Ready(url));
                }
                Some(_) => {
                    if !failed {
                        failed = true;
                        let _ = events.send(RuntimeEvent::Unavailable);
                    }
                    signal_process_group(pid, libc::SIGTERM);
                }
            },
            Ok(Err(_)) => {
                if !failed {
                    failed = true;
                    let _ = events.send(RuntimeEvent::Unavailable);
                }
                signal_process_group(pid, libc::SIGTERM);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }

        if failed && !stopping.load(Ordering::Acquire) {
            let failure_deadline = Instant::now() + timing.shutdown_grace;
            while Instant::now() < failure_deadline {
                if let Ok(Some(status)) = child.try_wait() {
                    publish_exit(exit, status);
                    return;
                }
                thread::sleep(Duration::from_millis(25));
            }
            force_kill_tree(pid);
        }
    }
}

fn publish_exit(exit: &ExitState, status: ExitStatus) {
    *exit.status.lock().expect("runtime exit lock poisoned") = Some(status);
    exit.changed.notify_all();
}

/// Parse only the CLI's exact loopback ready record; unrelated stdout is ignored.
pub(crate) fn parse_ready_line(line: &str) -> Option<Result<Url, ()>> {
    let raw = line.strip_prefix(READY_PREFIX)?;
    let parsed = match Url::parse(raw) {
        Ok(url) => url,
        Err(_) => return Some(Err(())),
    };
    let valid = parsed.scheme() == "http"
        && parsed.host_str() == Some("127.0.0.1")
        && parsed.port().is_some_and(|port| port > 0)
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.path() == "/"
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    Some(if valid { Ok(parsed) } else { Err(()) })
}

fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

fn signal_process_group(pid: u32, signal: libc::c_int) {
    let Ok(group) = libc::pid_t::try_from(pid) else {
        return;
    };
    // SAFETY: `kill` is called with a process-group id created for this child;
    // ESRCH is an ordinary race with the monitor reaping an exited process.
    unsafe {
        libc::kill(-group, signal);
    }
}

fn force_kill_tree(root: u32) {
    for pid in descendant_pids(root).into_iter().rev() {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            continue;
        };
        // SAFETY: every pid came from a fresh parent-chain snapshot rooted at
        // the owned sidecar; failure is an ordinary exit/PID race.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
    signal_process_group(root, libc::SIGKILL);
}

fn descendant_pids(root: u32) -> Vec<u32> {
    let Ok(output) = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(parent), None) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let (Ok(pid), Ok(parent)) = (pid.parse::<u32>(), parent.parse::<u32>()) else {
            continue;
        };
        children.entry(parent).or_default().push(pid);
    }
    let mut result = Vec::new();
    let mut seen = HashSet::from([root]);
    let mut pending = vec![root];
    while let Some(parent) = pending.pop() {
        for &child in children.get(&parent).into_iter().flatten() {
            if seen.insert(child) {
                result.push(child);
                pending.push(child);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn shell_launch(script: &str) -> RuntimeLaunch {
        RuntimeLaunch {
            program: OsString::from("/bin/sh"),
            args: vec![OsString::from("-c"), OsString::from(script)],
            cwd: Path::new("/").to_path_buf(),
            env: Vec::new(),
        }
    }

    fn test_timing() -> RuntimeTiming {
        RuntimeTiming {
            startup: Duration::from_millis(150),
            shutdown_grace: Duration::from_millis(150),
            force_kill_wait: Duration::from_secs(1),
        }
    }

    #[test]
    fn accepts_only_exact_ipv4_loopback_ready_url() {
        let valid = parse_ready_line("dsh web: http://127.0.0.1:43127")
            .expect("ready record")
            .expect("valid URL");
        assert_eq!(valid.as_str(), "http://127.0.0.1:43127/");

        for line in [
            "dsh web: http://localhost:43127",
            "dsh web: http://0.0.0.0:43127",
            "dsh web: http://[::1]:43127",
            "dsh web: https://127.0.0.1:43127",
            "dsh web: http://user@127.0.0.1:43127",
            "dsh web: http://127.0.0.1:43127/path",
            "dsh web: http://127.0.0.1:43127/?query=1",
            "dsh web: http://127.0.0.1:43127/#fragment",
            "dsh web: http://127.0.0.1",
            "dsh web: not-a-url",
        ] {
            assert!(matches!(parse_ready_line(line), Some(Err(()))), "{line}");
        }
        assert!(parse_ready_line("ordinary log output").is_none());
    }

    #[test]
    fn graceful_stop_is_idempotent_and_reaps_the_child() {
        let (events_tx, events_rx) = mpsc::channel();
        let process = RuntimeProcess::spawn_with_timing(
            shell_launch("trap 'exit 0' TERM; printf 'dsh web: http://127.0.0.1:43210\\n'; while :; do sleep 1; done"),
            events_tx,
            test_timing(),
        )
        .expect("spawn fixture");
        assert!(matches!(
            events_rx.recv_timeout(Duration::from_secs(1)),
            Ok(RuntimeEvent::Ready(_))
        ));
        process.stop();
        process.stop();
        assert!(process.has_exited());
    }

    #[test]
    fn startup_timeout_reports_unavailable_and_terminates() {
        let (events_tx, events_rx) = mpsc::channel();
        let process = RuntimeProcess::spawn_with_timing(
            shell_launch("trap 'exit 0' TERM; while :; do sleep 1; done"),
            events_tx,
            test_timing(),
        )
        .expect("spawn fixture");
        assert!(matches!(
            events_rx.recv_timeout(Duration::from_secs(1)),
            Ok(RuntimeEvent::Unavailable)
        ));
        assert!(process.wait_for_exit(Duration::from_secs(1)));
    }

    #[test]
    fn duplicate_ready_record_invalidates_the_runtime() {
        let (events_tx, events_rx) = mpsc::channel();
        let process = RuntimeProcess::spawn_with_timing(
            shell_launch("trap 'exit 0' TERM; printf 'dsh web: http://127.0.0.1:43210\\ndsh web: http://127.0.0.1:43210\\n'; while :; do sleep 1; done"),
            events_tx,
            test_timing(),
        )
        .expect("spawn fixture");
        assert!(matches!(
            events_rx.recv_timeout(Duration::from_secs(1)),
            Ok(RuntimeEvent::Ready(_))
        ));
        assert!(matches!(
            events_rx.recv_timeout(Duration::from_secs(1)),
            Ok(RuntimeEvent::Unavailable)
        ));
        assert!(process.wait_for_exit(Duration::from_secs(1)));
    }
}
