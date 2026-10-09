import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Dónde TRABAJA el agente de un proyecto.
 * ==================================================================
 * Por defecto, su carpeta dentro de la memoria. Pero un proyecto puede
 * declarar otro sitio en `workspace.json`, y eso es lo que permite que un
 * agente trabaje sobre el propio código de Jarvis (proyecto de
 * automodificación) sin sacarlo de su sandbox: el sandbox confina la
 * escritura a este directorio, así que darle el repositorio del código es
 * exactamente lo que le da acceso —y sólo a él—.
 *
 * Vive aquí, y no dentro de un adaptador, porque lo necesitan varios: el
 * chat (para inyectar la nota de reanudación) y el lector de esa nota.
 * Resolverlo en dos sitios era pedir que se desincronizaran.
 */
export async function resolverWorkspace(brainDir, projectId) {
  const porDefecto = path.join(brainDir, projectId);
  try {
    const raw = await fs.readFile(path.join(porDefecto, 'workspace.json'), 'utf8');
    const { workspace } = JSON.parse(raw);
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
      return porDefecto;
    }
    await fs.access(workspace);            // tiene que existir
    return workspace;
  } catch {
    return porDefecto;                      // sin declaración: su carpeta
  }
}
