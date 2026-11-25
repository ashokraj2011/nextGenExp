export type CepEmbedMode = "launcher" | "inline" | "sidebar";
export type CepEmbedTheme = "light" | "dark";
export type CepEmbedDomain = "wealth" | "it_ops" | "sales_revops";

export interface CepEmbedMountOptions {
  baseUrl?: string;
  mode?: CepEmbedMode;
  personaId?: string;
  domain?: CepEmbedDomain;
  theme?: CepEmbedTheme;
  brand?: string;
  accent?: string;
  position?: "bottom-right" | "bottom-left";
  open?: boolean;
  height?: string;
  prompt?: string;
  onEvent?: (event: CepEmbedHostEvent) => void;
}

export interface CepEmbedScreenContext {
  id: string;
  label: string;
  viewType: string;
  summary: string;
  metrics?: { label: string; value: string }[];
  suggestedActions?: { label: string; prompt: string }[];
  dataAttributes?: Record<string, string | number>;
}

export type CepEmbedFrameCommand =
  | { protocol: "cep:v1"; type: "cep:send_prompt"; payload: { prompt: string } }
  | { protocol: "cep:v1"; type: "cep:set_theme"; payload: { theme: CepEmbedTheme } }
  | { protocol: "cep:v1"; type: "cep:set_domain"; payload: { domain: CepEmbedDomain } }
  | { protocol: "cep:v1"; type: "cep:set_brand"; payload: { brand?: string; accent?: string } }
  | { protocol: "cep:v1"; type: "cep:set_persona"; payload: { personaId: string } }
  | { protocol: "cep:v1"; type: "cep:screen_context"; payload: CepEmbedScreenContext };

export type CepEmbedHostEvent =
  | {
      protocol: "cep:v1";
      type: "cep:ready";
      payload: {
        personaId: string;
        displayName: string;
        domain: CepEmbedDomain;
        theme: CepEmbedTheme;
      };
    }
  | {
      protocol: "cep:v1";
      type: "cep:turn_completed";
      payload: {
        turnId: string;
        message: string;
        status: string;
        summary?: string;
      };
    }
  | {
      protocol: "cep:v1";
      type: "cep:balance_updated";
      payload: {
        personaId: string;
        displayName: string;
        cashCents: number;
        equityCents: number;
        totalCents: number;
      };
    };

export interface CepEmbedController {
  open(): void;
  close(): void;
  toggle(): void;
  sendPrompt(prompt: string): void;
  setTheme(theme: CepEmbedTheme): void;
  setDomain(domain: CepEmbedDomain): void;
  setBrand(brand: string, accent?: string): void;
  setPersona(personaId: string): void;
  setScreenContext(context: CepEmbedScreenContext): void;
  destroy(): void;
  element: HTMLElement;
}

export const CEP_EMBED_PROTOCOL = "cep:v1" as const;
