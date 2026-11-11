// DOM for component tests (pure JavaScript; no native add-ons).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://127.0.0.1:4317/" });

// The app never reaches a server in component tests.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: "offline", message: "no server in tests" }), { status: 503 })) as unknown as typeof fetch;
