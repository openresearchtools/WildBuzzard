// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from BrowserOS browseros-mcp/src/tools/run.rs.

use rquickjs::{
    Array, AsyncContext, AsyncRuntime, CatchResultExt, CaughtError, Ctx, Exception, FromJs,
    Function, IntoJs, Object, Promise, Value as JsValue,
    function::{Async, Func},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter},
    sync::{Mutex as AsyncMutex, Semaphore, oneshot},
    time::{Instant, sleep_until, timeout_at},
};

const MAX_TIMEOUT_MS: u64 = 30_000;
const MAX_PENDING_CALLS: usize = 32;
const RUN_MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const RUN_STACK_SIZE_BYTES: usize = 512 * 1024;
const MAX_LOG_ENTRIES: usize = 1_000;
const MAX_LOG_BYTES: usize = 1_000_000;
const MAX_RETURN_VALUE_BYTES: usize = 2_000_000;

const BOOTSTRAP_JS: &str = r#"
(() => {
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

  function safeStringify(value) {
    if (value === undefined) return 'undefined';
    try {
      const encoded = JSON.stringify(value, null, 2);
      return encoded ?? String(value);
    } catch {
      return String(value);
    }
  }

  function jsonSafeString(value) {
    const seen = new WeakSet();
    let encoded;
    try {
      encoded = JSON.stringify(value, (_key, next) => {
        if (typeof next === 'bigint') return next.toString();
        if (typeof next === 'function' || typeof next === 'symbol') return String(next);
        if (typeof next === 'number' && !Number.isFinite(next)) return null;
        if (typeof next === 'object' && next !== null) {
          if (seen.has(next)) return '[Circular]';
          seen.add(next);
        }
        return next;
      });
    } catch {
      return JSON.stringify(safeStringify(value));
    }
    return encoded;
  }

  function call(method, args) {
    return __wildbuzzardCall(method, JSON.stringify(args ?? []));
  }

  function scoped(prefix, pageId) {
    return (name, args) => call(`${prefix}.${name}`, [pageId, ...args]);
  }

  const browser = {
    pages: {
      list: () => call('pages.list', []),
      newPage: (url, opts) => call('pages.newPage', [url, opts]),
      close: (pageId) => call('pages.close', [pageId]),
      activate: (pageId) => call('pages.activate', [pageId]),
      claim: (pageId) => call('pages.claim', [pageId]),
      getInfo: (pageId) => call('pages.getInfo', [pageId]),
    },
    observe: (pageId) => {
      const run = scoped('observe', pageId);
      return {
        snapshot: () => run('snapshot', []),
        diff: () => run('diff', []),
        resolveRef: (ref) => run('resolveRef', [ref]),
      };
    },
    input: (pageId) => {
      const run = scoped('input', pageId);
      return {
        click: (ref) => run('click', [ref]),
        fill: (ref, value) => run('fill', [ref, value]),
        type: (text) => run('type', [text]),
        press: (key) => run('press', [key]),
        hover: (ref) => run('hover', [ref]),
        selectOption: (ref, value) => run('selectOption', [ref, value]),
        scroll: (dir, amount, ref) => run('scroll', [dir, amount, ref]),
      };
    },
    nav: (pageId) => {
      const run = scoped('nav', pageId);
      return {
        goto: (url) => run('goto', [url]),
        back: () => run('back', []),
        forward: () => run('forward', []),
        reload: () => run('reload', []),
      };
    },
    cdp: (method, params, sessionId) => call('cdp', [method, params, sessionId]),
    cdpJsonForPage: (pageId, method, paramsJson) =>
      call('cdpJsonForPage', [pageId, method, paramsJson]),
    read: (pageId, opts) => call('tool:read', [pageId, opts]),
    grep: (pageId, opts) => call('tool:grep', [pageId, opts]),
    wait: (pageId, opts) => call('tool:wait', [pageId, opts]),
    screenshot: (pageId, opts) => call('tool:screenshot', [pageId, opts]),
    evaluate: (pageId, opts) => call('tool:evaluate', [pageId, opts]),
    download: (pageId, opts) => call('tool:download', [pageId, opts]),
    pdf: (pageId, opts) => call('tool:pdf', [pageId, opts]),
    upload: (pageId, opts) => call('tool:upload', [pageId, opts]),
    tabGroups: (opts) => call('tool:tab_groups', [opts]),
    history: (opts) => call('tool:history', [opts]),
    bookmarks: (opts) => call('tool:bookmarks', [opts]),
    windows: (opts) => call('tool:windows', [opts]),
  };

  const sink = (level) => (...parts) => {
    __wildbuzzardPushLog(
      `${level}${parts
        .map((part) => (typeof part === 'string' ? part : safeStringify(part)))
        .join(' ')}`
    );
  };

  globalThis.__wildbuzzardBrowser = browser;
  globalThis.__wildbuzzardConsole = {
    log: sink(''),
    info: sink(''),
    warn: sink('warn: '),
    error: sink('error: '),
    debug: sink(''),
  };
  globalThis.__wildbuzzardMakeRunFunction = (code) =>
    new AsyncFunction('browser', 'console', `"use strict";\n${code}`);
  globalThis.__wildbuzzardJsonSafeString = jsonSafeString;
  globalThis.__wildbuzzardSafeStringify = safeStringify;
})();
"#;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum InputMessage {
    Start {
        code: String,
        timeout: f64,
    },
    Result {
        id: u64,
        ok: bool,
        #[serde(default)]
        value: Option<Value>,
        #[serde(default)]
        undefined: bool,
        #[serde(default)]
        error: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum OutputMessage {
    Call {
        id: u64,
        method: String,
        args: Value,
    },
    Done {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        logs: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

enum BridgeValue {
    Json(Value),
    Undefined,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<BridgeValue, String>>>>>;
type OutputWriter = Box<dyn tokio::io::AsyncWrite + Send + Unpin>;
type Output = Arc<AsyncMutex<OutputWriter>>;

struct PendingCall {
    id: u64,
    pending: Pending,
}

impl Drop for PendingCall {
    fn drop(&mut self) {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
    }
}

#[derive(Clone)]
struct Bridge {
    next_id: Arc<AtomicU64>,
    pending: Pending,
    call_slots: Arc<Semaphore>,
    output: Output,
    deadline: Instant,
}

impl Bridge {
    async fn call(&self, method: String, args_json: String) -> Result<BridgeValue, String> {
        let args = serde_json::from_str(&args_json)
            .map_err(|error| format!("Invalid browser call arguments: {error}"))?;
        let _permit = self.call_slots.clone().try_acquire_owned().map_err(|_| {
            format!("browser call limit exceeded (max {MAX_PENDING_CALLS} concurrent calls)")
        })?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "browser call registry unavailable".to_string())?
            .insert(id, sender);
        let _pending_call = PendingCall {
            id,
            pending: self.pending.clone(),
        };
        if let Err(error) =
            write_message(&self.output, &OutputMessage::Call { id, method, args }).await
        {
            return Err(error);
        }
        match timeout_at(self.deadline, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("browser bridge closed".to_string()),
            Err(_) => Err("run timed out".to_string()),
        }
    }
}

#[derive(Default)]
struct CapturedLogs {
    entries: Vec<String>,
    bytes: usize,
    limit_message: Option<String>,
}

type SharedLogs = Arc<Mutex<CapturedLogs>>;

struct RunOutcome {
    ok: bool,
    value: Option<Value>,
    logs: Vec<String>,
    error: Option<String>,
}

enum JsonValueError<'js> {
    Js(CaughtError<'js>),
    Limit(String),
}

async fn write_message(output: &Output, message: &OutputMessage) -> Result<(), String> {
    let mut line = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    line.push(b'\n');
    let mut writer = output.lock().await;
    writer
        .write_all(&line)
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())
}

fn timeout_ms(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        1
    } else {
        value.ceil().min(MAX_TIMEOUT_MS as f64) as u64
    }
}

fn logs_snapshot(logs: &SharedLogs) -> Vec<String> {
    logs.lock()
        .map(|logs| logs.entries.clone())
        .unwrap_or_default()
}

fn push_log(logs: &SharedLogs, line: String) -> Result<(), String> {
    let mut logs = logs
        .lock()
        .map_err(|_| "run log capture unavailable".to_string())?;
    if let Some(message) = &logs.limit_message {
        return Err(message.clone());
    }
    if logs.entries.len() >= MAX_LOG_ENTRIES
        || logs.bytes.saturating_add(line.len()) > MAX_LOG_BYTES
    {
        let message = format!(
            "run console output exceeded limit (max {MAX_LOG_ENTRIES} entries, {MAX_LOG_BYTES} bytes)"
        );
        logs.limit_message = Some(message.clone());
        return Err(message);
    }
    logs.bytes = logs.bytes.saturating_add(line.len());
    logs.entries.push(line);
    Ok(())
}

fn json_to_js<'js>(ctx: &Ctx<'js>, value: Value) -> rquickjs::Result<JsValue<'js>> {
    match value {
        Value::Null => Ok(JsValue::new_null(ctx.clone())),
        Value::Bool(value) => Ok(JsValue::new_bool(ctx.clone(), value)),
        Value::Number(value) => Ok(JsValue::new_number(
            ctx.clone(),
            value.as_f64().unwrap_or_default(),
        )),
        Value::String(value) => value.into_js(ctx),
        Value::Array(values) => {
            let array = Array::new(ctx.clone())?;
            for (index, value) in values.into_iter().enumerate() {
                array.set(index, json_to_js(ctx, value)?)?;
            }
            Ok(array.into_value())
        }
        Value::Object(values) => {
            let object = Object::new(ctx.clone())?;
            for (key, value) in values {
                object.set(key, json_to_js(ctx, value)?)?;
            }
            Ok(object.into_value())
        }
    }
}

fn js_error_message<'js>(ctx: &Ctx<'js>, error: CaughtError<'js>) -> String {
    match error {
        CaughtError::Error(error) => error.to_string(),
        CaughtError::Exception(exception) => {
            exception.message().unwrap_or_else(|| exception.to_string())
        }
        CaughtError::Value(value) => {
            if value.is_undefined() {
                "undefined".to_string()
            } else if value.is_null() {
                "null".to_string()
            } else if let Some(value) = value.as_bool() {
                value.to_string()
            } else if let Some(value) = value.as_number() {
                value.to_string()
            } else if let Ok(value) = String::from_js(ctx, value.clone()) {
                value
            } else {
                let constructor: rquickjs::Result<Function<'_>> = ctx.globals().get("String");
                constructor
                    .and_then(|function| function.call((value,)))
                    .unwrap_or_else(|error| error.to_string())
            }
        }
    }
}

fn json_safe_value<'js>(
    ctx: &Ctx<'js>,
    value: JsValue<'js>,
) -> Result<(Option<Value>, Option<String>), JsonValueError<'js>> {
    let encode: Function<'_> = ctx
        .globals()
        .get("__wildbuzzardJsonSafeString")
        .catch(ctx)
        .map_err(JsonValueError::Js)?;
    let encoded: Option<String> = encode
        .call((value.clone(),))
        .catch(ctx)
        .map_err(JsonValueError::Js)?;
    let Some(encoded) = encoded else {
        return Ok((None, None));
    };
    if encoded.len() > MAX_RETURN_VALUE_BYTES {
        return Err(JsonValueError::Limit(format!(
            "run return value exceeded {MAX_RETURN_VALUE_BYTES} byte limit"
        )));
    }
    let display: Function<'_> = ctx
        .globals()
        .get("__wildbuzzardSafeStringify")
        .catch(ctx)
        .map_err(JsonValueError::Js)?;
    let text: String = display
        .call((value,))
        .catch(ctx)
        .map_err(JsonValueError::Js)?;
    let value = serde_json::from_str(&encoded).map_err(|error| {
        JsonValueError::Js(CaughtError::Error(rquickjs::Error::new_from_js_message(
            "string",
            "JSON",
            error.to_string(),
        )))
    })?;
    Ok((Some(value), Some(text)))
}

fn install_globals<'js>(
    ctx: &Ctx<'js>,
    bridge: Bridge,
    logs: SharedLogs,
) -> Result<(), (&'static str, String)> {
    let call_bridge = move |ctx: Ctx<'js>, method: String, args_json: String| {
        let bridge = bridge.clone();
        async move {
            match bridge.call(method, args_json).await {
                Ok(BridgeValue::Json(value)) => json_to_js(&ctx, value),
                Ok(BridgeValue::Undefined) => Ok(JsValue::new_undefined(ctx.clone())),
                Err(message) => Err(Exception::throw_message(&ctx, &message)),
            }
        }
    };
    let log_sink = move |ctx: Ctx<'js>, line: String| {
        push_log(&logs, line).map_err(|message| Exception::throw_message(&ctx, &message))
    };
    ctx.globals()
        .set("__wildbuzzardCall", Func::from(Async(call_bridge)))
        .catch(ctx)
        .map_err(|error| ("engine", js_error_message(ctx, error)))?;
    ctx.globals()
        .set("__wildbuzzardPushLog", Func::from(log_sink))
        .catch(ctx)
        .map_err(|error| ("engine", js_error_message(ctx, error)))
}

async fn execute(code: String, timeout: u64, bridge: Bridge, logs: SharedLogs) -> RunOutcome {
    let runtime = match AsyncRuntime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            return RunOutcome {
                ok: false,
                value: None,
                logs: vec![],
                error: Some(error.to_string()),
            };
        }
    };
    runtime.set_memory_limit(RUN_MEMORY_LIMIT_BYTES).await;
    runtime.set_max_stack_size(RUN_STACK_SIZE_BYTES).await;
    let interrupt_deadline = std::time::Instant::now() + Duration::from_millis(timeout);
    runtime
        .set_interrupt_handler(Some(Box::new(move || {
            std::time::Instant::now() >= interrupt_deadline
        })))
        .await;
    let context = match AsyncContext::full(&runtime).await {
        Ok(context) => context,
        Err(error) => {
            return RunOutcome {
                ok: false,
                value: None,
                logs: vec![],
                error: Some(error.to_string()),
            };
        }
    };
    let deadline = bridge.deadline;
    let timeout_message = format!("run exceeded {timeout}ms");
    let run = context.async_with(async |ctx| {
        install_globals(&ctx, bridge, logs.clone())?;
        ctx.eval::<(), _>(BOOTSTRAP_JS)
            .catch(&ctx)
            .map_err(|error| ("engine", js_error_message(&ctx, error)))?;
        let factory: Function<'_> = ctx
            .globals()
            .get("__wildbuzzardMakeRunFunction")
            .catch(&ctx)
            .map_err(|error| ("engine", js_error_message(&ctx, error)))?;
        let user_function: Function<'_> = factory
            .call((code,))
            .catch(&ctx)
            .map_err(|error| ("syntax", js_error_message(&ctx, error)))?;
        let browser: Object<'_> = ctx
            .globals()
            .get("__wildbuzzardBrowser")
            .catch(&ctx)
            .map_err(|error| ("engine", js_error_message(&ctx, error)))?;
        let console: Object<'_> = ctx
            .globals()
            .get("__wildbuzzardConsole")
            .catch(&ctx)
            .map_err(|error| ("engine", js_error_message(&ctx, error)))?;
        let promise: Promise<'_> = user_function
            .call((browser, console))
            .catch(&ctx)
            .map_err(|error| ("runtime", js_error_message(&ctx, error)))?;
        let value = promise
            .into_future::<JsValue<'_>>()
            .await
            .catch(&ctx)
            .map_err(|error| ("runtime", js_error_message(&ctx, error)))?;
        json_safe_value(&ctx, value).map_err(|error| match error {
            JsonValueError::Js(error) => ("engine", js_error_message(&ctx, error)),
            JsonValueError::Limit(message) => ("runtime", message),
        })
    });
    let result = tokio::select! {
        () = sleep_until(deadline) => Err(("timeout", timeout_message.clone())),
        result = run => result,
    };
    runtime.set_interrupt_handler(None).await;
    match result {
        Ok((value, _text)) => RunOutcome {
            ok: true,
            value,
            logs: logs_snapshot(&logs),
            error: None,
        },
        Err((kind, error)) => RunOutcome {
            ok: false,
            value: None,
            logs: logs_snapshot(&logs),
            error: Some(if kind == "syntax" {
                format!("run: syntax error - {error}")
            } else if kind == "timeout" || Instant::now() >= deadline {
                timeout_message
            } else {
                error
            }),
        },
    }
}

async fn response_reader(
    mut lines: tokio::io::Lines<BufReader<tokio::io::Stdin>>,
    pending: Pending,
) {
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(InputMessage::Result {
            id,
            ok,
            value,
            undefined,
            error,
        }) = serde_json::from_str(&line)
        else {
            continue;
        };
        let sender = {
            pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id)
        };
        if let Some(sender) = sender {
            let result = if ok {
                Ok(if undefined {
                    BridgeValue::Undefined
                } else {
                    BridgeValue::Json(value.unwrap_or(Value::Null))
                })
            } else {
                Err(error.unwrap_or_else(|| "browser call failed".to_string()))
            };
            let _ = sender.send(result);
        }
    }
    let calls: Vec<_> = pending
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .drain()
        .map(|(_, sender)| sender)
        .collect();
    for sender in calls {
        let _ = sender.send(Err("browser bridge closed".to_string()));
    }
}

#[tokio::main]
async fn main() {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let Some(line) = lines.next_line().await.ok().flatten() else {
        return;
    };
    let Ok(InputMessage::Start { code, timeout }) = serde_json::from_str(&line) else {
        return;
    };
    let timeout = timeout_ms(timeout);
    let pending = Arc::new(Mutex::new(HashMap::new()));
    tokio::spawn(response_reader(lines, pending.clone()));
    let output: Output = Arc::new(AsyncMutex::new(Box::new(BufWriter::new(
        tokio::io::stdout(),
    ))));
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let bridge = Bridge {
        next_id: Arc::new(AtomicU64::new(1)),
        pending,
        call_slots: Arc::new(Semaphore::new(MAX_PENDING_CALLS)),
        output: output.clone(),
        deadline,
    };
    let logs = Arc::new(Mutex::new(CapturedLogs::default()));
    let outcome = execute(code, timeout, bridge, logs).await;
    let _ = write_message(
        &output,
        &OutputMessage::Done {
            ok: outcome.ok,
            value: outcome.value,
            logs: outcome.logs,
            error: outcome.error,
        },
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_bridge(timeout: Duration) -> Bridge {
        Bridge {
            next_id: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            call_slots: Arc::new(Semaphore::new(MAX_PENDING_CALLS)),
            output: Arc::new(AsyncMutex::new(Box::new(tokio::io::sink()))),
            deadline: Instant::now() + timeout,
        }
    }

    fn pending_len(bridge: &Bridge) -> usize {
        bridge
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    async fn wait_for_pending(bridge: &Bridge, expected: usize) {
        timeout_at(Instant::now() + Duration::from_secs(1), async {
            while pending_len(bridge) != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("pending calls did not reach expected count");
    }

    #[tokio::test]
    async fn rejects_calls_above_pending_limit() {
        let bridge = test_bridge(Duration::from_secs(5));
        let mut calls = Vec::new();
        for _ in 0..MAX_PENDING_CALLS {
            let bridge = bridge.clone();
            calls.push(tokio::spawn(async move {
                bridge
                    .call("pages.list".to_string(), "[]".to_string())
                    .await
            }));
        }
        wait_for_pending(&bridge, MAX_PENDING_CALLS).await;

        let result = bridge
            .call("pages.list".to_string(), "[]".to_string())
            .await;
        assert!(matches!(result, Err(error) if error.contains("call limit exceeded")));
        assert_eq!(pending_len(&bridge), MAX_PENDING_CALLS);

        for call in calls {
            call.abort();
            let _ = call.await;
        }
        assert_eq!(pending_len(&bridge), 0);
        assert_eq!(bridge.call_slots.available_permits(), MAX_PENDING_CALLS);
    }

    #[tokio::test]
    async fn removes_pending_call_on_timeout() {
        let bridge = test_bridge(Duration::from_millis(10));
        let result = bridge
            .call("pages.list".to_string(), "[]".to_string())
            .await;

        assert!(matches!(result, Err(error) if error == "run timed out"));
        assert_eq!(pending_len(&bridge), 0);
        assert_eq!(bridge.call_slots.available_permits(), MAX_PENDING_CALLS);
    }

    #[tokio::test]
    async fn removes_pending_call_on_cancellation() {
        let bridge = test_bridge(Duration::from_secs(5));
        let call_bridge = bridge.clone();
        let call = tokio::spawn(async move {
            call_bridge
                .call("pages.list".to_string(), "[]".to_string())
                .await
        });
        wait_for_pending(&bridge, 1).await;

        call.abort();
        assert!(matches!(call.await, Err(error) if error.is_cancelled()));
        assert_eq!(pending_len(&bridge), 0);
        assert_eq!(bridge.call_slots.available_permits(), MAX_PENDING_CALLS);
    }
}
