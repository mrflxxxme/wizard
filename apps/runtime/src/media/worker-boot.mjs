// Entry of the image worker thread. The runtime runs its TypeScript through tsx (node --import tsx, inherited by
// workers); a worker started from a test runner has no loader yet, so tsx is registered here first.
import { register } from "tsx/esm/api";

if (!process.execArgv.some((a) => a.includes("tsx"))) register();
await import("./worker.ts");
