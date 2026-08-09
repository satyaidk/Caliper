import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary, NoWebGL, hasWebGL } from './components/Fallback';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';

const root = createRoot(document.getElementById('root')!);

// Probe before mounting: a viewer with no GPU context has nothing to say, and
// a plain explanation beats a blank canvas and a console error.
root.render(
  <StrictMode>
    <ErrorBoundary>{hasWebGL() ? <App /> : <NoWebGL />}</ErrorBoundary>
  </StrictMode>,
);
