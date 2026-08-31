// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsStr,
    fs,
    io::{self, Read, Write},
    os::unix::fs::FileTypeExt,
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Component, Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

const COMMANDS: &[&str] = &[
    "help",
    "h",
    "version",
    "tools",
    "skill",
    "status",
    "open",
    "tabs",
    "tab-groups",
    "tab_groups",
    "history",
    "bookmarks",
    "navigate",
    "snapshot",
    "diff",
    "act",
    "download",
    "upload",
    "read",
    "grep",
    "list-console-messages",
    "list_console_messages",
    "clear-console-messages",
    "clear_console_messages",
    "list-network-requests",
    "list_network_requests",
    "get-network-request",
    "get_network_request",
    "enable-debugger",
    "enable_debugger",
    "list-scripts",
    "list_scripts",
    "get-script-source",
    "get_script_source",
    "set-logpoint",
    "set_logpoint",
    "remove-logpoint",
    "remove_logpoint",
    "get-logpoint-results",
    "get_logpoint_results",
    "screenshot",
    "pdf",
    "wait",
    "windows",
    "evaluate",
    "gecko-render",
    "gecko_render",
    "torrent-list",
    "torrent_list",
    "torrent-details",
    "torrent_details",
    "torrent-control",
    "torrent_control",
    "run",
    "devtools",
    "console",
    "network",
    "request",
    "debugger",
    "scripts",
    "script-source",
    "script_source",
    "logpoint-set",
    "logpoint_set",
    "logpoint-remove",
    "logpoint_remove",
    "logpoint-results",
    "logpoint_results",
    "render",
    "back",
    "forward",
    "reload",
    "click",
    "click-at",
    "click_at",
    "type",
    "type-at",
    "type_at",
    "fill",
    "press",
    "hover",
    "hover-at",
    "hover_at",
    "focus",
    "check",
    "uncheck",
    "select",
    "scroll",
    "drag",
    "drag-at",
    "drag_at",
    "dialog-accept",
    "dialog_accept",
    "dialog-dismiss",
    "dialog_dismiss",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    version: u8,
    argv: Vec<String>,
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    exit_code: u8,
    stdout: String,
    stderr: String,
}

fn command_name(arguments: &[String]) -> Option<&str> {
    let mut expect_value = false;
    for argument in arguments {
        if expect_value {
            expect_value = false;
            continue;
        }
        match argument.as_str() {
            "--json" | "--no-start" => continue,
            "--cwd" | "--session" | "--input" => {
                expect_value = true;
                continue;
            }
            value
                if value.starts_with("--cwd=")
                    || value.starts_with("--session=")
                    || value.starts_with("--input=") =>
            {
                continue;
            }
            value if value.starts_with("--") => return None,
            value => return Some(value),
        }
    }
    None
}

fn is_control_command(arguments: &[String]) -> bool {
    command_name(arguments).is_some_and(|value| COMMANDS.contains(&value))
}

fn browser_binary() -> PathBuf {
    env::var_os("WILDBUZZARD_BROWSER_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/opt/wildbuzzard/wildbuzzard"))
}

enum SocketTarget {
    Explicit(PathBuf),
    Discover(PathBuf),
}

impl SocketTarget {
    fn display_path(&self) -> &Path {
        match self {
            Self::Explicit(path) | Self::Discover(path) => path,
        }
    }
}

fn is_normalized_absolute_path(path: &Path) -> bool {
    let normalized = path.components().collect::<PathBuf>();
    path.is_absolute()
        && path.as_os_str() == normalized.as_os_str()
        && path
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
}

fn socket_directory() -> Result<PathBuf, String> {
    if let Some(runtime) = env::var_os("XDG_RUNTIME_DIR") {
        let runtime = PathBuf::from(runtime);
        if is_normalized_absolute_path(&runtime) {
            return Ok(runtime.join("wildbuzzard/profiles"));
        }
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| is_normalized_absolute_path(path))
        .ok_or_else(|| "HOME must be a normalized absolute path".to_string())?;
    let state = env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|path| is_normalized_absolute_path(path))
        .unwrap_or_else(|| home.join(".local/state"));
    Ok(state.join("wildbuzzard/run/profiles"))
}

fn socket_target() -> Result<SocketTarget, String> {
    if let Some(path) = env::var_os("WILDBUZZARD_CONTROL_SOCKET").filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(path);
        let valid = is_normalized_absolute_path(&path)
            && path.file_name().is_some()
            && path
                .to_str()
                .is_some_and(|value| !value.chars().any(char::is_control));
        return valid
            .then_some(SocketTarget::Explicit(path))
            .ok_or_else(|| {
                "WILDBUZZARD_CONTROL_SOCKET must be a normalized absolute path".to_string()
            });
    }
    Ok(SocketTarget::Discover(socket_directory()?))
}

fn is_discoverable_socket_name(name: &str) -> bool {
    let Some(value) = name
        .strip_prefix("control-")
        .and_then(|value| value.strip_suffix(".sock"))
    else {
        return false;
    };
    let Some((profile, instance)) = value.split_once('-') else {
        return false;
    };
    profile.len() == 24
        && profile
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && instance.len() == 12
        && instance
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn no_start(arguments: &[String]) -> bool {
    arguments.iter().any(|value| value == "--no-start")
        || env::var_os("WILDBUZZARD_NO_START").is_some_and(|value| value != OsStr::new("0"))
}

fn wants_json(arguments: &[String]) -> bool {
    arguments.iter().any(|value| value == "--json")
}

fn input_from_stdin(arguments: &[String]) -> Result<Option<String>, String> {
    let requested = arguments
        .windows(2)
        .any(|values| values[0] == "--input" && values[1] == "-")
        || arguments.iter().any(|value| value == "--input=-");
    if !requested {
        return Ok(None);
    }
    let mut source = String::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_string(&mut source)
        .map_err(|error| format!("could not read stdin: {error}"))?;
    if source.len() > MAX_REQUEST_BYTES {
        return Err("stdin exceeds the Wild Buzzard request limit".to_string());
    }
    Ok(Some(source))
}

fn launch_browser() -> Result<(), String> {
    Command::new(browser_binary())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not launch Wild Buzzard: {error}"))
}

fn discovered_socket_paths(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "could not inspect Wild Buzzard control directory {}: {error}",
                directory.display()
            ));
        }
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let path = entry.path();
            let is_socket = fs::symlink_metadata(&path)
                .ok()
                .is_some_and(|metadata| metadata.file_type().is_socket());
            (is_discoverable_socket_name(name) && is_socket).then_some(path)
        })
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn connect_existing(target: &SocketTarget) -> Result<Option<(PathBuf, UnixStream)>, String> {
    match target {
        SocketTarget::Explicit(path) => Ok(UnixStream::connect(path)
            .ok()
            .map(|stream| (path.clone(), stream))),
        SocketTarget::Discover(directory) => {
            let mut connections = discovered_socket_paths(directory)?
                .into_iter()
                .filter_map(|path| UnixStream::connect(&path).ok().map(|stream| (path, stream)))
                .collect::<Vec<_>>();
            match connections.len() {
                0 => Ok(None),
                1 => Ok(connections.pop()),
                _ => Err(format!(
                    "multiple Wild Buzzard profiles are running; set WILDBUZZARD_CONTROL_SOCKET to one of: {}",
                    connections
                        .iter()
                        .map(|(path, _)| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )),
            }
        }
    }
}

fn connect(target: &SocketTarget, start: bool) -> Result<(PathBuf, UnixStream), String> {
    if let Some(connection) = connect_existing(target)? {
        return Ok(connection);
    }
    if !start {
        return Err("Wild Buzzard is not running".to_string());
    }
    launch_browser()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last_error = None;
    while Instant::now() < deadline {
        match connect_existing(target) {
            Ok(Some(connection)) => return Ok(connection),
            Ok(None) => {}
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "Wild Buzzard did not expose native control at {}: {}",
        target.display_path().display(),
        last_error.unwrap_or_else(|| "timed out".to_string())
    ))
}

fn call(arguments: Vec<String>) -> Result<Response, String> {
    let target = socket_target()?;
    let start = !no_start(&arguments);
    let existing = connect_existing(&target)?;
    if command_name(&arguments) == Some("status") && existing.is_none() && !start {
        let value = serde_json::json!({
            "running": false,
            "socketPath": target.display_path(),
            "transport": "unix",
            "runtime": "gecko",
        });
        return Ok(Response {
            exit_code: 0,
            stdout: if wants_json(&arguments) {
                format!("{value}\n")
            } else {
                format!("{}\n", serde_json::to_string_pretty(&value).unwrap())
            },
            stderr: String::new(),
        });
    }
    let request = Request {
        version: 1,
        argv: arguments.clone(),
        cwd: env::current_dir()
            .map_err(|error| format!("could not resolve the working directory: {error}"))?
            .to_string_lossy()
            .into_owned(),
        stdin: input_from_stdin(&arguments)?,
    };
    let mut source = serde_json::to_vec(&request)
        .map_err(|error| format!("could not encode the command: {error}"))?;
    source.push(b'\n');
    if source.len() > MAX_REQUEST_BYTES {
        return Err("Wild Buzzard command request is too large".to_string());
    }
    let (_path, mut stream) = match existing {
        Some(connection) => connection,
        None => connect(&target, start)?,
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(65)))
        .map_err(|error| format!("could not configure Wild Buzzard control: {error}"))?;
    stream
        .write_all(&source)
        .map_err(|error| format!("could not send the Wild Buzzard command: {error}"))?;
    let mut response = String::new();
    stream
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_string(&mut response)
        .map_err(|error| format!("could not read the Wild Buzzard response: {error}"))?;
    if response.len() > MAX_RESPONSE_BYTES {
        return Err("Wild Buzzard response exceeded its limit".to_string());
    }
    serde_json::from_str(response.trim_end())
        .map_err(|error| format!("invalid response from Wild Buzzard: {error}"))
}

fn run() -> Result<ExitCode, String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if !is_control_command(&arguments) {
        let error = Command::new(browser_binary()).args(arguments).exec();
        return Err(format!("could not launch Wild Buzzard: {error}"));
    }
    let response = call(arguments)?;
    print!("{}", response.stdout);
    eprint!("{}", response.stderr);
    Ok(ExitCode::from(response.exit_code))
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("wildbuzzard: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::net::UnixListener,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn socket_test_directory(_label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = Path::new("/tmp").join(format!("wb-{}-{nonce:x}", std::process::id()));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn recognizes_native_commands_and_browser_launches() {
        assert!(is_control_command(&["snapshot".into()]));
        assert!(is_control_command(&[
            "--session".into(),
            "client".into(),
            "devtools".into(),
        ]));
        assert!(is_control_command(&["torrent-control".into()]));
        assert!(is_control_command(&["click-at".into()]));
        assert!(!is_control_command(&["--new-window".into()]));
        assert!(!is_control_command(&["https://example.com".into()]));
    }

    #[test]
    fn fallback_socket_is_private_product_state() {
        unsafe {
            env::remove_var("WILDBUZZARD_CONTROL_SOCKET");
            env::remove_var("XDG_RUNTIME_DIR");
            env::remove_var("XDG_STATE_HOME");
            env::set_var("HOME", "/tmp/wildbuzzard-home");
        }
        assert_eq!(
            socket_directory().unwrap(),
            PathBuf::from("/tmp/wildbuzzard-home/.local/state/wildbuzzard/run/profiles")
        );
    }

    #[test]
    fn explicit_socket_path_rejects_ambiguous_paths() {
        for path in [
            Path::new("relative.sock"),
            Path::new("/tmp/../tmp/control.sock"),
            Path::new("/tmp//control.sock"),
            Path::new("/tmp/control.sock/"),
        ] {
            assert!(!is_normalized_absolute_path(path));
        }
        assert!(is_normalized_absolute_path(Path::new(
            "/tmp/wildbuzzard/control.sock"
        )));
    }

    #[test]
    fn discovery_names_match_browser_generated_names() {
        assert!(is_discoverable_socket_name(
            "control-0123456789abcdef01234567-AbCdEf_123-4.sock"
        ));
        assert!(!is_discoverable_socket_name("control.sock"));
        assert!(!is_discoverable_socket_name("control-agent.sock"));
        assert!(!is_discoverable_socket_name(
            "control-0123456789ABCDEF01234567-AbCdEf_123-4.sock"
        ));
    }

    #[test]
    fn discovers_the_only_live_profile_socket() {
        let directory = socket_test_directory("single");
        let live_path = directory.join("control-000000000000000000000000-AAAAAAAAAAAA.sock");
        let stale_path = directory.join("control-000000000000000000000000-BBBBBBBBBBBB.sock");
        let listener = UnixListener::bind(&live_path).unwrap();
        fs::write(&stale_path, b"stale").unwrap();

        let target = SocketTarget::Discover(directory.clone());
        let (path, stream) = connect_existing(&target).unwrap().unwrap();
        assert_eq!(path, live_path);

        drop(stream);
        drop(listener);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn requires_selection_when_multiple_profiles_are_live() {
        let directory = socket_test_directory("multiple");
        let first_path = directory.join("control-000000000000000000000000-AAAAAAAAAAAA.sock");
        let second_path = directory.join("control-111111111111111111111111-BBBBBBBBBBBB.sock");
        let first = UnixListener::bind(&first_path).unwrap();
        let second = UnixListener::bind(&second_path).unwrap();

        let error = connect_existing(&SocketTarget::Discover(directory.clone()))
            .err()
            .unwrap();
        assert!(error.contains("multiple Wild Buzzard profiles"));
        assert!(error.contains(first_path.to_str().unwrap()));
        assert!(error.contains(second_path.to_str().unwrap()));

        drop(first);
        drop(second);
        fs::remove_dir_all(directory).unwrap();
    }
}
