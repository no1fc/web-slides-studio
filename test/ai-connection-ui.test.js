import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStudio } from '../src/server.js';

test('AI settings generate external-PC commands and show only real reported connection status at laptop size', { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-ai-ui-'));
  const app = await startStudio({ root, port: 0, contentPort: 0 });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(app.origin);
    await page.waitForSelector('#library:not([hidden])');
    if (!await page.evaluate(() => Boolean(window.SDAIConnection))) await page.addScriptTag({ url: app.origin + '/ai-connection.js' });
    await page.evaluate(() => window.SDAIConnection.open());
    assert.match(await page.locator('#aiConnectionStatus').innerText(), /아직 MCP가 보낸 연결 보고가 없습니다/);
    for (const platform of ['windows', 'macos', 'linux']) {
      await page.locator('#aiPlatform').selectOption(platform);
      for (const client of ['codex', 'claude']) {
        await page.locator('#aiClient').selectOption(client);
        const command = await page.locator('#aiInstallCommand').inputValue();
        assert.match(command, new RegExp('--client ' + client));
        assert.match(command, /--setup/);
        assert.match(command, /npm ci --prefix integrations\/mcp --ignore-scripts/);
        assert.ok(!/docker|npm start|--password\s|SLIDES_STUDIO_PASSWORD=/.test(command));
        assert.match(command, platform === 'windows' ? /Set-Location/ : /cd "\$HOME/);
      }
    }
    assert.match(await page.locator('#aiConnectionPrompt').inputValue(), /slides_propose_slide/);
    await page.locator('#aiClient').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'aiInstallCommand');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(async () => {
      await fetch('/api/ai-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '0.1.0', platform: 'win32', client: 'codex', checks: { server: 'ok', authentication: 'ok', tools: 'ok', workspace: 'error' } }) });
    });
    await page.getByRole('button', { name: '최근 연결 보고 다시 확인' }).click();
    await page.waitForFunction(() => document.querySelector('#aiConnectionStatus').textContent.includes('업데이트 필요'));
    const report = await page.locator('#aiConnectionStatus').innerText();
    assert.match(report, /MCP 보고 버전 0.1.0/);
    assert.match(report, /\(KST\)/);
    assert.match(report, /ZIP 작업 폴더: 문제 있음/);
    assert.match(report, /서버 접속: 확인됨/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#dialog').isVisible(), false);
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
