import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './appMode/appMode.css';
import './receive-v2.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* ignore — private mode / blocked SW */
    });
  });
}

import './design/tools.css';
import './design/bw.css';
import './appMode/ordersApp.css';
import './design/safe-v2.css';
/* After appMode/bw so phone Reports styles win the cascade (App pulls reports.css too early). */
import './reports.css';
import './design/desk.css';
import './appMode/phoneEditType.css';
