import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DemoAccessGate from './DemoAccessGate';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DemoAccessGate>
      <App />
    </DemoAccessGate>
  </React.StrictMode>,
);
