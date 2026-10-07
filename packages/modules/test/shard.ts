// CI shards of the browser suites of the modules (B2-28, .github/workflows/ci.yml job `goals`): WIZARD_GOALS_SHARD=k/n
// runs the rows i with i mod n = k − 1; without it every row runs.
const [k, n] = (process.env.WIZARD_GOALS_SHARD ?? "1/1").split("/").map(Number) as [number, number];

/** Whether row `i` of a browser suite runs in this shard. */
export const inShard = (i: number): boolean => !(n > 1) || i % n === (k - 1) % n;
