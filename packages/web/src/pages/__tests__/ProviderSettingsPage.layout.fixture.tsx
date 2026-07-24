import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import {
  AgentType,
  PROVIDER_CAPABILITIES,
  type AppSettings,
} from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { I18nProvider } from '@/lib/i18n'
import { ProviderSettingsPage } from '../ProviderSettingsPage'
import '@/index.css'

declare global {
  interface Window {
    __PROVIDER_LAYOUT_FIXTURE_READY__?: boolean
  }
}

const providers: ProviderWithAvailability[] = [
  {
    provider: {
      id: 'codex-layout-fixture',
      name: 'Codex Provider With A Deliberately Long Display Name For Responsive Coverage',
      agentType: AgentType.CODEX,
      env: {},
      redactedEnv: {
        OPENAI_API_KEY_WITH_A_DELIBERATELY_LONG_SUFFIX_FOR_LAYOUT_COVERAGE: {
          configured: true,
          sensitive: true,
        },
      },
      config: {
        model: 'gpt-5.4-with-a-deliberately-long-model-suffix-for-layout-coverage',
        dangerouslyBypassApprovalsAndSandbox: false,
        unknownConfigKeyWithALongName: 'unknown-config-value-with-a-long-unbroken-suffix',
      },
      settings: [
        '# Provider settings layout fixture',
        'openai_base_url = "https://gateway.example.test/a/deliberately/long/provider/path/v1"',
        'model_reasoning_effort = "high"',
        'unknown_setting = "keep-this-long-unknown-setting-value-for-layout-coverage"',
      ].join('\n'),
      simplified: {
        apiBaseUrl: 'https://gateway.example.test/a/deliberately/long/provider/path/v1',
        apiKey: { configured: true, envKey: 'OPENAI_API_KEY_WITH_A_DELIBERATELY_LONG_SUFFIX_FOR_LAYOUT_COVERAGE' },
        model: 'gpt-5.4-with-a-deliberately-long-model-suffix-for-layout-coverage',
        reasoningEffort: 'high',
      },
      diagnostics: [],
      isDefault: true,
      builtIn: false,
      deletable: true,
    },
    availability: { type: 'LOGIN_DETECTED' },
  },
  {
    provider: {
      id: 'claude-layout-fixture',
      name: 'Claude Fixture',
      agentType: AgentType.CLAUDE_CODE,
      env: {},
      redactedEnv: {},
      config: {},
      settings: '',
      simplified: {
        apiBaseUrl: 'https://api.anthropic.com',
        apiKey: { configured: false, envKey: 'ANTHROPIC_API_KEY' },
      },
      diagnostics: [],
      isDefault: false,
      builtIn: false,
      deletable: true,
    },
    availability: { type: 'INSTALLATION_FOUND' },
  },
]

const appSettings: AppSettings = {
  id: 'default',
  locale: 'zh-CN',
  commitMessageProviderId: null,
  commitMessagePrompt: null,
}

const originalFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
  const url = new URL(requestUrl, window.location.origin)

  if (url.pathname === '/api/providers' && (!init?.method || init.method === 'GET')) {
    return Response.json(providers)
  }
  if (url.pathname === '/api/providers/capabilities') {
    return Response.json(PROVIDER_CAPABILITIES)
  }
  if (url.pathname === '/api/app-settings') {
    return Response.json(appSettings)
  }
  return originalFetch(input, init)
}

window.localStorage.setItem('agent-tower.locale', 'zh-CN')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Infinity },
    mutations: { retry: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <I18nProvider>
      <ProviderSettingsPage />
    </I18nProvider>
  </QueryClientProvider>,
)

window.__PROVIDER_LAYOUT_FIXTURE_READY__ = true
