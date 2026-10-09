// Zod without its JIT (V3-06): zod 4 probes `new Function` once to speed up object parsing; under the platform CSP
// (script-src 'self', no 'unsafe-eval') the probe is refused and Chrome reports a securitypolicyviolation and a console
// error even though zod swallows it. jitless skips the probe; parsing stays correct. Imported first by main.tsx.
import { config } from "zod";

config({ jitless: true });
