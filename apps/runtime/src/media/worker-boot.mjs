// Entry of the image worker thread. The runtime runs its TypeScript through tsx (node --import tsx). The --import is
// inherited by the worker, but its resolve hook does not reach the worker's imports: worker.ts loads by Node's own type
// stripping and `./codecs.js` is not mapped to codecs.ts — every image upload failed as UNREADABLE under
// `node --import tsx` (the images of platform-api, worker and runtime; found by the B2-41 dry run, GS-landing-2). So tsx
// is registered here in every case (a test runner's worker has no loader at all).
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
