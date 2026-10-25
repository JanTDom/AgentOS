import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { BackendControls, RecoveryBoundary, SaveIndicator } from './PersistenceUI';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><RecoveryBoundary /><App /><SaveIndicator /><BackendControls /></StrictMode>,
);
