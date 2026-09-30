import { useState } from "react";
import { ConsentCheckbox } from "../../src/index.js";
import type { Story } from "../story.js";

function Consent() {
  const [checked, setChecked] = useState(false);
  return <ConsentCheckbox checked={checked} onChange={setChecked} />;
}

export default {
  component: "ConsentCheckbox",
  spec: "forum",
  role: "participant",
  render: () => <Consent />,
} satisfies Story;
