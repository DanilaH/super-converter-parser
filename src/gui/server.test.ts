import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OperatorGuiService } from './service.js';
import { startOperatorGuiServer } from './server.js';

test('local GUI serves production bootstrap and plans config drafts over same-origin loopback HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-http-'));
  const staticRoot = join(root, 'public');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>GUI</title>', 'utf8');
  await writeFile(join(staticRoot, 'app.js'), 'console.log("gui")', 'utf8');
  await writeFile(join(staticRoot, 'styles.css'), 'body{}', 'utf8');

  const service = await OperatorGuiService.create({
    outputRoot: join(root, 'output'),
    draftRoot: join(root, 'drafts'),
  });
  const gui = await startOperatorGuiServer({ service, port: 0, staticRoot });
  try {
    assert.match(gui.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const bootstrapResponse = await fetch(`${gui.url}/api/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json() as {
      presets: Array<{ id: string }>;
      schemas: { researchConfig: { title: string } };
    };
    assert.deepEqual(bootstrap.presets.map((preset) => preset.id), [
      'deep-research',
      'finalist-validation',
      'quick-scan',
      'standard',
    ]);
    assert.equal(bootstrap.schemas.researchConfig.title, 'Utility Research Runner OperatorResearchConfigV1');

    const planResponse = await fetch(`${gui.url}/api/new/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: gui.url,
      },
      body: JSON.stringify({
        config: {
          version: 1,
          preset: 'quick-scan',
          research: {
            label: 'http-plan',
            input: { type: 'seeds', path: 'input/seeds.csv' },
          },
        },
        files: { 'input/seeds.csv': 'keyword\njson formatter\n' },
      }),
    });
    assert.equal(planResponse.status, 200);
    const planned = await planResponse.json() as { draftId: string; plan: { stateContext: { kind: string } } };
    assert.ok(planned.draftId);
    assert.equal(planned.plan.stateContext.kind, 'new');

    const staticResponse = await fetch(`${gui.url}/`);
    assert.equal(staticResponse.status, 200);
    assert.match(staticResponse.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(await staticResponse.text(), /<title>GUI<\/title>/);
  } finally {
    await gui.close();
    await service.close();
  }
});

test('local GUI rejects cross-origin mutation requests even when they target loopback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-origin-'));
  const staticRoot = join(root, 'public');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html>', 'utf8');

  const service = await OperatorGuiService.create({
    outputRoot: join(root, 'output'),
    draftRoot: join(root, 'drafts'),
  });
  const gui = await startOperatorGuiServer({ service, port: 0, staticRoot });
  try {
    const evil = await fetch(`${gui.url}/api/new/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.com',
      },
      body: '{}',
    });
    assert.equal(evil.status, 403);

    const otherLoopbackPort = await fetch(`${gui.url}/api/new/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:1',
      },
      body: '{}',
    });
    assert.equal(otherLoopbackPort.status, 403);
  } finally {
    await gui.close();
    await service.close();
  }
});

test('local GUI refuses non-loopback bind addresses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-bind-'));
  const service = await OperatorGuiService.create({
    outputRoot: join(root, 'output'),
    draftRoot: join(root, 'drafts'),
  });
  try {
    await assert.rejects(
      startOperatorGuiServer({ service, host: '0.0.0.0', port: 0, staticRoot: root }),
      /must bind to 127\.0\.0\.1/,
    );
  } finally {
    await service.close();
  }
});
