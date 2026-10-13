import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalSystemServicesAdapter } from '../../src/infrastructure/system/LocalSystemServicesAdapter.js';
import { GetServicesUseCase } from '../../src/application/GetServicesUseCase.js';
import { ToggleServiceUseCase } from '../../src/application/ToggleServiceUseCase.js';

/** Guion de prueba que imita a servicios.py sin tocar systemd. */
async function conGuion() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-serv-'));
  const guion = path.join(dir, 'servicios.py');
  await fs.writeFile(guion, [
    'import json, sys',
    'a = sys.argv[1:]',
    'if a and a[0] == "--json":',
    '    print(json.dumps({"recursos": {"semaforo": "holgado"}, "servicios": [{"id": "oir", "estado": "dormido"}]}))',
    'elif a and a[0] in ("activar", "desactivar"):',
    '    print(json.dumps({"ok": True, "id": a[1], "accion": a[0], "mensaje": "hecho"}))',
    'else:',
    '    print(json.dumps({}))'
  ].join('\n'), 'utf8');
  return new LocalSystemServicesAdapter({ scriptPath: guion, pythonBin: 'python3' });
}

test('list() devuelve el JSON de servicios.py', async () => {
  const adapter = await conGuion();
  const datos = await new GetServicesUseCase(adapter).execute();
  assert.equal(datos.recursos.semaforo, 'holgado');
  assert.equal(datos.servicios[0].id, 'oir');
});

test('toggle() activa y desactiva', async () => {
  const caso = new ToggleServiceUseCase(await conGuion());
  const r = await caso.execute('oir', 'activar');
  assert.equal(r.accion, 'activar');
  const r2 = await caso.execute('oir', 'desactivar');
  assert.equal(r2.accion, 'desactivar');
});

test('toggle() rechaza acciones inválidas', async () => {
  const caso = new ToggleServiceUseCase(await conGuion());
  await assert.rejects(() => caso.execute('oir', 'explotar'), /SERVICE_ACTION_INVALID/);
});

test('sin guion, list() falla con un mensaje claro', async () => {
  const adapter = new LocalSystemServicesAdapter({ scriptPath: '/no/existe/servicios.py' });
  await assert.rejects(() => new GetServicesUseCase(adapter).execute(), /no está instalada/);
});
