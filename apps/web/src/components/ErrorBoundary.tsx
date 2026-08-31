import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Alert } from './Alert';
import { Button } from './Button';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Named in the message, so a person knows which part of the page failed. */
  readonly label: string;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

/**
 * A thrown render is the one failure React cannot report through a promise, and
 * without a boundary it unmounts the whole tree — a white page. One of these
 * wraps each route; a second will wrap each message once there are messages, so
 * that one malformed answer cannot take a conversation down with it.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept out of the interface: the message names files and component stacks,
    // which is a developer's material, not a reader's.
    // eslint-disable-next-line no-console
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex flex-col items-start gap-4 p-6">
        <Alert tone="negative" title={`${this.props.label} could not be shown`}>
          Something in this part of the page failed. The rest of the application is still working.
        </Alert>
        <Button
          variant="primary"
          onClick={() => {
            this.setState({ failed: false });
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
}
