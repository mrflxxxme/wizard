import { useState } from "react";
import { LeadForm } from "../../src/index.js";
import type { Story } from "../story.js";

function Forms() {
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <div data-variants="LeadForm">
      <LeadForm
        testId="card"
        entity="lead"
        intro="Пример: оставьте телефон — вам перезвонят."
        fields={["name", "phone", "service", "message"]}
        onSuccess={(r) => setSaved(String(r.id))}
      />
      <LeadForm
        testId="split"
        anchor="lead-split"
        variant="split"
        tone="alt"
        entity="lead"
        title="Пример: запись на консультацию"
        fields={["name", "phone"]}
        hidden={{ service: "basic" }}
        contacts={[
          { label: "Телефон (пример)", value: "+7 000 000-00-00", href: "tel:+70000000000" },
          { label: "Адрес (пример)", value: "Город, улица, дом" },
        ]}
      />
      <LeadForm
        testId="inline"
        anchor="lead-inline"
        variant="inline"
        entity="lead"
        fields={["name", "phone"]}
      />
      {saved && <p data-testid="demo-saved">{`Создана заявка ${saved}`}</p>}
    </div>
  );
}

export default {
  component: "LeadForm",
  spec: "studio",
  role: null,
  render: () => <Forms />,
} satisfies Story;
