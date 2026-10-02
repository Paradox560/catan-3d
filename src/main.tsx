import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './medieval.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Suspense
      fallback={
        <div
          role="status"
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            background: 'var(--parchment)',
            fontFamily: 'Cinzel, Georgia, serif',
          }}
        >
          Loading your island…
        </div>
      }
    >
      <App />
    </React.Suspense>
  </React.StrictMode>,
);
