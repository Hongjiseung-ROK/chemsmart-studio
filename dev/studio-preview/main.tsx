import './harness.css'

import { ChemSmartWorkspace } from '@renderer/components/ChemSmartStudio/ChemSmartWorkspace'
import i18next from 'i18next'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider, initReactI18next } from 'react-i18next'

import enUs from '../../src/renderer/i18n/locales/en-us.json'
import { harness } from './mocks/ipc'
import { type ScenarioName, scenarioNames, sessionId } from './scenarios'

const parameters = new URLSearchParams(window.location.search)
const requested = parameters.get('scenario') as ScenarioName | null
harness.setScenario(requested && scenarioNames.includes(requested) ? requested : 'working')
if (parameters.get('theme') === 'dark') document.documentElement.classList.add('dark')

void i18next.use(initReactI18next).init({
  lng: 'en-US',
  fallbackLng: 'en-US',
  interpolation: { escapeValue: false },
  resources: { 'en-US': { translation: enUs } }
})

declare global {
  interface Window {
    studioHarness: typeof harness
  }
}
window.studioHarness = harness

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18next}>
      <ChemSmartWorkspace active sessionId={sessionId} />
    </I18nextProvider>
  </StrictMode>
)
