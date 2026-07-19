import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopRendererApp } from './renderer/app/DesktopRendererApp';
import { createStartupCurtainController } from './renderer/startup/startup-curtain';
import './renderer/styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element was not found.');
const startupCurtain = createStartupCurtainController();
window.addEventListener('beforeunload', () => startupCurtain.dispose(), { once: true });

createRoot(root).render(
  <StrictMode>
    <DesktopRendererApp onStartupReady={() => startupCurtain.markReady()} />
  </StrictMode>
);
