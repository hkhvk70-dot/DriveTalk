import type { ReactNode } from 'react';

interface Props {
  title: string;
  description: string;
  className?: string;
  children?: ReactNode;
}

/** Layout-only slot. Replace with a data-driven component in the next steps. */
export default function DashboardPlaceholder({ title, description, className = '', children }: Props) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-col justify-center rounded-2xl bg-white/[0.025] p-5 sm:p-6 ${className}`}>
      <h2 className="text-sm font-medium tracking-wide text-neutral-300">{title}</h2>
      {children}
      <p className="mt-3 text-xs leading-relaxed text-neutral-500">{description}</p>
    </section>
  );
}
