import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './MeetingApp';
import './index.css';

// PrimoraX production build entrypoint.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
