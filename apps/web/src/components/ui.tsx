import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useT } from '../state/AppContext';

/** Shared, accessible UI primitives (labels on every control, visible focus). */

export function Card({ title, subtitle, actions, children, className }: { readonly title?: ReactNode; readonly subtitle?: ReactNode; readonly actions?: ReactNode; readonly children: ReactNode; readonly className?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {title || actions ? (
        <header className="card__head">
          <div>
            {title ? <h2 className="card__title">{title}</h2> : null}
            {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { readonly title: ReactNode; readonly subtitle?: ReactNode; readonly actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1 className="page-head__title">{title}</h1>
        {subtitle ? <p className="page-head__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </header>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly block?: boolean;
}

export function Button({ variant = 'secondary', block, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`btn btn--${variant}${block ? ' btn--block' : ''}${className ? ` ${className}` : ''}`} {...rest} />;
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useT();
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only">{t('common.required')}</span> : null}
      </span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
}

export function TextInput({ label, value, onValueChange, hint, error, required, type = 'text', ...rest }: TextInputProps) {
  const id = useId();
  return (
    <Field label={label} {...(hint ? { hint } : {})} {...(error ? { error } : {})} {...(required ? { required } : {})}>
      <input id={id} className="input" type={type} value={value} onChange={(event: ChangeEvent<HTMLInputElement>) => onValueChange(event.target.value)} {...rest} />
    </Field>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export function SelectInput({
  label,
  value,
  onValueChange,
  options,
  hint,
  error,
  required,
  placeholder,
  disabled,
}: {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} {...(hint ? { hint } : {})} {...(error ? { error } : {})} {...(required ? { required } : {})}>
      <select id={id} className="input" value={value} onChange={(event) => onValueChange(event.target.value)} disabled={disabled}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextAreaInput({
  label,
  value,
  onValueChange,
  hint,
  error,
  required,
  rows = 3,
}: {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly rows?: number;
}) {
  const id = useId();
  return (
    <Field label={label} {...(hint ? { hint } : {})} {...(error ? { error } : {})} {...(required ? { required } : {})}>
      <textarea id={id} className="input" rows={rows} value={value} onChange={(event) => onValueChange(event.target.value)} />
    </Field>
  );
}

export function CheckboxInput({
  label,
  checked,
  onCheckedChange,
  hint,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly hint?: string;
}) {
  const id = useId();
  return (
    <div className="field field--checkbox">
      <input id={id} className="checkbox" type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />
      <label htmlFor={id} className="field__label field__label--inline">
        {label}
      </label>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted' | 'success';

export function Badge({ tone = 'muted', children }: { readonly tone?: Tone; readonly children: ReactNode }) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

export function Notice({ level = 'info', children }: { readonly level?: Tone; readonly children: ReactNode }) {
  return (
    <div className={`notice notice--${level}`} role={level === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** One line of a document total block (gross / discount / net …). */
export function TotalRow({ label, value, strong }: { readonly label: ReactNode; readonly value: ReactNode; readonly strong?: boolean }) {
  return (
    <div className={`total${strong ? ' total--strong' : ''}`}>
      <span className="total__label">{label}</span>
      <span className="total__value">{value}</span>
    </div>
  );
}

export function Totals({ children }: { readonly children: ReactNode }) {
  return <div className="totals">{children}</div>;
}

export function Tabs({ tabs, active, onChange }: { readonly tabs: readonly { readonly id: string; readonly label: string }[]; readonly active: string; readonly onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`tab${tab.id === active ? ' tab--active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer }: { readonly open: boolean; readonly title: string; readonly onClose: () => void; readonly children: ReactNode; readonly footer?: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  const { t } = useT();
  if (!open) return null;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="card__title">{title}</h2>
          <button ref={closeRef} type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function CopyButton({ text, label }: { readonly text: string; readonly label?: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={() => {
        const clipboard = navigator.clipboard;
        if (!clipboard) return;
        void clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 3_000);
        });
      }}
      aria-label={label ?? t('common.copy')}
    >
      {copied ? t('common.copied') : label ?? t('common.copy')}
    </Button>
  );
}
