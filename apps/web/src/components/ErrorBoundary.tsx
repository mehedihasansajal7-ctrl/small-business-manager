import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one broken screen from taking the whole app down.
 *
 * Without a boundary, an uncaught render error makes React unmount the entire
 * tree: the page goes blank and NOTHING is clickable, with no clue why. That is
 * how a single bad report turned into "the app froze". Now the failing screen
 * shows the error and a retry, and the navigation keeps working.
 */

interface Props {
  readonly children: ReactNode;
  /** Shown in the message, e.g. the screen name. */
  readonly scope?: string;
  /** Called when the user asks to try again (usually a re-render / refetch). */
  readonly onReset?: () => void;
}

interface State {
  readonly error: Error | null;
  readonly info: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept on the instance so the panel can show the component stack; also logged
    // once so it is visible in the browser console for a bug report.
    this.setState({ info: info.componentStack ?? null });
    // eslint-disable-next-line no-console
    console.error(`[${this.props.scope ?? 'screen'}] render failed:`, error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null, info: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="notice notice--error" role="alert">
        <strong>This screen hit an error.</strong>
        <p style={{ margin: '6px 0' }}>
          The rest of the app still works — use the menu to go elsewhere, or try again below.
        </p>
        <p className="mono" style={{ margin: '6px 0', fontSize: '0.85em' }}>
          {error.message}
        </p>
        <button type="button" className="btn btn--secondary" onClick={this.reset}>
          Try again
        </button>
        {info ? (
          <details style={{ marginTop: 8 }}>
            <summary>Technical detail</summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: '0.75em' }}>
              {error.stack ?? error.message}
              {info}
            </pre>
          </details>
        ) : null}
      </div>
    );
  }
}
