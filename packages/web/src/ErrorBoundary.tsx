import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** What crashed, shown in the fallback heading, e.g. "The graph view". */
  area: string;
  /** Advice under the error message, e.g. "Pick another model to keep working." */
  hint?: string;
  /** When this value changes, the boundary clears its error and renders children again. */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

/**
 * Catches a render error below it and shows the message in place of the
 * crashed subtree, so one broken view does not unmount the whole app and
 * leave a blank page. "Try again" re-renders the children; so does a change
 * of `resetKey` (for example, opening another model).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (!Object.is(props.resetKey, state.resetKey))
      return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.area} crashed:`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-testid="error-boundary" className="error-boundary">
        <strong>{this.props.area} crashed.</strong>
        <code>{error.message}</code>
        {this.props.hint && <p>{this.props.hint}</p>}
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
