import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Box, Typography, Button, Paper, Stack } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

interface Props {
  children: ReactNode;
  /** Heading shown in the fallback. */
  title?: string;
  /** When any value in this array changes, a caught error is cleared (re-render is retried). */
  resetKeys?: unknown[];
  /** Called when the boundary resets (via "Try again" or a resetKeys change). */
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

function keysChanged(a?: unknown[], b?: unknown[]): boolean {
  if (a === b) return false;
  if (!a || !b || a.length !== b.length) return true;
  return a.some((v, i) => !Object.is(v, b[i]));
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    this.setState({
      error,
      errorInfo
    });
  }

  public componentDidUpdate(prevProps: Props) {
    // Auto-recover when the surrounding context changes (e.g. tab/store switch).
    if (this.state.hasError && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  private reset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '200px',
            height: '100%',
            p: 3
          }}
        >
          <Paper
            elevation={3}
            sx={{
              p: 3,
              maxWidth: '600px',
              width: '100%',
              textAlign: 'center'
            }}
          >
            <ErrorOutlineIcon color="error" sx={{ fontSize: 48, mb: 2 }} />
            <Typography variant="h6" color="error" gutterBottom>
              {this.props.title || 'Something went wrong'}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {this.state.error?.message || 'An unexpected error occurred'}
            </Typography>
            <Stack direction="row" spacing={1} justifyContent="center">
              <Button variant="contained" onClick={this.reset}>
                Try again
              </Button>
              <Button variant="outlined" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </Stack>
            {import.meta.env.DEV && this.state.errorInfo && (
              <Box sx={{ mt: 2, textAlign: 'left' }}>
                <Typography variant="caption" component="pre" sx={{
                  whiteSpace: 'pre-wrap',
                  overflow: 'auto',
                  maxHeight: '200px',
                  p: 1,
                  bgcolor: 'background.default',
                  borderRadius: 1
                }}>
                  {this.state.errorInfo.componentStack}
                </Typography>
              </Box>
            )}
          </Paper>
        </Box>
      );
    }

    return this.props.children;
  }
}
