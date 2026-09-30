import { QrScanner } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "QrScanner",
  spec: "forum",
  role: "volunteer",
  render: () => <QrScanner checkpoint="Вход А" />,
} satisfies Story;
