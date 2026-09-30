// Root DOM attributes of a component (ui-kit.yaml#rules, #wz_id). Sub-parts get only data-testid.
export type RootAttrs = {
  "data-testid": string;
  "data-wz-component"?: string;
  "data-wz-id"?: string;
  "data-wz-index"?: number;
};

export const part = (testid: string): RootAttrs => ({ "data-testid": testid });
