// The browser entry point. Everything it wires is same-origin (spec 024 B-1):
// the API client's base url is this page's own origin, and the SSE stream is
// the browser's native EventSource, which already does `Last-Event-ID` replay
// on reconnect (B-3) against spec 022 B-4's ring.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { browserClient } from "./api";
import type { EventSourceLike } from "./store";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("web: #root is missing from index.html");

const openStream = (url: string): EventSourceLike => new EventSource(url);

// The stream url comes off the client's own route table rather than being
// built here, which is the same rule every other path in this app follows.
createRoot(container).render(
  <StrictMode>
    <App client={browserClient()} openStream={openStream} />
  </StrictMode>
);
