import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useVehicleStore } from '../../stores/mobileVehicleStore';

export default function ConfirmButton({ children, title, description, action, disabled = false, className = 'mobile-button' }: {
  children: ReactNode; title: string; description: string; action: () => Promise<boolean>; disabled?: boolean; className?: string;
}) {
  const busy = useVehicleStore((s) => s.isLoading);
  const source = useVehicleStore((s) => s.source);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (open && !dialog.open) dialog.showModal(); else if (!open && dialog.open) dialog.close(); }, [open]);
  return <>
    <button type="button" disabled={disabled || busy} className={className} onClick={() => setOpen(true)}>{children}</button>
    <dialog ref={ref} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} className="mobile-dialog m-auto w-[calc(100%-2rem)] max-w-sm rounded-3xl border border-white/10 bg-[#20242c] p-6 text-neutral-100 backdrop:bg-black/70">
      <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
      <p id={descriptionId} className="mt-3 break-words text-sm leading-6 text-neutral-400">{description}{source === 'mock' && ' 当前仅为模拟操作。'}</p>
      <div className="mt-6 grid grid-cols-2 gap-3">
        <button autoFocus type="button" className="mobile-button" onClick={() => setOpen(false)}>取消</button>
        <button type="button" disabled={busy || disabled} className="mobile-button" onClick={() => { setOpen(false); void action(); }}>确认操作</button>
      </div>
    </dialog>
  </>;
}
