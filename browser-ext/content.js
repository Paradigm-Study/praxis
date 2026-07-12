(() => {
  "use strict";

  // Capture pristine references before installing any page-level patches.
  const nativeFetch = window.fetch.bind(window);
  const nativeConsoleError = window.console.error.bind(window.console);
  const nativeXhrOpen = window.XMLHttpRequest.prototype.open;
  const nativeXhrSend = window.XMLHttpRequest.prototype.send;
  const nativeSetInterval = window.setInterval.bind(window);

  if (window.__praxisDevTelemetry) return;
  window.__praxisDevTelemetry = true;

  const endpoint = "http://127.0.0.1:4319/api/ingest/browser";
  const queue = [];
  const xhrMetadata = Symbol("praxisXhrMetadata");

  function isTelemetryUrl(url) {
    return typeof url === "string" && url.includes("/api/ingest/browser");
  }

  function stringify(value) {
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  }

  function push(kind, url, message, stack, status) {
    const event = {
      kind,
      url: stringify(url),
      message: stringify(message).slice(0, 1000),
      ts: new Date().toISOString(),
    };

    if (typeof stack === "string" && stack.length > 0) {
      event.stack = stack.slice(0, 2000);
    }
    if (typeof status === "number") {
      event.status = status;
    }

    // Keep the newest diagnostics when a noisy page fills the bounded queue.
    if (queue.length >= 200) queue.shift();
    queue.push(event);
  }

  function formatConsoleArgument(value) {
    if (typeof value === "object" && value !== null) {
      try {
        const json = JSON.stringify(value);
        if (typeof json === "string") return json;
      } catch {
        // Fall back to String below for circular or otherwise unusual objects.
      }
    }
    return stringify(value);
  }

  function requestUrl(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url;
      return String(input);
    } catch {
      return window.location.href;
    }
  }

  window.addEventListener(
    "error",
    (event) => {
      try {
        // Resource load events are intentionally skipped in v0 because they are
        // often noisy and do not carry a useful Error or stack.
        if (!(event instanceof ErrorEvent)) return;

        const error = event.error;
        const message = event.message || stringify(error || "Uncaught error");
        const stack = error && typeof error.stack === "string" ? error.stack : undefined;
        push("console_error", event.filename || window.location.href, message, stack);
      } catch {
        // Telemetry must never interfere with the host page.
      }
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    try {
      const reason = event.reason;
      const message = stringify(reason?.message ?? reason);
      const stack = typeof reason?.stack === "string" ? reason.stack : undefined;
      push("console_error", window.location.href, message, stack);
    } catch {
      // Telemetry must never interfere with the host page.
    }
  });

  window.console.error = (...args) => {
    const result = nativeConsoleError(...args);
    try {
      push(
        "console_error",
        window.location.href,
        args.map(formatConsoleArgument).join(" "),
      );
    } catch {
      // Preserve normal console behavior even if telemetry formatting fails.
    }
    return result;
  };

  window.fetch = (input, init) => {
    const url = requestUrl(input);

    return nativeFetch(input, init).then(
      (response) => {
        try {
          if (!isTelemetryUrl(url) && response.status >= 400) {
            push(
              "network_error",
              url,
              `HTTP ${response.status} ${response.statusText}`,
              undefined,
              response.status,
            );
          }
        } catch {
          // Return the untouched response even if telemetry collection fails.
        }
        return response;
      },
      (error) => {
        try {
          if (!isTelemetryUrl(url)) {
            push("network_error", url, stringify(error));
          }
        } catch {
          // Re-throw the original fetch error below.
        }
        throw error;
      },
    );
  };

  window.XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this[xhrMetadata] = {
        method: stringify(method),
        url: stringify(url),
      };
    } catch {
      // Native open remains authoritative if metadata collection fails.
    }
    return Reflect.apply(nativeXhrOpen, this, arguments);
  };

  window.XMLHttpRequest.prototype.send = function () {
    try {
      const xhr = this;
      const metadata = xhr[xhrMetadata];
      if (metadata && !isTelemetryUrl(metadata.url)) {
        xhr.addEventListener(
          "loadend",
          () => {
            try {
              if (xhr.status >= 400) {
                push(
                  "network_error",
                  metadata.url,
                  `HTTP ${xhr.status} ${xhr.statusText}`,
                  undefined,
                  xhr.status,
                );
              } else if (xhr.status === 0) {
                push("network_error", metadata.url, "network failure", undefined, 0);
              }
            } catch {
              // XHR completion must remain transparent to the host page.
            }
          },
          { once: true },
        );
      }
    } catch {
      // Always call through to the native send implementation.
    }
    return Reflect.apply(nativeXhrSend, this, arguments);
  };

  function flush() {
    if (queue.length === 0) return;

    // 12 events per batch keeps the worst-case JSON body (1000-char message +
    // 2000-char stack per event, doubled by escaping) under the server's 64 KiB
    // limit; larger batches could be 413-rejected and silently lost forever.
    const batch = queue.splice(0, 12);
    try {
      nativeFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // The Studio may be down; batches are intentionally dropped silently.
    }
  }

  nativeSetInterval(flush, 3000);
})();
