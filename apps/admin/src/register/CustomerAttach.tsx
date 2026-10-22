import { useEffect, useRef, useState } from 'react';
import { authErrorMessage, searchCustomersByPhone, upsertCustomer, type Customer } from '@floor/cloud';

export function formatPoints(points: number): string {
  return Number((Number(points) || 0).toFixed(1)).toString();
}

type Props = {
  customer: Customer | null;
  onAttach: (customer: Customer) => void;
  onClear: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
};

export function CustomerAttach({ customer, onAttach, onClear, disabled, autoFocus }: Props) {
  const [phone, setPhone] = useState('');
  const [hits, setHits] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signupOpen, setSignupOpen] = useState(false);
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupMarketing, setSignupMarketing] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const digits = phone.replace(/\D/g, '');

  useEffect(() => {
    if (customer) {
      setPhone(customer.phone);
      setHits([]);
      setOpen(false);
    }
  }, [customer?.id, customer?.phone]);

  useEffect(() => {
    if (customer || digits.length < 3) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      void searchCustomersByPhone(digits, 8)
        .then(rows => {
          setHits(rows);
          setOpen(true);
          setError('');
        })
        .catch(err => setError(authErrorMessage(err)));
    }, 120);
    return () => clearTimeout(t);
  }, [digits, customer]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(row: Customer) {
    onAttach(row);
    setPhone(row.phone);
    setOpen(false);
    setHits([]);
  }

  function clearCustomer() {
    onClear();
    setPhone('');
    setHits([]);
    setOpen(false);
  }

  async function createCustomer() {
    setError('');
    const name = signupName.trim();
    const email = signupEmail.trim();
    if (!name) return setError('Name is required.');
    if (!email.includes('@')) return setError('Email is required.');
    if (digits.length < 7) return setError('Enter a full phone number.');
    setBusy(true);
    try {
      const created = await upsertCustomer({ phone: digits, name, email, marketingOptIn: signupMarketing });
      onAttach(created);
      setPhone(created.phone);
      setSignupOpen(false);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const showCreate = !customer && digits.length >= 3 && hits.length === 0 && open;

  function openSignup() {
    setSignupOpen(true);
    setSignupName('');
    setSignupEmail('');
    setSignupMarketing(false);
    setOpen(false);
    setError('');
  }

  return (
    <div className="customer-block" ref={wrapRef}>
      <p className="muted">Look up by phone, or register a new account.</p>
      <div className="customer-typeahead">
        <input
          placeholder="Phone number"
          value={phone}
          disabled={disabled || Boolean(customer)}
          onChange={e => setPhone(e.target.value)}
          onFocus={() => {
            if (!customer && digits.length >= 3) setOpen(true);
          }}
          inputMode="tel"
          autoComplete="off"
          autoFocus={autoFocus}
        />
        {customer ? (
          <button type="button" className="secondary" disabled={disabled} onClick={clearCustomer}>Clear</button>
        ) : (
          <button type="button" className="secondary" disabled={disabled || digits.length < 7} onClick={openSignup}>
            Register account
          </button>
        )}
        {open && !customer && digits.length >= 3 ? (
          <div className="customer-dropdown" role="listbox">
            {hits.map(row => (
              <button key={row.id} type="button" className="customer-dropdown-hit" onClick={() => pick(row)}>
                <strong>{row.name || 'No name'}</strong>
                <span className="muted">
                  {row.phone}
                  {row.email ? ` · ${row.email}` : ''}
                  {` · ${formatPoints(row.balance)} pts`}
                </span>
              </button>
            ))}
            {showCreate ? (
              <button type="button" className="customer-dropdown-hit create" onClick={openSignup}>
                <strong>Register account</strong>
                <span className="muted">No match for {digits}</span>
              </button>
            ) : null}
            {!showCreate && hits.length === 0 ? <div className="customer-dropdown-empty muted">Searching…</div> : null}
          </div>
        ) : null}
      </div>
      {customer ? (
        <p className="muted">
          {customer.name || 'Customer'} · {formatPoints(customer.balance)} pts
          {!customer.first_purchase_discount_used ? ` · new-customer discount (${customer.signup_code || 'on account'})` : ''}
        </p>
      ) : (
        <p className="muted">Type at least 3 digits to search, or 7+ to register.</p>
      )}
      {error ? <p className="error">{error}</p> : null}

      {signupOpen ? (
        <div className="modal">
          <div className="card grid">
            <h2>New customer</h2>
            <p className="muted">Phone {digits}</p>
            <label>Name<input value={signupName} onChange={e => setSignupName(e.target.value)} autoFocus /></label>
            <label>Email<input value={signupEmail} onChange={e => setSignupEmail(e.target.value)} /></label>
            <label className="check">
              <input type="checkbox" checked={signupMarketing} onChange={e => setSignupMarketing(e.target.checked)} />
              Email store news (optional)
            </label>
            {error ? <p className="error">{error}</p> : null}
            <div className="row">
              <button type="button" className="secondary" onClick={() => setSignupOpen(false)}>Cancel</button>
              <button type="button" className="primary" disabled={busy} onClick={() => void createCustomer()}>
                {busy ? 'Saving…' : 'Create & attach'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
