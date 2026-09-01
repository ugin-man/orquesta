import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createDesktopClient } from './adapters/client-factory';
import { createPreviewDesktopClient } from './testing/preview-client';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element is missing.');
const explicitPreview = new URLSearchParams(window.location.search).get('preview') === '1';
createRoot(root).render(<App
  client={explicitPreview ? createPreviewDesktopClient(window.location.search) : createDesktopClient()}
  browserPreview={explicitPreview}
/>);
