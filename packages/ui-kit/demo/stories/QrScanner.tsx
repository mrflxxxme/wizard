import { QrScanner } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "QrScanner",
  spec: "forum",
  role: "volunteer",
  // ?offline=1 — M2-03 offline package and queue over the memory DataSource.
  render: () => (
    <QrScanner checkpoint="Вход А" offline={new URLSearchParams(window.location.search).has("offline")} />
  ),
} satisfies Story;
