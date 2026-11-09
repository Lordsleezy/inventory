import type { ReactNode } from 'react';

export function ReceiveSection({
  id, title, required, status, tone = 'muted',   open, onOpen, keepMounted = false, children,
}: {
  id: string;
  title: string;
  required?: boolean;
  status: string;
  tone?: 'muted' | 'bad' | 'ok';
  open: boolean;
  onOpen: (id: string) => void;
  /** Keep children mounted while closed so scan-time effects still run. */
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const shown = open || keepMounted;
  return (
    <section className={`rcv-sec${open ? ' is-open' : ''}`} data-section={id}>
      <button type="button" className="rcv-sec-btn" aria-expanded={open} onClick={() => onOpen(id)}>
        <strong>{title}{required ? <span className="rcv-star"> *</span> : null}</strong>
        <em className={`rcv-status ${tone}`}>{status}</em>
        <span aria-hidden="true">{open ? '▾' : '›'}</span>
      </button>
      {shown ? <div className="rcv-sec-body" style={open ? undefined : { display: 'none' }}>{children}</div> : null}
    </section>
  );
}
