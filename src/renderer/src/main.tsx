import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import { SearchProvider } from './hooks/useSearch'
import { LibraryProvider } from './hooks/useLibraryIndex'
import { PlayerProvider } from './components/PlayerBar'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <SearchProvider>
        <LibraryProvider>
          <PlayerProvider>
            <App />
          </PlayerProvider>
        </LibraryProvider>
      </SearchProvider>
    </I18nProvider>
  </React.StrictMode>
)
