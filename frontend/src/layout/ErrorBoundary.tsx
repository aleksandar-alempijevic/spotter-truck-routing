import { Component, type ReactNode } from 'react';

interface Props {
  /** What stands in for the children once one of them has thrown while rendering. */
  fallback: ReactNode;
  children: ReactNode;
}

/** Catches what a child throws while rendering, so one part of the page failing leaves the rest. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
