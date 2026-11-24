import { useState } from "react";
import { ChartPie, ChevronDown, ChevronUp, CircleArrowRight, House, LayoutDashboard, Settings2, ShieldCheck } from "lucide-react";
import { workspacePins, type WorkspacePin } from "../../packages/contracts/workspace";
import { DeveloperDrawer } from "./developer-drawer";

export const workspaceSections = {
  summary: { label: "Summary", Icon: LayoutDashboard },
  portfolio: { label: "Portfolio", Icon: ChartPie },
  savings: { label: "Savings goal", Icon: House },
  account: { label: "Account status", Icon: ShieldCheck },
  "next-step": { label: "Next step", Icon: CircleArrowRight },
};
export type WorkspaceSection = keyof typeof workspaceSections;

export function WorkspaceMenu({ pins, section, onSelect, onCustomize, trigger, disabled }: {
  pins: WorkspacePin[]; section: WorkspaceSection; onSelect: (section: WorkspaceSection) => void;
  onCustomize: () => void; trigger: React.RefObject<HTMLButtonElement | null>; disabled: boolean;
}) {
  const items = ["summary", ...pins] as const;
  return <div className="workspace-menu">
    <nav aria-label="Workspace shortcuts">
      {items.map((item) => {
        const { label, Icon } = workspaceSections[item];
        return <button key={item} className="workspace-shortcut" type="button" aria-pressed={item === section}
          onClick={() => onSelect(item)}><Icon size={16} aria-hidden="true" />{label}</button>;
      })}
    </nav>
    <button ref={trigger} className="workspace-customize" type="button" aria-label="Customize shortcuts" aria-haspopup="dialog"
      disabled={disabled} onClick={onCustomize}><Settings2 size={16} aria-hidden="true" /><span>Customize</span></button>
  </div>;
}

export function WorkspaceCustomization({ initial, pending, notice, close, save }: {
  initial: WorkspacePin[]; pending: boolean; notice: string; close: () => void; save: (pins: WorkspacePin[]) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState(initial);
  function move(pin: WorkspacePin, delta: number) {
    const items = [...selected];
    const from = items.indexOf(pin);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= items.length) return;
    [items[from], items[to]] = [items[to], items[from]];
    setSelected(items);
  }
  return <DeveloperDrawer title="Customize shortcuts" closeLabel="Close customization" icon={<Settings2 size={17} />} close={close}>
    <form className="pin-settings" onSubmit={async (event) => { event.preventDefault(); if (await save(selected)) close(); }}>
      <fieldset>
        <legend>Sections above chat</legend>
        {[...selected, ...workspacePins.filter((pin) => !selected.includes(pin))].map((pin) => {
          const { Icon, label } = workspaceSections[pin];
          const index = selected.indexOf(pin);
          return <div className="pin-settings-row" key={pin}>
            <label><input type="checkbox" checked={index >= 0} onChange={(event) => setSelected(event.target.checked
              ? [...selected, pin] : selected.filter((value) => value !== pin))} /><Icon size={17} aria-hidden="true" />{label}</label>
            {index >= 0 && <div>
              <button className="icon-button" type="button" aria-label={`Move ${label} up`} disabled={index === 0}
                onClick={() => move(pin, -1)}><ChevronUp size={17} aria-hidden="true" /></button>
              <button className="icon-button" type="button" aria-label={`Move ${label} down`} disabled={index === selected.length - 1}
                onClick={() => move(pin, 1)}><ChevronDown size={17} aria-hidden="true" /></button>
            </div>}
          </div>;
        })}
      </fieldset>
      <button className="secondary-button" type="submit" disabled={pending}>Save shortcuts</button>
      {notice && <p className="request-notice" role="alert">{notice}</p>}
    </form>
  </DeveloperDrawer>;
}
