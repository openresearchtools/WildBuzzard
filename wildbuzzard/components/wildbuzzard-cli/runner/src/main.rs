// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsStr,
    io::{self, Read, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
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
    "native-search",
    "native_search",
    "gecko-render",
    "gecko_render",
    "torrent-list",
    "torrent_list",
    "torrent-details",
    "torrent_details",
    "torrent-control",
    "torrent_control",
    "torrent-providers",
    "torrent_providers",
    "torrent-search",
    "torrent_search",
    "torrent-prepare",
    "torrent_prepare",
    "torrent-draft",
    "torrent_draft",
    "torrent-commit",
    "torrent_commit",
    "torrent-cancel",
    "torrent_cancel",
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
    "search",
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

fn socket_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("WILDBUZZARD_CONTROL_SOCKET") {
        let path = PathBuf::from(path);
        return path
            .is_absolute()
            .then_some(path)
            .ok_or_else(|| "WILDBUZZARD_CONTROL_SOCKET must be absolute".to_string());
    }
    if let Some(runtime) = env::var_os("XDG_RUNTIME_DIR") {
        let runtime = PathBuf::from(runtime);
        if runtime.is_absolute() {
            return Ok(runtime.join("wildbuzzard/control.sock"));
        }
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "HOME must be an absolute path".to_string())?;
    let data = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".local/share"));
    Ok(data.join("wildbuzzard/run/control.sock"))
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

fn connect(path: &Path, start: bool) -> Result<UnixStream, String> {
    if let Ok(stream) = UnixStream::connect(path) {
        return Ok(stream);
    }
    if !start {
        return Err("Wild Buzzard is not running".to_string());
    }
    launch_browser()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last_error = None;
    while Instant::now() < deadline {
        match UnixStream::connect(path) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "Wild Buzzard did not expose native control at {}: {}",
        path.display(),
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "timed out".to_string())
    ))
}

fn call(arguments: Vec<String>) -> Result<Response, String> {
    let path = socket_path()?;
    if command_name(&arguments) == Some("status") && !path.exists() && no_start(&arguments) {
        let value = serde_json::json!({
            "running": false,
            "socketPath": path,
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
    let mut stream = connect(&path, !no_start(&arguments))?;
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

    #[test]
    fn recognizes_native_commands_and_browser_launches() {
        assert!(is_control_command(&["snapshot".into()]));
        assert!(is_control_command(&[
            "--session".into(),
            "agent".into(),
            "devtools".into(),
        ]));
        assert!(is_control_command(&["torrent-search".into()]));
        assert!(is_control_command(&["click-at".into()]));
        assert!(!is_control_command(&["--new-window".into()]));
        assert!(!is_control_command(&["https://example.com".into()]));
    }

    #[test]
    fn fallback_socket_is_private_product_state() {
        unsafe {
            env::remove_var("WILDBUZZARD_CONTROL_SOCKET");
            env::remove_var("XDG_RUNTIME_DIR");
            env::remove_var("XDG_DATA_HOME");
            env::set_var("HOME", "/tmp/wildbuzzard-home");
        }
        assert_eq!(
            socket_path().unwrap(),
            PathBuf::from("/tmp/wildbuzzard-home/.local/share/wildbuzzard/run/control.sock")
        );
    }
}
