import { test, expect } from '@playwright/test';
import path from 'node:path';
import { createReadStream, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import * as THREE from 'three';
import { Atlas } from '../Client/scene.js';
import { indexGraph, neighborhood, retainingRoutes } from '../Client/graph.js';
import { analyzeReachability } from '../Client/reachability.js';
import { indexCards, cardEvidence, cardTableEvidence } from '../Client/cards.js';
import { gcHeapId, layout } from '../Client/spatial.js';

let server, baseUrl, fixtureName;
test.beforeAll(async () => {
  // Stream large, real snapshots over HTTP, not Chromium's size-limited DevTools pipe.
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/api/dumps') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ id: 'spatial-fixture', name: `${fixtureName}.dmp`, state: 'ready', error: null }]));
      return;
    }
    let file;
    if (pathname === '/rendering-proof') {
      file = path.resolve('tests', 'rendering-fixture.html');
      response.setHeader('Content-Type', 'text/html');
    } else if (['/test-client/rendering.js', '/test-client/semantic-materials.js', '/test-client/spatial.js',
      '/test-client/reference-bloom.js', '/test-client/root-colors.js', '/test-client/root-provenance.js',
      '/test-client/reference-arrows.js', '/test-client/finalization.js', '/test-client/region-guides.js',
      '/test-client/graph.js', '/test-client/reachability.js'].includes(pathname)) {
      file = path.resolve('Client', path.basename(pathname));
      response.setHeader('Content-Type', 'text/javascript');
    } else if (pathname.startsWith('/test-addons/') && pathname.endsWith('.js')) {
      const base = path.resolve('node_modules', 'three', 'examples', 'jsm');
      file = path.resolve(base, pathname.slice('/test-addons/'.length));
      if (!file.startsWith(`${base}${path.sep}`)) { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type', 'text/javascript');
    } else if (['/test-three/three.module.js', '/test-three/three.core.js'].includes(pathname)) {
      file = path.resolve('node_modules', 'three', 'build', path.basename(pathname));
      response.setHeader('Content-Type', 'text/javascript');
    } else if (['/test-lines/LineSegments2.js', '/test-lines/LineSegmentsGeometry.js', '/test-lines/LineMaterial.js'].includes(pathname)) {
      file = path.resolve('node_modules', 'three', 'examples', 'jsm', 'lines', path.basename(pathname));
      response.setHeader('Content-Type', 'text/javascript');
    } else if (pathname === '/api/dumps/spatial-fixture/graph') {
      file = path.resolve(`artifacts/${fixtureName}.json`);
      response.setHeader('Content-Type', 'application/json');
    } else if (pathname === '/') {
      file = path.resolve('Server/wwwroot/index.html');
      response.setHeader('Content-Type', 'text/html');
    } else if (/^\/assets\/[a-zA-Z0-9._-]+\.(js|css)$/.test(pathname)) {
      file = path.resolve(`Server/wwwroot${pathname}`);
      response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
    } else {
      response.writeHead(404); response.end(); return;
    }
    const stream = createReadStream(file);
    stream.on('error', error => response.destroy(error));
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function openSnapshot(page, name, timeout = 60000) {
  fixtureName = name;
  await page.goto(baseUrl);
  await page.locator('#open-dump').click();
  await page.getByRole('button', { name: `Open ${name}.dmp`, exact: true }).click();
  await expect(page.locator('#status')).toContainText(`Loaded ${name}.dmp`, { timeout });
  await expect(page.locator('#dump-dialog')).not.toBeVisible();
  await page.locator('#find-toggle').click();
}

async function inspectRegion(page, regionId) {
  const data = JSON.parse(readFileSync(path.resolve('artifacts', `${fixtureName}.json`), 'utf8'));
  const container = data.segments.find(segment => gcHeapId(segment) === regionId);
  const object = data.objects.find(object => object.segment === (container?.id ?? regionId));
  if (!object) throw new Error(`No captured object for contextual region inspection: ${regionId}`);
  await page.locator('#search').fill(object.address);
  await page.locator('#results button').first().click();
  await page.locator('#details .region-reference').click();
  if (container) await page.getByRole('button', { name: 'Inspect owning GC heap', exact: false }).click();
}

async function inspectFinalization(page, ready = false) {
  const data = JSON.parse(readFileSync(path.resolve('artifacts', `${fixtureName}.json`), 'utf8'));
  const index = indexGraph(data);
  const entry = data.finalizationQueues.flatMap(queue => queue.entries)
    .find(entry => entry.ready === ready && index.objects.has(entry.target));
  if (!entry) throw new Error('No captured finalization entry for the requested section.');
  const object = index.objects.get(entry.target);
  const root = index.allRoots.find(root => root.address === entry.address && root.target === entry.target && /Finaliz/.test(root.kind));
  await page.locator('#search').fill(object.address);
  await page.locator('#results button').first().click();
  await page.locator('#details button').filter({ hasText: root.kind }).filter({ hasText: entry.address }).first().click();
  await page.getByRole('button', { name: 'Inspect queue section', exact: false }).click();
}

test('size-aware console atlas: object hover, deselection, region jump, reserved mappings and flight', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openSnapshot(page, 'console');
  await page.locator('#explore-toggle').click();
  await expect(page.locator('#explore-body')).toBeHidden();
  await page.locator('#explore-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#explore-body')).toBeVisible();
  await expect(page.locator('#reserved')).not.toBeChecked();
  await expect(page.locator('#counts')).toContainText('streams');
  await page.screenshot({ path: 'artifacts/address-overview.png' });
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  const result = page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first();
  await result.click();
  await expect(page.locator('#details')).toContainText('Reachable by');
  await expect(page.locator('#object-budget-status')).toContainText('context objects');
  await expect(page.locator('#context-opacity')).toHaveCount(0);
  await page.locator('#incoming-depth').selectOption('2');
  await expect(page.locator('#neighborhood-status')).toContainText('incoming 2 hop');
  await page.locator('#outgoing-depth').selectOption('3');
  await expect(page.locator('#neighborhood-status')).toContainText('outgoing 3 hop');
  await page.getByRole('button', { name: 'Frame reference neighborhood' }).click();
  await page.screenshot({ path: 'artifacts/transitive-neighborhood.png' });
  await page.locator('#incoming-depth').selectOption('1');
  await page.locator('#outgoing-depth').selectOption('1');
  await page.getByRole('button', { name: 'Focus object [G]', exact: true }).click();
  await page.screenshot({ path: 'artifacts/object-isolated.png' });
  await page.mouse.move(800, 500);
  await expect(page.locator('#tooltip')).toContainText('Heapscape.Fixtures.DemoNode');
  await page.screenshot({ path: 'artifacts/object-pipes.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await expect(page.locator('#tooltip')).toBeHidden();
  await result.click();
  await page.locator('#home').click();
  await page.mouse.move(1000, 110);
  await expect(page.locator('#tooltip')).toBeHidden();
  await page.mouse.click(1000, 110);
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const region = snapshot.segments.find(segment => segment.kind === 'Generation1').id;
  await inspectRegion(page, region);
  await expect(page.locator('#details')).toContainText('Generation1');
  await page.locator('#controls').evaluate(element => element.scrollTop = 0);
  await page.screenshot({ path: 'artifacts/region-streams.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await page.locator('#reserved').check();
  await page.locator('#reserved').uncheck();
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await result.click();
  await page.locator('#fly').click();
  await expect(page.locator('#crosshair')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#crosshair')).toBeHidden();
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  expect(errors).toEqual([]);
});

for (const name of ['aspnet', 'orchard']) {
  test(`proportional packing and curved streams render the real ${name} snapshot`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await openSnapshot(page, name);
    await expect(page.locator('#counts')).toContainText('streams');
    await page.locator('#budget').selectOption('40000');
    await expect(page.locator('#counts')).not.toHaveText(/^0 \//);
    const data = JSON.parse(readFileSync(path.resolve('artifacts', `${name}.json`), 'utf8'));
    await inspectRegion(page, data.segments.find(segment => segment.kind === 'Generation2').id);
    await page.screenshot({ path: `artifacts/${name}-streams.png` });
    expect(errors).toEqual([]);
  });
}

test('flight hover follows motion, X clears selection, and right-click preserves it', async ({ page }) => {
  test.setTimeout(45000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openSnapshot(page, 'console');
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  await page.locator('#fly').click();
  await expect(page.locator('#crosshair')).toBeVisible();
  // No mouse movement is needed to obtain the crosshair's target.
  await expect(page.locator('#tooltip')).toContainText('Heapscape.Fixtures.DemoNode');
  await expect(page.locator('#flight-hint')).toContainText('X clears');
  await page.keyboard.press('KeyX');
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await expect(page.locator('#crosshair')).toBeVisible();
  await page.mouse.down(); await page.mouse.up();
  await expect(page.locator('#details h3')).toBeVisible();
  await page.mouse.down(); await page.mouse.up();
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await expect(page.locator('#crosshair')).toBeVisible();
  await page.mouse.down(); await page.mouse.up();
  await expect(page.locator('#details h3')).toBeVisible();
  const selectedTitle = await page.locator('#details h3').first().textContent();
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
  await expect(page.locator('#details h3').first()).toHaveText(selectedTitle);
  await expect(page.locator('#crosshair')).toBeVisible();
  const before = await page.locator('#tooltip').textContent();
  await page.keyboard.down('KeyD');
  try {
    await expect.poll(async () => await page.locator('#tooltip').isHidden() ? '<empty>' : await page.locator('#tooltip').textContent(),
      { timeout: 10000 }).not.toBe(before);
  } finally { await page.keyboard.up('KeyD'); }
  await page.screenshot({ path: 'artifacts/flight-crosshair.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#crosshair')).toBeHidden();
  expect(errors).toEqual([]);
});

test('Matrix and Neon themes keep bundled object links and always animate signals', async ({ page }) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openSnapshot(page, 'console');
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  await expect(page.locator('#roots, #link-mode')).toHaveCount(0);
  await expect(page.locator('#reference-status')).toHaveText(/^[1-9][\d,]* \/ [\d,]+ captured object references .* drawn/);
  const coverage = await page.locator('#reference-status').textContent();
  for (const theme of ['matrix', 'neon']) {
    await page.locator('#theme').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#reference-status')).toHaveText(coverage);
    await expect(page.locator('#signal-speed')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on');
    await page.screenshot({ path: `artifacts/theme-${theme}.png` });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#signals')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'on');
  await expect(page.locator('#reference-status')).toHaveText(coverage);
  await expect(page.locator('#edges')).toHaveCount(0);
  await expect(page.locator('#reference-status')).toHaveText(coverage);
  expect(errors).toEqual([]);
});

test('transparent boxes preserve pipe pixels from multiple angles and approaching arrays reveal interior links', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${baseUrl}/rendering-proof`);
  await expect.poll(() => page.evaluate(() => Boolean(window.renderingProof))).toBe(true);
  const proof = await page.evaluate(() => window.renderingProof);
  expect(errors).toEqual([]);
  for (const angle of proof.angles) {
    expect(angle.baseline[1]).toBeGreaterThan(200);
    expect(angle.oldBug[1]).toBeLessThan(100);
    expect(angle.fixed[1]).toBeGreaterThanOrEqual(angle.baseline[1] - 10);
  }
  for (const angle of proof.arrayAngles) {
    expect(angle.farArray[1], JSON.stringify(angle)).toBeLessThan(100);
    expect(angle.nearArray[1]).toBeGreaterThan(200);
    expect(angle.farAgain[1]).toBeLessThan(100);
  }
  expect(proof.widths.thickTube).toBeGreaterThan(proof.widths.thinTube + 2);
  expect(proof.widths.thickLine).toBeGreaterThan(proof.widths.thinLine + 2);
  expect(proof.surfaces.hiddenA).toBe(proof.surfaces.hiddenB);
  expect(proof.surfaces.stringA).not.toBe(proof.surfaces.stringB);
  expect(proof.surfaces.stringA).not.toBe(proof.surfaces.array);
  expect(proof.bloom.objectHalo[0]).toBeLessThanOrEqual(1);
  expect(proof.bloom.referenceHalo[0]).toBeGreaterThan(10);
  expect(proof.bloom.blockedHalo[0]).toBeLessThanOrEqual(1);
  expect(proof.bloom.glassHalo[0]).toBeGreaterThan(10);
  expect(proof.rootStripes.single).toHaveLength(1);
  expect(proof.rootStripes.multiple.length).toBeGreaterThanOrEqual(2);
  expect(proof.rootStripes.textured.length).toBeGreaterThan(proof.rootStripes.multiple.length);
  expect(proof.rootStripes.textured.filter(color => proof.rootStripes.texturedFirst.includes(color) &&
    !proof.rootStripes.texturedSecond.includes(color)).length).toBeGreaterThan(2);
  expect(proof.rootStripes.textured.filter(color => proof.rootStripes.texturedSecond.includes(color) &&
    !proof.rootStripes.texturedFirst.includes(color)).length).toBeGreaterThan(2);
  expect(proof.arrows.thick).toBeGreaterThan(proof.arrows.thin * 2);
  expect(proof.arrows.thin).toBeGreaterThan(0);
  expect(proof.arrows.internal).toBeGreaterThan(0);
  expect(proof.arrows.internal).toBeLessThan(proof.arrows.ordinary / 3);
  for (const pixels of proof.labelSides) expect(pixels).toEqual(proof.labelSides[0]);
  expect(new Set(proof.labelSides[0].map(pixel => pixel.join(','))).size).toBe(4);
  expect(errors).toEqual([]);
});

test('type colors default to the theme and a real pinned object array exposes byte-addressed reference slots', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await openSnapshot(page, 'console');
  await expect(page.locator('#color')).toHaveValue('type');
  await expect(page.locator('#color-description')).toHaveCount(0);
  await expect(page.locator('#color-legend-title, #legend')).toHaveCount(0);
  await expect(page.locator('#material-legend .material-card')).toHaveCount(6);
  await page.locator('#search').fill('System.Object[]');
  await page.locator('#results button').filter({ hasText: /Pinned/ }).first().click();
  await expect(page.locator('#details h3')).toHaveText('System.Object[]');
  await expect(page.locator('#details')).not.toContainText('array reference slots');
  await expect(page.locator('#details')).toContainText('source slot 0x');
  await page.getByRole('button', { name: 'Focus object [G]', exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'artifacts/array-interior-slots.png' });
  for (const theme of ['matrix', 'neon', 'atlas']) {
    await page.locator('#theme').selectOption(theme);
    await expect(page.locator('#color')).toHaveValue('type');
    await expect(page.locator('#details')).toContainText('source slot 0x');
  }
  expect(errors).toEqual([]);
});

test('coverage percentages update for budgets and selection while roots and faint context stay enabled', async ({ page }) => {
  await openSnapshot(page, 'console');
  await expect(page.locator('#budget option[value="15000"]')).toContainText('100.0% of walked');
  await expect(page.locator('#object-budget-status')).toContainText('(100.0%)');
  await expect(page.locator('#reference-status')).toContainText('Display capped at 6,000');
  await expect(page.locator('#reference-status')).not.toContainText('Total heap reference count is unknown');
  await page.locator('#budget').selectOption('5000');
  await expect(page.locator('#object-budget-status')).not.toContainText('(100.0%)');
  await expect(page.locator('#budget option[value="5000"]')).toHaveText(/5,000 \(up to \d+\.\d% of walked\)/);
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  await expect(page.locator('#object-budget-status')).toContainText('faint context objects');
  await expect(page.locator('#reference-status')).toContainText('Selection/depth further restricts the scope');
  await expect(page.locator('#edges')).toHaveCount(0);
  await expect(page.locator('#reference-status')).not.toContainText('(0.0%) drawn');
  await expect(page.locator('#root-status')).not.toContainText('(0.0%)');
  await page.locator('#fly').click();
  await expect(page.locator('#flight-hint')).toContainText('Space toggle slow');
  await page.keyboard.down('Space'); await page.keyboard.down('KeyW');
  await page.waitForTimeout(150);
  await page.keyboard.up('KeyW'); await page.keyboard.up('Space');
  await expect(page.locator('#crosshair')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('sampled Orchard coverage never equates captured references with the total heap graph', async ({ page }) => {
  await openSnapshot(page, 'orchard');
  await expect(page.locator('#object-budget-status')).toContainText('Analysis sampled the heap');
  await expect(page.locator('#reference-status')).toContainText('Total heap reference count is unknown');
  await expect(page.locator('#reference-status')).toContainText('captured object references');
  await expect(page.locator('#budget option[value="15000"]')).not.toContainText('100.0%');
  await page.screenshot({ path: 'artifacts/object-reference-coverage.png' });
});

function fullSnapshotCounts(name) {
  const data = JSON.parse(readFileSync(path.resolve('artifacts', `${name}.json`), 'utf8'));
  const ids = new Set(data.objects.map(object => object.id));
  return {
    objects: data.objects.length, references: data.edges.length, roots: indexGraph(data).allRoots.length,
    eligibleReferences: data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).length,
    eligibleRoots: indexGraph(data).allRoots.filter(root => ids.has(root.target)).length,
    partial: data.objectsTruncated || data.edgesTruncated,
  };
}

for (const name of ['console', 'aspnet', 'orchard']) {
  test(`all-captured controls render every eligible object and reference in the real ${name} graph`, async ({ page }) => {
    test.setTimeout(180000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const expected = fullSnapshotCounts(name);
    await openSnapshot(page, name);
    await page.locator('#theme').selectOption('atlas');
    await page.locator('#budget').selectOption('all');
    await expect(page.locator('#object-budget-status')).toContainText(`100.0% of ${expected.objects.toLocaleString()} captured`, { timeout: 60000 });
    await page.locator('#reference-budget').selectOption('all');
    await expect(page.locator('#reference-status')).toContainText(
      `${expected.eligibleReferences.toLocaleString()} / ${expected.references.toLocaleString()} captured object references`, { timeout: 60000 });
    await expect(page.locator('#reference-status')).toContainText(`100.0% of ${expected.eligibleReferences.toLocaleString()} eligible`);
    await expect(page.locator('#reference-status')).not.toContainText('Display capped at 6,000');
    await expect(page.locator('#root-status')).toContainText(
      `${expected.eligibleRoots.toLocaleString()} / ${expected.roots.toLocaleString()} root/handle/queue source records`);
    await expect(page.locator('#full-display-warning')).not.toHaveAttribute('hidden', '');
    if (expected.partial) await expect(page.locator('#reference-status')).toContainText('Total heap reference count is unknown');
    await page.screenshot({ path: `artifacts/all-captured-${name}.png` });
    if (name === 'console') {
      await expect(page.locator('#edges')).toHaveCount(0);
      await expect(page.locator('#reference-status')).toContainText('All eligible links are represented');
      await expect(page.locator('#heap')).toHaveCount(0);
    }
    await page.locator('#reference-budget').selectOption('6000');
    await expect(page.locator('#reference-status')).toContainText('Display capped at 6,000');
    await page.locator('#budget').selectOption('15000');
    await expect(page.locator('#full-display-warning')).toBeHidden();
    expect(errors).toEqual([]);
  });
}

function arraySiteClickPoints() {
  const data = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const array = data.objects.find(object => object.type === 'System.Object[]' && object.generation === 'Pinned');
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = [];
  view.label = () => {}; view.flight = { isLocked: false }; view.keys = new Set();
  view.camera = new THREE.PerspectiveCamera(55, 1.6, 0.1, 100000);
  view.orbit = { target: new THREE.Vector3() }; view.raycaster = new THREE.Raycaster();
  globalThis.innerWidth = 1600; globalThis.innerHeight = 1000;
  view.show(data, indexGraph(data), {
    budget: 15000, referenceBudget: '6000', heap: 'all', color: 'type', edges: true, roots: true,
    native: true, isolate: true, contextOpacity: 0.05, depth: 1, physical: true, theme: 'prism',
  }, array.id);
  view.focus(view.layout.objectPosition(array)); view.camera.updateMatrixWorld();
  const result = {};
  for (const item of view.siteItems.values()) {
    if (item.kind === 'slot' && item.value.edge.source !== array.id) continue;
    if (item.kind === 'root' && view.layout.roots.get(item.value.id).ownerObject !== array.id) continue;
    const projected = new THREE.Vector3(...item.position).project(view.camera);
    const x = (projected.x + 1) * 800, y = (1 - projected.y) * 500;
    if (x < 325 || x > 1230 || y < 110 || y > 870) continue;
    const ordinary = view.pick({ clientX: x, clientY: y });
    const modified = view.pick({ clientX: x, clientY: y, ctrlKey: true });
    if (ordinary?.kind !== 'object' || ordinary.value.id !== array.id || modified?.key !== item.key) continue;
    result[item.kind] ??= { x, y, address: item.value.address, rootKind: item.value.kind };
    if (result.slot && result.root) break;
  }
  view.disposeContent();
  if (!result.slot || !result.root) throw new Error('No unambiguous real root and slot could be targeted through the pinned array.');
  return result;
}

test('Ctrl-click selects one shaded root or array slot through the real pinned array shell', async ({ page }) => {
  test.setTimeout(60000);
  const points = arraySiteClickPoints(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await openSnapshot(page, 'console');
  await page.locator('#search').fill('System.Object[]');
  const arrayResult = page.locator('#results button').filter({ hasText: /Pinned/ }).first();
  await arrayResult.click();
  await page.keyboard.down('KeyR');
  await page.mouse.click(points.slot.x, points.slot.y);
  await page.keyboard.up('KeyR');
  await expect(page.locator('#details h3').first()).toHaveText('Array reference slot');
  await expect(page.locator('#details')).toContainText(points.slot.address);
  await expect(page.locator('#reference-status')).toHaveText(/^1 \/ .*captured object references/);
  await expect(page.locator('#root-status')).toHaveText(/^0 \/ /);
  await expect(page.locator('#neighborhood-status')).toContainText('Only its connection is highlighted');
  await expect(page.locator('#incoming-depth, #outgoing-depth')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/single-array-slot.png' });
  await page.keyboard.down('ControlLeft');
  await page.mouse.click(points.slot.x, points.slot.y);
  await page.keyboard.up('ControlLeft');
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await expect(page.locator('#incoming-depth, #outgoing-depth')).toHaveCount(0);
  await arrayResult.click();
  await page.keyboard.down('ControlLeft');
  await page.mouse.click(points.root.x, points.root.y);
  await page.keyboard.up('ControlLeft');
  await expect(page.locator('#details h3').first()).toHaveText(`${points.root.rootKind} root slot`);
  await expect(page.locator('#details')).toContainText(points.root.address);
  await expect(page.locator('#root-status')).toHaveText(/^1 \/ /);
  await expect(page.locator('#reference-status')).toHaveText(/^0 \/ .*captured object references/);
  await page.screenshot({ path: 'artifacts/single-root-site.png' });
  await page.keyboard.press('KeyX');
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await arrayResult.click();
  await page.locator('#details button').filter({ hasText: 'source slot' }).first().click({ modifiers: ['Control'] });
  await expect(page.locator('#details h3').first()).toHaveText('Array reference slot');
  expect(errors).toEqual([]);
});

test('Space toggles slow flight, Shift temporarily overrides it, and F preserves the chosen mode', async ({ page }) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await openSnapshot(page, 'console');
  const coverage = await page.locator('#reference-status').textContent();
  await expect(page.locator('#connection-width')).toHaveCount(0);
  await expect(page.locator('#reference-status')).toHaveText(coverage);
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  await page.keyboard.press('KeyF');
  await expect(page.locator('#crosshair')).toBeVisible();
  await page.keyboard.press('KeyG');
  await expect(page.locator('#crosshair')).toBeVisible();
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'normal');
  await expect(page.locator('#flight-hint')).toContainText('Space toggle slow');
  await page.keyboard.down('Space');
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'slow');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'slow');
  await page.keyboard.down('ShiftLeft');
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'fast');
  await page.keyboard.up('ShiftLeft');
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'slow');
  await page.keyboard.press('Space');
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'normal');
  await page.keyboard.down('ShiftRight');
  await page.keyboard.press('Space');
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'fast');
  await page.keyboard.up('ShiftRight');
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'slow');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(150);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyF');
  await expect(page.locator('#crosshair')).toBeHidden();
  await expect(page.locator('#details h3').first()).toHaveText('Heapscape.Fixtures.DemoNode');
  await page.keyboard.press('KeyF');
  await expect(page.locator('#crosshair')).toBeVisible();
  await expect(page.locator('#flight-hint')).toHaveAttribute('data-speed', 'slow');
  await page.keyboard.press('KeyF');
  await expect(page.locator('#crosshair')).toBeHidden();
  await page.getByRole('button', { name: 'Frame reference neighborhood' }).click();
  await page.screenshot({ path: 'artifacts/nearest-face-routing.png' });
  expect(errors).toEqual([]);
});

test('F enters flight directly from panel controls without clearing GC highlighting or object selection', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openSnapshot(page, 'console');
  const flyFrom = async control => {
    await expect(control).toBeFocused();
    const status = await page.locator('#reachability-status').textContent();
    const counts = await page.locator('#counts').textContent();
    const details = await page.locator('#details').textContent();
    await page.keyboard.press('f');
    await expect(page.locator('#crosshair')).toBeVisible();
    await expect(page.locator('#viewport canvas')).toBeFocused();
    expect(await page.evaluate(() => document.pointerLockElement === document.querySelector('#viewport canvas'))).toBe(true);
    await expect(page.locator('#unreachable')).toBeChecked();
    await expect(page.locator('#reachability-status')).toHaveText(status);
    await expect(page.locator('#counts')).toHaveText(counts);
    await expect(page.locator('#details')).toHaveText(details);
    await page.keyboard.press('f');
    await expect(page.locator('#crosshair')).toBeHidden();
    await expect(page.locator('#unreachable')).toBeChecked();
  };
  await page.locator('#unreachable').check();
  await flyFrom(page.locator('#unreachable'));
  await page.locator('#highlight-state').selectOption('reachable');
  await page.locator('#highlight-state').focus();
  await flyFrom(page.locator('#highlight-state'));
  await page.locator('#theme').focus();
  await flyFrom(page.locator('#theme'));
  await page.locator('#search').focus();
  await page.keyboard.press('f');
  await expect(page.locator('#search')).toHaveValue('f');
  await expect(page.locator('#crosshair')).toBeHidden();
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  await page.locator('#budget').focus();
  await flyFrom(page.locator('#budget'));
  await expect(page.locator('#details h3').first()).toHaveText('Heapscape.Fixtures.DemoNode');
  expect(errors).toEqual([]);
});

test('simplified controls use a dump dialog, fixed defaults, folded search and a bottom-right legend', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  fixtureName = 'console';
  await page.goto(baseUrl);
  await expect(page).toHaveTitle('Heapscape - .NET memory atlas');
  await expect(page.locator('header .brand')).toContainText('Heapscape');
  await expect(page.locator('header .mark')).toHaveText('H');
  await expect(page.locator('#theme')).toHaveValue('prism');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'prism');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'on');
  await expect(page.locator('#find-body')).toBeHidden();
  await expect(page.locator('#legend-body')).toBeHidden();
  await expect(page.locator('#controls p, #gc-analysis p, #controls #saved, #controls #previews')).toHaveCount(0);
  await expect(page.locator('#heap, #signals, #connection-width, #physical-layout, #link-mode, #context-opacity, #roots, #finalization, #native, #prism-bloom, #edges, #isolate, #cards')).toHaveCount(0);
  await page.locator('#open-dump').click();
  await expect(page.locator('#dump-dialog')).toBeVisible();
  await expect(page.locator('#dump-dialog #previews')).toBeVisible();
  await page.getByRole('button', { name: 'Open console.dmp', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Loaded console.dmp', { timeout: 60000 });
  await expect(page.locator('#dump-dialog')).toBeHidden();
  await expect(page.locator('#find-body')).toBeHidden();
  await expect(page.locator('#region, #signal-speed, #region-dimensions')).toHaveCount(0);
  await page.locator('#legend-toggle').click();
  await expect(page.locator('#material-legend .material-card')).toHaveCount(6);
  await expect(page.locator('#legend-panel #material-legend')).toBeVisible();
  await expect(page.locator('#legend, #link-legend, #color-legend-title')).toHaveCount(0);
  await page.locator('#color').selectOption('reachability');
  await expect(page.locator('#material-legend .material-card')).toHaveCount(6);
  await page.locator('#color').selectOption('size');
  await expect(page.locator('#legend-body h2')).toHaveText('Memory materials');
  await page.locator('#color').selectOption('type');
  await page.screenshot({ path: 'artifacts/simplified-viewer-panels.png' });
  const legend = await page.locator('#legend-panel').boundingBox(), inspector = await page.locator('#inspector').boundingBox();
  expect(legend.y).toBeGreaterThanOrEqual(inspector.y + inspector.height);
  await page.locator('#find-toggle').click();
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  const selected = await page.locator('#details').textContent();
  await page.locator('#open-dump').click();
  await page.locator('#previews').check();
  await page.keyboard.press('f');
  await expect(page.locator('#crosshair')).toBeHidden();
  await page.screenshot({ path: 'artifacts/memory-dump-dialog.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#dump-dialog')).toBeHidden();
  await expect(page.locator('#details')).toHaveText(selected);
  await page.locator('#open-dump').click();
  await page.locator('#close-dump').click();
  await expect(page.locator('#details')).toHaveText(selected);
  expect(errors).toEqual([]);
});

test('compact object inspection pairs essential facts and keeps highlight scope out of normal browsing', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const analysis = analyzeReachability(snapshot, indexGraph(snapshot));
  const live = snapshot.objects.find(object => object.type === 'Heapscape.Fixtures.DemoNode' && analysis.objects.get(object.id).rootMasks[2]);
  const dead = snapshot.objects.find(object => analysis.objects.get(object.id).state === 'unreachable');
  await openSnapshot(page, 'console');
  await expect(page.locator('#edges, #isolate, #cards, #inspector > h2')).toHaveCount(0);
  await expect(page.locator('#highlight-options')).toBeHidden();
  await expect(page.locator('#gc-generation')).toBeDisabled();
  await expect(page.locator('#card-status')).toContainText('card cells shown');
  await page.locator('#search').fill(live.address);
  await page.locator('#results button').first().click();
  const facts = page.locator('#details .paired-facts .fact');
  await expect(facts).toHaveCount(4);
  await expect(facts.nth(0)).toContainText(live.address);
  await expect(facts.nth(1)).toContainText(live.size.toLocaleString());
  await expect(facts.nth(2)).toContainText(live.generation.replace('Generation', 'Gen '));
  await expect(facts.nth(3)).toContainText('Region ');
  const rectangles = await facts.evaluateAll(elements => elements.map(element => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y })));
  expect(rectangles[0].y).toBe(rectangles[1].y);
  expect(rectangles[2].y).toBe(rectangles[3].y);
  expect(rectangles[1].x).toBeGreaterThan(rectangles[0].x);
  const removed = ['segment offset', 'size encoding', 'registered finalizable', 'prism surface', 'texture basis',
    'preview contribution', 'array reference slots', 'array shell', 'gen 0 collection', 'gen 1 collection', 'gen 2 collection', 'retention-source types'];
  const keys = (await page.locator('#details dt').allTextContents()).map(key => key.toLowerCase());
  expect(keys.filter(key => removed.includes(key))).toEqual([]);
  await expect(page.locator('#details .reachable-types li').first()).toBeVisible();
  await expect(page.locator('#details .object-reachability')).toContainText('Reachable by');
  await page.locator('#legend-toggle').click();
  await expect(page.locator('#legend-body h2')).toHaveText('Memory materials');
  await expect(page.locator('#legend, #link-legend, #color-legend-title')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/compact-object-inspector.png' });
  await page.locator('#unreachable').check();
  await expect(page.locator('#highlight-options')).toBeVisible();
  await expect(page.locator('#gc-generation')).toBeEnabled();
  await page.locator('#gc-generation').selectOption('0');
  await page.locator('#unreachable').uncheck();
  await expect(page.locator('#highlight-options')).toBeHidden();
  await expect(page.locator('#reachability-status')).toContainText('Gen 2:');
  await page.locator('#search').fill(dead.address);
  await page.locator('#results button').first().click();
  await expect(page.locator('#details .object-reachability')).toContainText('Not reachable');
  await page.screenshot({ path: 'artifacts/not-reachable-inspector.png' });
  expect(errors).toEqual([]);
});

test('floor labels keep real byte spans without dimension arrows or a global region picker', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openSnapshot(page, 'console');
  await expect(page.locator('#floor-labels')).toHaveCount(0);
  await expect(page.locator('#region-dimensions, #region')).toHaveCount(0);
  await expect(page.locator('#topology-description')).toHaveCount(0);
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  await inspectRegion(page, snapshot.segments.find(segment => segment.kind === 'Generation1').id);
  await expect(page.locator('#details')).not.toContainText('equivalent cubes');
  await expect(page.locator('#details')).toContainText('region address span');
  await expect(page.locator('#details')).toContainText('X/Z reset when wrapping');
  await page.locator('#controls').evaluate(element => element.scrollTop = 0);
  await page.screenshot({ path: 'artifacts/region-floor-labels-dimensions.png' });
  await expect(page.locator('#physical-layout')).toHaveCount(0);
  await expect(page.locator('#details')).toContainText('physical unit');
  await page.screenshot({ path: 'artifacts/physical-floor-labels-dimensions.png' });
  await page.locator('#theme').selectOption('prism');
  await page.screenshot({ path: 'artifacts/prism-floor-labels-dimensions.png' });
  await page.locator('#search').fill('System.Object[]');
  await page.locator('#results button').filter({ hasText: /Pinned/ }).first().click();
  await page.locator('#details button').filter({ hasText: 'source slot' }).first().click({ modifiers: ['Control'] });
  await expect(page.locator('#details h3').first()).toHaveText('Array reference slot');
  await expect(page.locator('#reference-status')).toHaveText(/^1 \/ /);
  await page.mouse.move(1100, 100);
  await page.screenshot({ path: 'artifacts/small-internal-slot-arrow.png' });
  expect(errors).toEqual([]);
});

test('Prism renders semantic crystal surfaces and reference bloom without changing captured data', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSnapshot(page, 'console');
  await page.locator('#search').fill('System.Object[]');
  await page.locator('#results button').filter({ hasText: /Pinned/ }).first().click();
  const coverage = await page.locator('#reference-status').textContent();
  await page.locator('#theme').selectOption('prism');
  await page.locator('#legend-toggle').click();
  await expect(page.locator('#material-legend-section')).toBeVisible();
  await expect(page.locator('#material-legend .material-card')).toHaveCount(6);
  await expect(page.locator('#material-legend [data-material="native"]')).toContainText('plain amber');
  await expect(page.locator('#prism-bloom')).toHaveCount(0);
  await expect(page.locator('#material-legend')).toContainText('luminous cell grid');
  await expect(page.locator('#details')).toContainText('array length:');
  await expect(page.locator('#reference-status')).toHaveText(coverage);
  await page.getByRole('button', { name: 'Focus object [G]', exact: true }).click();
  await page.screenshot({ path: 'artifacts/prism-array-material.png' });
  await expect(page.locator('#reference-status')).toHaveText(coverage);
  await page.getByRole('button', { name: 'Frame reference neighborhood' }).click();
  await page.screenshot({ path: 'artifacts/prism-reference-glow.png' });
  await page.locator('#search').fill('mature-0000');
  await expect.poll(async () => (await page.locator('#find-panel').boundingBox()).height).toBeGreaterThan(200);
  await page.locator('#results button').filter({ hasText: /^System\.String\s*0x/ }).first().click();
  await expect(page.locator('#details')).toContainText('mature-0000');
  await page.screenshot({ path: 'artifacts/prism-string-material.png' });
  await page.locator('#theme').selectOption('atlas');
  await expect(page.locator('#material-legend-section')).toBeHidden();
  await expect(page.locator('#details')).not.toContainText('Prism surface');
  await page.locator('#theme').selectOption('prism');
  await expect(page.locator('#details')).not.toContainText('Prism surface');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: 'artifacts/prism-resized.png' });
  expect(errors).toEqual([]);
});

test('Prism omits preview and texture diagnostics when string contents were not captured', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  snapshot.previewsIncluded = false;
  for (const object of snapshot.objects) object.preview = null;
  await page.route('**/api/dumps/spatial-fixture/graph', route => route.fulfill({ json: snapshot }));
  await openSnapshot(page, 'console');
  await page.locator('#search').fill('System.String');
  await page.locator('#results button').filter({ hasText: /^System\.String\s*0x/ }).first().click();
  await page.locator('#theme').selectOption('prism');
  await expect(page.locator('#details')).not.toContainText('texture basis');
  await expect(page.locator('#details dt')).not.toContainText(['preview', 'preview contribution', 'Prism surface']);
  await page.locator('#theme').selectOption('neon');
  await expect(page.locator('#material-legend-section')).toBeHidden();
  expect(errors).toEqual([]);
});

test('right-drag pans the scene without clearing the selected object', async ({ page }) => {
  await openSnapshot(page, 'console');
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  const details = await page.locator('#details').textContent();
  await page.mouse.move(800, 500);
  await expect(page.locator('#tooltip')).toContainText('Heapscape.Fixtures.DemoNode');
  const before = await page.locator('#tooltip').textContent();
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(1000, 620, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('#details')).toHaveText(details);
  await page.waitForTimeout(150);
  await page.mouse.move(800, 500);
  await expect.poll(async () => await page.locator('#tooltip').isHidden() ? '<empty>' : await page.locator('#tooltip').textContent()).not.toBe(before);
  await expect(page.locator('#details h3').first()).toHaveText('Heapscape.Fixtures.DemoNode');
});

test('Find object(s) is independent, foldable, and selects all matches beyond the list preview', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const expected = snapshot.objects.filter(object =>
    [object.type, object.address, object.preview ?? ''].some(value => value.toLowerCase().includes('heapscape.fixtures.demonode'))).length;
  expect(expected).toBeGreaterThan(40);
  await openSnapshot(page, 'console');
  await expect(page.locator('#coverage')).toHaveCount(0);
  await expect(page.locator('#controls #search')).toHaveCount(0);
  await expect(page.locator('#find-panel #search')).toBeVisible();
  await page.locator('#explore-toggle').click();
  await expect(page.locator('#explore-body')).toBeHidden();
  await expect(page.locator('#find-panel #search')).toBeVisible();
  await page.locator('#find-toggle').click();
  await expect(page.locator('#find-body')).toBeHidden();
  await page.locator('#find-toggle').click();
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await expect(page.locator('#results button')).toHaveCount(40);
  await expect(page.locator('#select-matches')).toHaveText(`Select all ${expected.toLocaleString()} results`);
  await page.locator('#select-matches').click();
  await expect(page.locator('#details h3').first()).toHaveText(`${expected.toLocaleString()} selected objects`);
  await expect(page.locator('#status')).toContainText(`Selected all ${expected.toLocaleString()}`);
  await expect(page.locator('#neighborhood-status')).toContainText(`${expected.toLocaleString()} rendered`);
  await page.screenshot({ path: 'artifacts/find-all-objects.png' });
  await page.locator('#results button').first().click();
  await expect(page.locator('#details h3').first()).not.toHaveText(`${expected.toLocaleString()} selected objects`);
  await page.locator('#explore-toggle').click();
  await page.locator('#budget').selectOption('5000');
  await page.locator('#search').fill('0x');
  await expect(page.locator('#select-matches')).toHaveText(`Select all ${snapshot.objects.length.toLocaleString()} results`);
  await page.locator('#select-matches').click();
  await expect(page.locator('#budget')).toHaveValue('all');
  await expect(page.locator('#neighborhood-status')).toContainText(`${snapshot.objects.length.toLocaleString()} rendered`);
  await expect(page.locator('#status')).toContainText('Object budget raised to All captured');
  await page.locator('#search').fill('nothing-matches-this-query');
  await expect(page.locator('#select-matches')).toBeDisabled();
  await page.locator('#deselect').click();
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await page.locator('#analysis-notes summary').click();
  await expect(page.locator('#warnings')).toContainText('visual gutters');
  expect(errors).toEqual([]);
});

test('real ClrMD free ranges remain visible as reserved region gaps and can be inspected', async ({ page }) => {
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  expect(snapshot.freeRangesIncluded).toBe(true);
  const largest = [...snapshot.freeRanges].sort((a, b) => b.size - a.size)[0];
  await openSnapshot(page, 'console');
  await expect(page.locator('#gap-status')).toContainText('confirmed GC free space');
  await expect(page.locator('#gap-status')).not.toContainText('older snapshot');
  await inspectRegion(page, largest.segment);
  await expect(page.locator('#details')).toContainText('confirmed free bytes');
  await page.locator('#details button').filter({ hasText: 'GC free:' }).filter({ hasText: largest.start }).first().click();
  await expect(page.locator('#details h3').first()).toHaveText('Confirmed GC free range');
  await expect(page.locator('#details')).toContainText(largest.start);
  await expect(page.locator('#details')).toContainText(String(largest.size));
  await page.getByRole('button', { name: 'Frame this gap', exact: true }).click();
  await page.screenshot({ path: 'artifacts/real-gc-free-range.png' });
  await expect(page.locator('#gaps')).toHaveCount(0);
  await expect(page.locator('#gap-status')).toContainText('solid gray');
});

test('legacy snapshots preserve address gaps without falsely declaring them GC free', async ({ page }) => {
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  snapshot.schemaVersion = 1;
  delete snapshot.freeRanges; delete snapshot.freeRangesIncluded;
  await page.route('**/api/dumps/spatial-fixture/graph', route => route.fulfill({ json: snapshot }));
  await openSnapshot(page, 'console');
  await expect(page.locator('#gap-status')).toContainText('0 B confirmed GC free space');
  await expect(page.locator('#gap-status')).toContainText('older snapshot has no free-block ranges');
});

for (const name of ['console', 'aspnet', 'orchard']) {
  test(`physical organization is always enabled and preserves selection and graph coverage for ${name}`, async ({ page }) => {
    test.setTimeout(120000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', `${name}.json`), 'utf8'));
    const expectedHeaps = new Set(snapshot.segments.map(segment => `${segment.runtime}:${segment.heap}`)).size;
    const object = snapshot.objects.find(object => !object.type.endsWith('[]'));
    await openSnapshot(page, name);
    await expect(page.locator('#physical-layout')).toHaveCount(0);
    await expect(page.locator('#region')).toHaveCount(0);
    await page.locator('#search').fill(object.address);
    await page.locator('#results button').first().click();
    await expect(page.locator('#details h3').first()).toHaveText(object.type);
    const coverage = await page.locator('#reference-status').textContent();
    await expect(page.locator('#physical-layout-status')).toContainText(`${snapshot.segments.length} reported regions/segments in ${expectedHeaps} GC-heap containers`);
    await expect(page.locator('#details .paired-facts')).toContainText('Region ');
    await expect(page.locator('#details')).toContainText(object.address);
    await expect(page.locator('#reference-status')).toHaveText(coverage);
    await expect(page.locator('#details .region-reference')).toHaveAttribute('data-region-id', object.segment);
    await page.locator('#theme').selectOption('atlas');
    await expect(page.locator('#details .paired-facts')).toContainText('Region ');
    await expect(page.locator('#details')).toContainText(object.address);
    await expect(page.locator('#reference-status')).toHaveText(coverage);
    await inspectRegion(page, gcHeapId(snapshot.segments.find(segment => segment.id === object.segment)));
    await expect(page.locator('#details')).toContainText('not an additional allocation or one contiguous address range');
    await expect(page.locator('#details h3').first()).toHaveText(/^Heap \d+$/);
    await page.locator('#controls').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `artifacts/physical-${name}.png` });
    await expect(page.locator('#details button').filter({ hasText: /^Region \d+/ }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('top-level reachability overlay reports verified collection candidates and card-table pointers', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const analysis = analyzeReachability(snapshot, indexGraph(snapshot));
  expect(analysis.complete).toBe(true);
  const unreachable = snapshot.objects.find(object => analysis.objects.get(object.id).earliest === 0);
  expect(unreachable).toBeTruthy();
  await openSnapshot(page, 'console');
  await expect(page.locator('#unreachable')).not.toBeChecked();
  await page.locator('#explore-toggle').click();
  await expect(page.locator('#unreachable')).toBeVisible();
  await page.locator('#unreachable').check();
  await expect(page.locator('#reachability-status')).toContainText('Complete verified captured graph');
  await expect(page.locator('#reachability-status')).toContainText(`${analysis.collections[0].unreachable.toLocaleString()} unreachable`);
  await page.locator('#gc-generation').selectOption('2');
  const full = analysis.collections[2];
  expect(full.reachable + full.unreachable + full.outside).toBe(snapshot.objects.length);
  expect(full.unknown).toBe(0);
  await expect(page.locator('#reachability-status')).toContainText(`Showing ${full.unreachable.toLocaleString()} of ${full.unreachable.toLocaleString()} unreachable matches`);
  await page.locator('#highlight-state').selectOption('reachable');
  await expect(page.locator('#reachability-status')).toContainText(`Showing ${full.reachable.toLocaleString()} of ${full.reachable.toLocaleString()} reachable matches`);
  await page.locator('#highlight-state').selectOption('unreachable');
  await page.locator('#gc-generation').selectOption('0');
  await expect(page.locator('#reachability-status')).toContainText('Gen 0:');
  await page.locator('#search').fill(unreachable.address);
  await page.locator('#results button').first().click();
  await expect(page.locator('#details .object-reachability')).toContainText('Not reachable');
  await expect(page.locator('#details')).not.toContainText('Gen 0 collection');
  await page.screenshot({ path: 'artifacts/unreachable-console.png' });
  await page.locator('#explore-toggle').click();
  await page.locator('#theme').selectOption('prism');
  await expect(page.locator('#details .object-reachability')).toContainText('Not reachable');
  await expect(page.locator('#reachability-status')).toContainText(`${analysis.collections[0].unreachable.toLocaleString()} unreachable`);
  await page.locator('#theme').selectOption('atlas');
  await page.locator('#unreachable').uncheck();
  await expect(page.locator('#details')).not.toContainText('GC reachability');
  await inspectRegion(page, snapshot.segments[0].id);
  await expect(page.locator('#details')).toContainText('card-table indexing base');
  await expect(page.locator('#details')).toContainText(snapshot.gcHeaps[0].cardTable);
  await expect(page.locator('#details')).toContainText('card-table indexing base');
  expect(errors).toEqual([]);
});

test('sampled Orchard reachability stays unknown instead of labeling missing paths collectible', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'orchard.json'), 'utf8'));
  const analysis = analyzeReachability(snapshot, indexGraph(snapshot)), full = analysis.collections[2];
  await openSnapshot(page, 'orchard');
  const overview = await page.locator('#counts').textContent();
  await expect(page.locator('#reachability-capture')).toContainText(`Captured ${snapshot.objects.length.toLocaleString()} / ${snapshot.objectsWalked.toLocaleString()} objects`);
  await expect(page.locator('#reachability-capture')).toContainText('Unreachable unavailable');
  await page.locator('#unreachable').check();
  await expect(page.locator('#reachability-status')).toContainText('unknown');
  await expect(page.locator('#reachability-status')).toContainText('Missing paths are not proof of death');
  await expect(page.locator('#reachability-status')).not.toContainText('Complete verified captured graph');
  await expect(page.locator('#counts')).toHaveText(overview);
  await expect(page.locator('#reachability-status')).toContainText('the overview remains visible');
  await expect(page.locator('#highlight-state option[value="unreachable"]')).toHaveText('Unreachable (unavailable)');
  await page.locator('#gc-generation').selectOption('2');
  await expect(page.locator('#reachability-status')).toContainText('captured object graph is sampled');
  await expect(page.locator('#reachability-status')).toContainText(`${full.outside.toLocaleString()} outside this collection (frozen / permanent)`);
  await page.locator('#highlight-state').selectOption('reachable');
  await expect(page.locator('#reachability-status')).toContainText(`Showing ${full.reachable.toLocaleString()} of ${full.reachable.toLocaleString()} reachable matches`);
  await page.locator('#highlight-state').selectOption('unknown');
  await expect(page.locator('#reachability-status')).toContainText(`Showing 15,000 of ${full.unknown.toLocaleString()} unknown matches`);
  await expect(page.locator('#neighborhood-status')).toContainText('No graph expansion');
  await page.locator('#budget').selectOption('5000');
  await expect(page.locator('#reachability-status')).toContainText(`Showing 5,000 of ${full.unknown.toLocaleString()} unknown matches`);
  await expect(page.locator('#reachability-status')).toContainText('not expanded from one object');
  await expect(page.locator('#gc-analysis #reachability-capture')).toHaveCount(0);
  await page.locator('#analysis-notes').evaluate(element => element.open = true);
  await page.locator('#reachability-capture').scrollIntoViewIfNeeded();
  await expect(page.locator('#reachability-capture')).toBeVisible();
  await page.screenshot({ path: 'artifacts/orchard-unknown-highlight.png' });
  expect(errors).toEqual([]);
});

test('complete Orchard capture loads past the JSON string limit and classifies the whole collectible heap', async ({ page }) => {
  test.skip(!existsSync(path.resolve('artifacts', 'orchard-full.json')), 'Generate an uncapped Orchard analysis first.');
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('Renderer process crashed'));
  await openSnapshot(page, 'orchard-full', 180000);
  await expect(page.locator('#reachability-capture')).toContainText('(100.0%). Verified graph.');
  const capture = (await page.locator('#reachability-capture').textContent()).match(/Captured ([\d,]+) \/ ([\d,]+) objects/);
  const captured = Number(capture[1].replaceAll(',', ''));
  expect(captured).toBeGreaterThan(1000000);
  expect(capture[1]).toBe(capture[2]);
  await page.locator('#unreachable').check();
  await page.locator('#gc-generation').selectOption('2');
  const status = await page.locator('#reachability-status').textContent();
  const counts = status.match(/Gen 2: ([\d,]+) reachable, ([\d,]+) unreachable, ([\d,]+) unknown; ([\d,]+) outside/);
  const [live, dead, unknown, outside] = counts.slice(1).map(value => Number(value.replaceAll(',', '')));
  expect(unknown).toBe(0);
  expect(live + dead + outside).toBe(captured);
  expect(dead).toBeGreaterThan(250000);
  await expect(page.locator('#reachability-status')).toContainText(`Showing 15,000 of ${dead.toLocaleString()} unreachable matches`);
  await page.locator('#highlight-state').selectOption('reachable');
  await expect(page.locator('#reachability-status')).toContainText(`Showing 15,000 of ${live.toLocaleString()} reachable matches`);
  await page.locator('#budget').selectOption('5000');
  await expect(page.locator('#reachability-status')).toContainText(`Showing 5,000 of ${live.toLocaleString()} reachable matches`);
  await expect(page.locator('#reference-status')).toContainText('2,513,447 captured object references');
  await page.locator('#gc-analysis').evaluate(element => element.scrollTop = 0);
  await page.screenshot({ path: 'artifacts/orchard-complete-capture.png' });
  expect(errors).toEqual([]);
});

test('older snapshots require new reachability metadata before negative classifications', async ({ page }) => {
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const analysis = analyzeReachability(snapshot, indexGraph(snapshot));
  const dead = snapshot.objects.find(object => analysis.objects.get(object.id).state === 'unreachable');
  delete snapshot.reachabilityMetadataIncluded; delete snapshot.heapVerifiedForReachability;
  delete snapshot.finalizableObjects;
  await page.route('**/api/dumps/spatial-fixture/graph', route => route.fulfill({ json: snapshot }));
  await openSnapshot(page, 'console');
  await page.locator('#unreachable').check();
  await expect(page.locator('#reachability-status')).toContainText('needs reanalysis');
  await expect(page.locator('#reachability-status')).toContainText('unknown');
  await expect(page.locator('#reachability-capture')).toContainText('Partial / unverified');
  await expect(page.locator('#neighborhood-status')).toContainText('overview is unchanged');
  await page.locator('#unreachable').uncheck();
  await page.locator('#search').fill(dead.address);
  await page.locator('#results button').first().click();
  await expect(page.locator('#details .object-reachability')).toContainText('Unknown - incomplete capture');
  await expect(page.locator('#details .object-reachability')).not.toContainText('Not reachable');
});

function dirtyCardClickPoint() {
  const data = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const index = indexGraph(data), cards = indexCards(data, index);
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  view.flight = { isLocked: false }; view.keys = new Set(); view.orbit = { target: new THREE.Vector3() };
  view.camera = new THREE.PerspectiveCamera(55, 1.6, 0.1, 100000); view.raycaster = new THREE.Raycaster();
  globalThis.innerWidth = 1600; globalThis.innerHeight = 1000;
  view.show(data, index, { budget: 15000, heap: 'all', roots: true, edges: true, cards: true, physical: true, native: true }, null);
  for (const key of cards.references.keys()) {
    const split = key.lastIndexOf(':'), selection = { segment: key.slice(0, split), index: Number(key.slice(split + 1)) };
    const evidence = cardEvidence(selection, cards, index, 0);
    if (!evidence.contributing.length) continue;
    const region = view.layout.segments.get(selection.segment);
    view.focus(region.position, region.size); view.camera.updateMatrixWorld();
    const plane = view.pickables.find(object => object.userData.cardMap?.info.segment === selection.segment);
    const { columns, rows } = plane.userData.cardMap;
    const u = (selection.index % columns + 0.5) / columns, v = (Math.floor(selection.index / columns) + 0.5) / rows;
    const position = new THREE.Vector3(region.position[0] + (u - 0.5) * region.size[0] * 0.88,
      region.top + 5, region.position[2] - (v - 0.5) * region.size[2] * 0.88).project(view.camera);
    const x = (position.x + 1) * 800, y = (1 - position.y) * 500;
    if (x < 325 || x > 1220 || y < 100 || y > 930) continue;
    const hit = view.pick({ clientX: x, clientY: y });
    if (hit?.kind === 'card' && hit.value.index === selection.index && hit.value.segment === selection.segment) {
      view.disposeContent(); return { ...selection, x, y, start: evidence.start, targets: evidence.reachable.size };
    }
  }
  throw new Error('No dirty card with young references is clickable in the fixture.');
}

test('root-type coloring, unified highlighting, finalizer memory and dirty-card attribution work together', async ({ page }) => {
  test.setTimeout(120000);
  const click = dirtyCardClickPoint(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await openSnapshot(page, 'console');
  await expect(page.locator('#gc-analysis #color')).toBeVisible();
  await expect(page.locator('#controls #color')).toHaveCount(0);
  await page.locator('#color').selectOption('reachability');
  await page.locator('#legend-toggle').click();
  await expect(page.locator('#legend-panel #material-legend')).toBeVisible();
  await expect(page.locator('#legend')).toHaveCount(0);
  await page.locator('#theme').selectOption('prism');
  await expect(page.locator('#color')).toHaveValue('reachability');
  await page.locator('#theme').selectOption('atlas');
  await page.locator('#unreachable').check();
  await page.locator('#highlight-state').selectOption('reachable');
  await expect(page.locator('#gc-generation')).toHaveValue('0');
  await page.locator('#unreachable').uncheck();
  await page.screenshot({ path: 'artifacts/root-provenance-stripes.png' });
  await inspectFinalization(page);
  await expect(page.locator('#details')).toContainText('shared queue storage');
  await expect(page.locator('#details')).toContainText('registered for finalization');
  await page.screenshot({ path: 'artifacts/finalization-memory.png' });
  await expect(page.locator('#cards')).toHaveCount(0);
  await expect(page.locator('#card-status')).toContainText('dirty (amber)');
  await inspectRegion(page, click.segment);
  await page.mouse.click(click.x, click.y);
  await expect(page.locator('#details h3').first()).toHaveText('Dirty GC card');
  await expect(page.locator('#details')).toContainText(click.start);
  await expect(page.locator('#details')).toContainText('not exclusive causality');
  await expect(page.locator('#neighborhood-status')).toContainText(`${click.targets} captured condemned-generation objects`);
  await page.screenshot({ path: 'artifacts/dirty-card-referents.png' });
  await page.locator('#deselect').click();
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await inspectFinalization(page);
  await page.locator('#details button').filter({ hasText: 'Registered finalizer' }).first().click();
  await expect(page.locator('#details h3').first()).toHaveText('FinalizationRegistration root slot');
  await expect(page.locator('#details')).toContainText('registered finalization');
  expect(errors).toEqual([]);
});

test('inspector depths are directional and all retaining routes are queried on demand', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8')), index = indexGraph(snapshot);
  const object = snapshot.objects.find(object => object.type === 'Heapscape.Fixtures.DemoNode');
  await openSnapshot(page, 'console');
  await expect(page.locator('#controls #depth, #controls #incoming-depth, #controls #outgoing-depth, #floor-labels, #gaps')).toHaveCount(0);
  await page.locator('#search').fill(object.address); await page.locator('#results button').first().click();
  await expect(page.getByRole('button', { name: 'Inspect containing region', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Inspect owning GC heap', exact: true })).toHaveCount(0);
  await expect(page.locator('#details #incoming-depth')).toHaveValue('1');
  await expect(page.locator('#details #outgoing-depth')).toHaveValue('1');
  await page.locator('#incoming-depth').selectOption('0');
  await page.locator('#outgoing-depth').selectOption('0');
  await expect(page.locator('#reference-status')).toHaveText(/^0 \/ /);
  await page.locator('#outgoing-depth').selectOption('2');
  const outgoing = neighborhood(object.id, index, { incoming: 0, outgoing: 2 });
  await expect(page.locator('#neighborhood-status')).toContainText(`${outgoing.ids.size} objects; incoming 0 hop(s), outgoing 2 hop(s)`);
  await page.locator('#outgoing-depth').selectOption('0');
  await page.locator('#incoming-depth').selectOption('2');
  const incoming = neighborhood(object.id, index, { incoming: 2, outgoing: 0 });
  await expect(page.locator('#neighborhood-status')).toContainText(`${incoming.ids.size} objects; incoming 2 hop(s), outgoing 0 hop(s)`);
  const routes = retainingRoutes(object.id, index);
  await page.getByRole('button', { name: 'Show all retaining routes', exact: false }).click();
  await expect(page.locator('.retaining-routes summary')).toHaveText(`${routes.roots.length.toLocaleString()} retaining sources`);
  await expect(page.locator('#neighborhood-status')).toContainText('All captured retaining routes:');
  await page.screenshot({ path: 'artifacts/all-retaining-routes.png' });
  await page.locator('#incoming-depth').selectOption('1');
  await expect(page.locator('.retaining-routes')).toHaveCount(0);
  await expect(page.locator('#neighborhood-status')).toContainText('incoming 1 hop(s), outgoing 0 hop(s)');
  expect(errors).toEqual([]);
});

test('WASD pans and QE rotates without changing selection or consuming search input', async ({ page }) => {
  test.setTimeout(90000);
  await openSnapshot(page, 'console');
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  await page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first().click();
  const details = await page.locator('#details').textContent();
  await page.locator('#viewport canvas').focus();
  await page.mouse.move(800, 500);
  await expect(page.locator('#tooltip')).toContainText('Heapscape.Fixtures.DemoNode');
  const original = await page.locator('#tooltip').textContent();
  await page.keyboard.down('KeyD');
  try {
    await expect.poll(async () => await page.locator('#tooltip').isHidden() ? '' : await page.locator('#tooltip').textContent()).not.toBe(original);
  } finally { await page.keyboard.up('KeyD'); }
  await page.keyboard.press('KeyG');
  await page.keyboard.down('KeyQ'); await page.waitForTimeout(300); await page.keyboard.up('KeyQ');
  await expect(page.locator('#details')).toHaveText(details);
  await expect(page.locator('#crosshair')).toBeHidden();
  await page.screenshot({ path: 'artifacts/keyboard-orbit.png' });
  await page.locator('#search').fill('');
  await page.keyboard.type('wasdqe');
  await expect(page.locator('#search')).toHaveValue('wasdqe');
  await expect(page.locator('#details')).toHaveText(details);
});

test('the in-world card table switch highlights dirty-card scan sources and their young descendants', async ({ page }) => {
  test.setTimeout(120000);
  const sample = dirtyCardClickPoint();
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8')), index = indexGraph(snapshot);
  const evidence = cardTableEvidence(new Set([sample.segment]), indexCards(snapshot, index), index, 0);
  const region = layout(snapshot, { physical: true }).segments.get(sample.segment);
  const view = Object.create(Atlas.prototype);
  view.camera = new THREE.PerspectiveCamera(55, 1.6, 0.1, 100000); view.orbit = { target: new THREE.Vector3() };
  view.focus(region.position, region.size); view.camera.updateMatrixWorld();
  const point = new THREE.Vector3(region.position[0] - region.size[0] * 0.44, region.top + 7,
    region.position[2] + region.size[2] * 0.44).project(view.camera);
  const x = (point.x + 1) * 800, y = (1 - point.y) * 500;
  await openSnapshot(page, 'console');
  await inspectRegion(page, sample.segment);
  await page.mouse.move(x, y);
  await expect(page.locator('#tooltip')).toContainText('dirty-card scan candidates');
  await page.mouse.click(x, y);
  await expect(page.locator('#details h3').first()).toHaveText('1 card table selected');
  await expect(page.locator('#neighborhood-status')).toContainText(`${evidence.sources.size.toLocaleString()} source scan candidates`);
  await expect(page.locator('#neighborhood-status')).toContainText(`${evidence.reachable.size.toLocaleString()} captured condemned-generation objects`);
  await expect(page.locator('#details')).toContainText('not exclusive causality');
  await page.screenshot({ path: 'artifacts/card-table-scan-highlight.png' });
  await page.mouse.move(x + 1, y);
  await expect(page.locator('#tooltip')).toContainText('Stop dirty-card');
  await page.mouse.click(x, y);
  await expect(page.locator('#details')).toContainText('Nothing selected.');
});

test('unsupported card maps never pretend to expose clean cards', async ({ page }) => {
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  snapshot.cardRegions = snapshot.cardRegions.map(info => ({
    ...info, status: 'unsupported', reason: 'Unsupported test target', count: 0, totalCount: 0, dirtyRuns: [],
  }));
  await page.route('**/api/dumps/spatial-fixture/graph', route => route.fulfill({ json: snapshot }));
  await openSnapshot(page, 'console');
  await expect(page.locator('#cards')).toHaveCount(0);
  await expect(page.locator('#card-status')).toContainText('0 card cells shown; 0 dirty');
  await expect(page.locator('#card-status')).toContainText(`${snapshot.cardRegions.length} unavailable maps`);
});

test('fixed controls and separate finalizer/fReachable sections use the captured console queue ranges', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const queue = snapshot.finalizationQueues[0];
  const registered = queue.entries.filter(entry => !entry.ready).length, ready = queue.entries.filter(entry => entry.ready).length;
  expect(registered).toBeGreaterThan(0); expect(ready).toBeGreaterThan(0);
  await openSnapshot(page, 'console');
  await expect(page.locator('#signal-speed, #region-dimensions, #region')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'on');
  await inspectFinalization(page);
  await expect(page.locator('#details h3').first()).toHaveText('Finalizer queue / Heap 0');
  await expect(page.locator('#details')).toContainText(`${queue.storage.start} - ${queue.ready.start}`);
  await expect(page.locator('#details dd').filter({ hasText: new RegExp(`^${registered}$`) })).toHaveCount(1);
  await page.getByRole('button', { name: 'Inspect fReachable queue', exact: false }).click();
  await expect(page.locator('#details h3').first()).toHaveText('fReachable queue / Heap 0');
  await expect(page.locator('#details')).toContainText(`${queue.ready.start} - ${queue.ready.end}`);
  await expect(page.locator('#details dd').filter({ hasText: new RegExp(`^${ready}$`) })).toHaveCount(1);
  await expect(page.locator('#details')).toContainText('strong GC roots pending finalizer execution');
  await page.getByRole('button', { name: 'Frame queue sections', exact: true }).click();
  await page.screenshot({ path: 'artifacts/finalizer-freachable-cubes.png' });
  await page.locator('#details button').filter({ hasText: 'Ready finalizer' }).first().click();
  await expect(page.locator('#details')).toContainText('exact fReachable queue slot');
  await page.getByRole('button', { name: 'Inspect queue section', exact: false }).click();
  await page.getByRole('button', { name: 'Inspect Finalizer queue', exact: false }).click();
  await page.locator('#details button').filter({ hasText: 'Registered finalizer' }).first().click();
  await expect(page.locator('#details')).toContainText('exact Finalizer queue slot');
  expect(errors).toEqual([]);
});

test('an empty fReachable range is explicitly empty rather than an invented allocated cube', async ({ page }) => {
  test.setTimeout(120000);
  await openSnapshot(page, 'aspnet');
  await inspectFinalization(page);
  await page.getByRole('button', { name: 'Inspect fReachable queue', exact: false }).click();
  await expect(page.locator('#details h3').first()).toHaveText(/^fReachable queue \/ Heap \d+$/);
  await expect(page.locator('#details')).toContainText('empty; wireframe marker, not an allocated-memory volume');
  await expect(page.locator('#details dt').filter({ hasText: 'section bytes' })).toBeVisible();
  await expect(page.locator('#details button').filter({ hasText: 'Ready finalizer' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Frame queue sections', exact: true }).click();
  await page.screenshot({ path: 'artifacts/empty-freachable-marker.png' });
});

test('highlight uses selection-style dimming and hover exposes the same root types as coloring', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const data = JSON.parse(readFileSync(path.resolve('artifacts', 'console.json'), 'utf8'));
  const analysis = analyzeReachability(data, indexGraph(data));
  await openSnapshot(page, 'console');
  await page.locator('#search').fill('Heapscape.Fixtures.DemoNode');
  const object = page.locator('#results button').filter({ hasText: /^Heapscape\.Fixtures\.DemoNode\s*0x/ }).first();
  await object.click();
  await page.mouse.move(800, 500);
  await expect(page.locator('#tooltip .tooltip-root-types')).toContainText('Root types (Gen 2):');
  const tooltipRoots = await page.locator('#tooltip .tooltip-root-types').textContent();
  await page.locator('#color').selectOption('reachability');
  await page.mouse.move(801, 500);
  await expect(page.locator('#tooltip .tooltip-root-types')).toHaveText(tooltipRoots);
  await expect(page.locator('#cards')).toHaveCount(0);
  await expect(page.locator('#card-status')).toContainText('Card sheets fade');
  await page.locator('#unreachable').check();
  await expect(page.locator('#details')).toContainText('Nothing selected.');
  await expect(page.locator('#reachability-status')).toContainText(`Showing ${analysis.collections[0].unreachable} of ${analysis.collections[0].unreachable} unreachable matches`);
  await expect(page.locator('#neighborhood-status')).toContainText('nonmatches are faint context');
  await page.screenshot({ path: 'artifacts/unreachable-selection-focus.png' });
  await page.locator('#highlight-state').selectOption('reachable');
  await expect(page.locator('#reachability-status')).toContainText(`Showing ${analysis.collections[0].reachable} of ${analysis.collections[0].reachable} reachable matches`);
  await expect(page.locator('#neighborhood-status')).toContainText('reachable objects emphasized');
  await page.locator('#theme').selectOption('prism');
  await expect(page.locator('#color')).toHaveValue('reachability');
  await object.click();
  await expect(page.locator('#details .object-reachability')).toContainText('Reachable by');
  await expect(page.locator('#reachability-status')).toContainText('explicit object/root/card selection');
  await page.getByRole('button', { name: 'Frame reference neighborhood' }).click();
  await page.screenshot({ path: 'artifacts/textured-stripes-direction-arrows.png' });
  await page.getByRole('button', { name: 'Focus object [G]', exact: true }).click();
  await page.mouse.move(1000, 110);
  await page.screenshot({ path: 'artifacts/focused-direction-arrows-closeup.png' });
  await page.locator('#deselect').click();
  await expect(page.locator('#unreachable')).not.toBeChecked();
  expect(errors).toEqual([]);
});
