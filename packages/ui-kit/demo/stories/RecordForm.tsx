import { useState } from "react";
import { RecordForm } from "../../src/index.js";
import type { Story } from "../story.js";

function Form() {
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <>
      <RecordForm
        entity="speaker_application"
        fields={["full_name", "email", "phone", "company", "topic", "abstract", "stream"]}
        onSuccess={(r) => setSaved(r.id)}
      />
      {saved && <p data-testid="demo-saved">{`Создана заявка ${saved}`}</p>}
    </>
  );
}

export default {
  component: "RecordForm",
  spec: "forum",
  role: "speaker",
  render: () => <Form />,
} satisfies Story;
