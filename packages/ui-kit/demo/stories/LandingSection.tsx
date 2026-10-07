import { useState } from "react";
import { DataTable, LandingSection } from "../../src/index.js";
import type { Story } from "../story.js";

function WithTabs() {
  const [tab, setTab] = useState<string | null>(null);
  return (
    <LandingSection
      testId="tabs"
      tone="alt"
      title="Пример: услуги по разделам"
      tabs={[
        { id: null, label: "Все" },
        { id: "a", label: "Пример: стрижки" },
        { id: "b", label: "Пример: окрашивание" },
      ]}
      tab={tab}
      onTab={setTab}
    >
      <DataTable entity="service" columns={["title", "price"]} />
    </LandingSection>
  );
}

export default {
  component: "LandingSection",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="LandingSection">
      <LandingSection
        testId="section"
        title="Пример: услуги из каталога"
        intro="Рамка секции вокруг витрины модуля."
      >
        <DataTable entity="service" columns={["title", "price"]} />
      </LandingSection>
      <WithTabs />
    </div>
  ),
} satisfies Story;
