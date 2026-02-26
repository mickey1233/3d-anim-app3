import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5274',
    headless: true,
    env: {
      AGENT_LLM_MOCK_PATH: 'tests/fixtures/agent-mock-responses.json',
      ROUTER_PROVIDER: 'agent',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
