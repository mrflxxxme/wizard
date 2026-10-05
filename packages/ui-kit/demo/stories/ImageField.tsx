import { useState } from "react";
import { ImageField } from "../../src/index.js";
import type { Story } from "../story.js";

function Field() {
  const [value, setValue] = useState<string | null>(null);
  return <ImageField name="photo" label="Фото услуги" entity="service" value={value} onChange={setValue} />;
}

export default {
  component: "ImageField",
  spec: "studio",
  role: "owner",
  render: () => <Field />,
} satisfies Story;
