/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { parseSearXNGHTTPResponse, SearXNGUDSTransportTestUtils } =
  ChromeUtils.importESModule("resource:///modules/SearXNGUDSTransport.sys.mjs");

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
