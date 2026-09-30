import { AppShell } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "AppShell",
  spec: "forum",
  role: null,
  render: () => (
    <AppShell>
      <p>Содержимое страницы системы.</p>
    </AppShell>
  ),
} satisfies Story;
