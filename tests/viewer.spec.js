import { test, expect } from '@playwright/test';
import path from 'node:path';

test('standalone Heapscape shell loads without a dump', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const health = await request.get('/api/health', { headers: { 'X-Heapscape': '1' } });
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ready' });
  await page.goto('/');
  await expect(page).toHaveTitle('Heapscape - .NET memory atlas');
  await expect(page.locator('.brand .mark')).toHaveText('H');
  await expect(page.locator('#viewport canvas')).toBeVisible();
  await expect(page.locator('#theme')).toHaveValue('prism');
  await expect(page.locator('#counts')).toHaveText('No dump loaded');
  await page.locator('#open-dump').click();
  await expect(page.locator('#dump-dialog')).toBeVisible();
  await expect(page.locator('#status')).toContainText('Ready');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dump-dialog')).toBeHidden();
  expect(errors).toEqual([]);
});

test('upload real dump, inspect graph and navigate without browser errors', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#open-dump').click();
  await expect(page.locator('#status')).toContainText('Ready');
  await page.locator('#previews').check();
  const accepted = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/api/dumps?'));
  await page.locator('#dump').setInputFiles(path.resolve('artifacts/dumps/console.dmp'));
  const response = await accepted;
  expect(response.status()).toBe(202);
  const id = (await response.headerValue('location')).split('/').pop();
  try {
  await expect(page.locator('#status')).toContainText('Loaded console.dmp', { timeout: 150000 });
  await expect(page.locator('#counts')).toContainText('captured objects');
  await page.locator('#find-toggle').click();
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await expect(page.locator('#results button').first()).toBeVisible();
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  await expect(page.locator('#details h3').first()).toHaveText('Heapscape.Fixtures.DemoNode');
  await expect(page.locator('#details')).toContainText('Outgoing');
  await page.getByRole('button', { name: 'Find one retaining path' }).click();
  await expect(page.locator('#details')).toContainText('Path from');
  await page.locator('#color').selectOption('type');
  await expect(page.locator('#heap')).toHaveCount(0);
  await page.locator('#home').click();
  await page.screenshot({ path: 'artifacts/viewer-overview.png' });
  await page.locator('#fly').click();
  await expect(page.locator('#crosshair')).toBeVisible();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(250);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Escape');
  await expect(page.locator('#crosshair')).toBeHidden();
  await page.locator('#open-dump').click();
  await page.locator('#saved .saved-job').filter({ has: page.locator(`button[data-job-id="${id}"]`) }).getByRole('button', { name: 'Remove console.dmp', exact: true }).click();
  await expect(page.locator('#status')).toContainText('removed from server storage');
  expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/dumps/${id}`, { headers: { 'X-Heapscape': '1' } });
  }
});

for (const name of ['aspnet', 'orchard']) {
  test(`render ${name} dump and recover it after a page refresh`, async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.locator('#open-dump').click();
    const accepted = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/api/dumps?'));
    await page.locator('#dump').setInputFiles(path.resolve(`artifacts/dumps/${name}.dmp`));
    const response = await accepted;
    expect(response.status()).toBe(202);
    const id = (await response.headerValue('location')).split('/').pop();
    try {
      await expect(page.locator('#status')).toContainText(`Loaded ${name}.dmp`, { timeout: 630000 });
      await expect(page.locator('#counts')).toContainText('captured objects');
      await page.reload();
      await page.locator('#open-dump').click();
      await page.locator(`#saved button[data-job-id="${id}"]`).click();
      await expect(page.locator('#status')).toContainText(`Loaded ${name}.dmp`);
      await page.locator('#color').selectOption('size');
      await expect(page.locator('#native')).toHaveCount(0);
      expect(errors).toEqual([]);
      await page.locator('#open-dump').click();
      await page.locator('#saved .saved-job').filter({ has: page.locator(`button[data-job-id="${id}"]`) }).getByRole('button', { name: `Remove ${name}.dmp`, exact: true }).click();
      await expect(page.locator('#status')).toContainText('removed from server storage');
    } finally {
      await request.delete(`/api/dumps/${id}`, { headers: { 'X-Heapscape': '1' } });
    }
  });
}

test('API rejects cross-origin access and malformed dumps explicitly', async ({ request }) => {
  expect((await request.get('/api/health')).status()).toBe(403);
  expect((await request.get('/api/health', { headers: { 'X-Heapscape': '1', Origin: 'https://example.org' } })).status()).toBe(403);
  const response = await request.post('/api/dumps?name=invalid.dmp', {
    headers: { 'X-Heapscape': '1', 'Content-Type': 'application/octet-stream' },
    data: Buffer.alloc(64),
  });
  expect(response.status()).toBe(202);
  const { id } = await response.json();
  try {
    await expect.poll(async () => {
      return (await (await request.get(`/api/dumps/${id}`, { headers: { 'X-Heapscape': '1' } })).json()).state;
    }, { timeout: 30000 }).toBe('failed');
    expect((await request.get(`/api/dumps/${id}/graph`, { headers: { 'X-Heapscape': '1' } })).status()).toBe(409);
  } finally {
    expect((await request.delete(`/api/dumps/${id}`, { headers: { 'X-Heapscape': '1' } })).status()).toBe(204);
  }
});

test('uploading another dump preserves already processed dumps in the dialog', async ({ page, request }) => {
  test.setTimeout(180000);
  const ids = [];
  try {
    await page.goto('/');
    for (const previews of [false, true]) {
      await page.locator('#open-dump').click();
      await page.locator('#previews').setChecked(previews);
      const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/dumps?'));
      await page.locator('#dump').setInputFiles(path.resolve('artifacts', 'dumps', 'console.dmp'));
      const response = await accepted;
      expect(response.status()).toBe(202);
      ids.push((await response.headerValue('location')).split('/').pop());
      await expect(page.locator('#status')).toContainText('Loaded console.dmp', { timeout: 120000 });
      await expect(page.locator('#dump-dialog')).toBeHidden();
    }
    await page.locator('#open-dump').click();
    for (const id of ids) {
      await expect(page.locator(`#saved button[data-job-id="${id}"]`)).toBeVisible();
      expect((await request.get(`/api/dumps/${id}`, { headers: { 'X-Heapscape': '1' } })).status()).toBe(200);
    }
  } finally {
    for (const id of ids) await request.delete(`/api/dumps/${id}`, { headers: { 'X-Heapscape': '1' } });
  }
});
