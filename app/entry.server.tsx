import { PassThrough } from "node:stream";

import type { EntryContext } from "@remix-run/node";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";

import { addDocumentResponseHeaders } from "./shopify.server";

// How long (ms) to wait for the full document to stream before aborting.
const STREAM_TIMEOUT = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);

  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent) ? "onAllReady" : "onShellReady";

  return new Promise<Response>((resolve, reject) => {
    let didError = false;
    let abortStream: () => void;

    // Abort the stream after the timeout expires (shell gets an extra second
    // to flush before the hard kill).
    const timeoutId = setTimeout(() => {
      abortStream();
    }, STREAM_TIMEOUT + 1_000);

    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={remixContext}
        url={request.url}
        abortDelay={STREAM_TIMEOUT}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: didError ? 500 : responseStatusCode,
            })
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          clearTimeout(timeoutId);
          reject(error);
        },
        onError(error: unknown) {
          didError = true;
          console.error(error);
        },
      }
    );

    abortStream = abort;

    // Also honour the incoming request's abort signal.
    request.signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      abort();
    });
  });
}
