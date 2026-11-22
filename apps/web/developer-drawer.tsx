import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function DeveloperDrawer({ title, icon, closeLabel, close, wide, children }: {
  title: string;
  icon: ReactNode;
  closeLabel: string;
  close: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  function dismiss() {
    dialog.current?.close();
    close();
  }
  return <dialog className={wide ? "inspector inspector-wide" : "inspector"} ref={dialog} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); dismiss(); }}
    onClick={(event) => {
      if (event.target === event.currentTarget && event.clientX < event.currentTarget.getBoundingClientRect().left) dismiss();
    }}>
    <div className="inspector-heading">
      <span className="inspector-icon" aria-hidden="true">{icon}</span>
      <h2 id={titleId}>{title}</h2>
      <button className="icon-button" type="button" aria-label={closeLabel} onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </div>
    <div className="inspector-scroll">{children}</div>
  </dialog>;
}
