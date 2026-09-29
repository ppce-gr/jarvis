import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalSystemHealthAdapter } from '../../src/infrastructure/system/LocalSystemHealthAdapter.js';
import { GetSystemHealthUseCase } from '../../src/application/GetSystemHealthUseCase.js';

/** Salud con ficheros de prueba (sensor y meminfo), disco real. */
async function conSalud({ thermal = '48600\n' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-salud-'));
  const thermalPath = path.join(dir, 'temp');
  const meminfoPath = path.join(dir, 'meminfo');
  await fs.writeFile(thermalPath, thermal, 'utf8');
  await fs.writeFile(meminfoPath, 'MemTotal: 1048576 kB\nMemAvailable: 262144 kB\n', 'utf8');
  const adapter = new LocalSystemHealthAdapter({
    thermalPaths: [thermalPath],
    meminfoPath,
    diskPath: '/'
  });
  return { adapter, caso: new GetSystemHealthUseCase(adapter) };
}

test('la salud lee temperatura (miligrados), memoria y disco', async () => {
  const { caso } = await conSalud();
  const s = await caso.execute();

  assert.equal(s.temperaturaC, 48.6, 'miligrados → grados');
  assert.equal(s.memoria.total, 1048576 * 1024);
  assert.equal(s.memoria.libre, 262144 * 1024);
  assert.equal(s.memoria.porcentaje, 75);
  assert.ok(s.disco && s.disco.total > 0, 'hay disco');
  assert.ok(s.disco.libre >= 0 && s.disco.porcentaje >= 0);
  assert.ok(s.carga && Number.isFinite(s.carga.uno));
  assert.ok(s.uptimeS >= 0);
});

test('sin sensor de temperatura devuelve null y no rompe', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-salud2-'));
  const adapter = new LocalSystemHealthAdapter({
    thermalPaths: [path.join(dir, 'no-existe')],
    meminfoPath: path.join(dir, 'no-existe-meminfo'),
    diskPath: '/'
  });
  const s = await new GetSystemHealthUseCase(adapter).execute();
  assert.equal(s.temperaturaC, null);
  assert.ok(s.memoria.total > 0, 'memoria por respaldo de os');
  assert.ok(s.disco, 'el disco se lee igual');
});
