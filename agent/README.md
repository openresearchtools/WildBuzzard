# WildBuzzard Agent Integration

WildBuzzard uses a separately versioned Pi Web fork for its coding-agent UI,
server, session daemon, and Pi dependency. Pi source is not vendored in the
Firefox repository.

The browser-control service and its thin Pi adapter remain here because they
are WildBuzzard browser functionality. Pi Web can keep running without the
browser; the adapter reconnects whenever WildBuzzard publishes a fresh local
browser-control connection.

## Building the Pi Web runtime

Build from a clean, committed local Pi Web fork into an external directory:

```sh
./wildbuzzard/scripts/build-pi-web-runtime.sh \
  --fork ../WildBuzzard-pi-web \
  --ref HEAD
```

The resulting ZIP contains Pi Web, Pi, a verified Node.js runtime, and the
browser-tools adapter. Pass it to the external Firefox build:

```sh
./wildbuzzard/scripts/build-linux-external.sh \
  --working-tree \
  --pi-web-runtime /path/to/wildbuzzard-pi-web-runtime-linux-x64.zip
```

The built-in extension extracts the bundle into the browser profile and uses
Pi Web's native per-user services. Closing WildBuzzard does not stop Pi Web or
its active sessions.

The browser-control architecture, licensing, and acceptance scope are
documented in [`BROWSER-CONTROL.md`](BROWSER-CONTROL.md).
