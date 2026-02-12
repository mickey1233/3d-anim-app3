import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Html } from '@react-three/drei';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ModelErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ModelErrorBoundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <Html center zIndexRange={[100, 0]}>
           <div className="flex flex-col items-center justify-center p-6 bg-red-950/90 rounded-xl backdrop-blur-md border border-red-500/30 shadow-2xl max-w-sm text-center">
             <AlertTriangle className="w-10 h-10 text-red-500 mb-3" />
             <h3 className="text-lg font-bold text-red-100 mb-1">Failed to Load Model</h3>
             <p className="text-xs text-red-200/80 break-words w-full">
               {this.state.error?.message || 'Unknown error occurred'}
             </p>
             <button 
                onClick={() => this.setState({ hasError: false, error: null })}
                className="mt-4 px-4 py-2 bg-red-800 hover:bg-red-700 text-white text-xs font-bold rounded transition-colors"
             >
                RETRY
             </button>
           </div>
        </Html>
      );
    }

    return this.props.children;
  }
}
