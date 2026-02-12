import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AppV2 from './v2/App'
import './styles/global.css'

const params = new URLSearchParams(window.location.search);
const useLegacy = params.get('legacy') === '1' || params.get('app') === 'legacy';
const useV2 = !useLegacy;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {useV2 ? <AppV2 /> : <App />}
  </React.StrictMode>,
)
