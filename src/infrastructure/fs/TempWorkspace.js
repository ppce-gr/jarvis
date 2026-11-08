import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Resuelve la raíz de temporales. Por defecto es una carpeta hermana de
 * `jarvis` y `jarvis-vault` (la raíz de la instalación), fuera de ambos
 * repositorios y segura de borrar.
 */
export function resolverTmpDir(brainDir) {
  return process.env.JARVIS_TMP_DIR || path.resolve(brainDir, '..', 'tmp');
}

export function tmpProyecto(tmpDir, projectId) {
  return path.join(tmpDir, String(projectId));
}

export async function asegurarTmpProyecto(tmpDir, projectId) {
  const dir = tmpProyecto(tmpDir, projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Carpeta de entregables descargables (ignorada por Git en el vault). */
export async function asegurarOutputProyecto(brainDir, projectId) {
  const dir = path.join(brainDir, String(projectId), 'code', 'output');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
