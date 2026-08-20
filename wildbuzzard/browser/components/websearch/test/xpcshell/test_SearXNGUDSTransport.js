/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  parseSearXNGHTTPResponse,
  requestSearXNGUDS,
  SearXNGUDSTransportTestUtils,
} = ChromeUtils.importESModule(
  "resource:///modules/SearXNGUDSTransport.sys.mjs"
);

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const UnixServerSocket = Components.Constructor(
  "@mozilla.org/network/server-socket;1",
  "nsIServerSocket",
  "initWithFilename"
);

add_task(function test_content_length_and_chunked_framing() {
  const fixed = parseSearXNGHTTPResponse(
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nOK"
  );
  Assert.equal(fixed.status, 200);
  Assert.equal(new TextDecoder().decode(fixed.body), "OK");

  const chunked = parseSearXNGHTTPResponse(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n"
  );
  Assert.equal(new TextDecoder().decode(chunked.body), "OK");
});

add_task(function test_detects_complete_keep_alive_responses() {
  const fixed =
    "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nOK";
  Assert.equal(
    SearXNGUDSTransportTestUtils.completeResponseLength(
      fixed.slice(0, -1),
      1024
    ),
    null
  );
  Assert.equal(
    SearXNGUDSTransportTestUtils.completeResponseLength(fixed, 1024),
    fixed.length
  );

  const chunked =
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n";
  Assert.equal(
    SearXNGUDSTransportTestUtils.completeResponseLength(
      chunked.slice(0, -1),
      1024
    ),
    null
  );
  Assert.equal(
    SearXNGUDSTransportTestUtils.completeResponseLength(chunked, 1024),
    chunked.length
  );
});

add_task(function test_rejects_ambiguous_or_oversized_framing() {
  for (const source of [
    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: y\r\n\r\n",
  ]) {
    Assert.throws(() => parseSearXNGHTTPResponse(source), /SearXNG returned/);
  }
  Assert.equal(
    new TextDecoder().decode(
      parseSearXNGHTTPResponse(
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK",
        2
      ).body
    ),
    "OK"
  );
  Assert.throws(
    () =>
      parseSearXNGHTTPResponse(
        "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nBAD",
        2
      ),
    /exceeded/
  );
});

add_task(async function test_request_over_unix_domain_socket() {
  const socketFile = new LocalFile("/tmp");
  socketFile.append(`wb-${Services.uuid.generateUUID()}`);
  const server = new UnixServerSocket(socketFile, 0o600, -1);
  server.asyncListen({
    onSocketAccepted(_server, transport) {
      const input = transport
        .openInputStream(0, 0, 0)
        .QueryInterface(Ci.nsIAsyncInputStream);
      const output = transport.openOutputStream(0, 0, 0);
      input.asyncWait(
        {
          onInputStreamReady(stream) {
            const reader = Cc[
              "@mozilla.org/scriptableinputstream;1"
            ].createInstance(Ci.nsIScriptableInputStream);
            reader.init(stream);
            const request = reader.readBytes(stream.available());
            Assert.ok(request.startsWith("GET /healthz HTTP/1.1\r\n"));
            const response =
              "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nOK";
            output.write(response, response.length);
            output.close();
          },
        },
        0,
        0,
        Services.tm.currentThread
      );
    },
    onStopListening() {},
  });
  try {
    const response = await requestSearXNGUDS(
      new LocalFile(socketFile.path),
      {
        target: "/healthz",
        maximum: 16,
        timeout: 3000,
      }
    );
    Assert.equal(response.status, 200);
    Assert.equal(new TextDecoder().decode(response.body), "OK");
  } finally {
    server.close();
  }
});

function asyncOutput({ abortController, wouldBlock = true } = {}) {
  let source = "";
  let closedStatus;
  let writeCalls = 0;
  let flushCalls = 0;
  return {
    asyncWait(callback) {
      Services.tm.dispatchToMainThread(() =>
        callback.onOutputStreamReady(this)
      );
    },
    closeWithStatus(status) {
      closedStatus = status;
    },
    flush() {
      flushCalls++;
      if (wouldBlock && flushCalls === 1) {
        throw Components.Exception(
          "would block",
          Cr.NS_BASE_STREAM_WOULD_BLOCK
        );
      }
    },
    write(value, count) {
      writeCalls++;
      if (wouldBlock && writeCalls === 1) {
        throw Components.Exception(
          "would block",
          Cr.NS_BASE_STREAM_WOULD_BLOCK
        );
      }
      const written = Math.min(count, 3);
      source += value.slice(0, written);
      if (abortController && source.length >= 3) {
        abortController.abort();
      }
      return written;
    },
    result() {
      return { closedStatus, flushCalls, source, writeCalls };
    },
  };
}

add_task(async function test_async_writer_retries_partial_and_would_block() {
  const output = asyncOutput();
  await SearXNGUDSTransportTestUtils.writeAsyncRequest(output, "REQUEST");
  const result = output.result();
  Assert.equal(result.source, "REQUEST");
  Assert.greater(result.writeCalls, 2);
  Assert.equal(result.flushCalls, 2);
});

add_task(async function test_async_writer_cancellation_closes_stream() {
  const controller = new AbortController();
  const output = asyncOutput({
    abortController: controller,
    wouldBlock: false,
  });
  await Assert.rejects(
    SearXNGUDSTransportTestUtils.writeAsyncRequest(
      output,
      "REQUEST",
      controller.signal
    ),
    error => error.result === Cr.NS_ERROR_ABORT
  );
  Assert.equal(output.result().closedStatus, Cr.NS_ERROR_ABORT);
});
