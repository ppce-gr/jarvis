/**
 * Dominio: WorkspacePolicy
 * ==================================================================
 * Reglas para que los agentes no ensucien los repositorios con ficheros
 * intermedios ni con entregables pesados.
 *
 *   - Temporales: viven fuera de los repositorios, en una carpeta por idea.
 *     Se pueden borrar sin perder el proyecto.
 *   - Entregables: los ZIP que el usuario descarga van a `code/output/`,
 *     dentro de la vista de código pero ignorados por Git.
 *
 * El dominio sólo produce texto; las rutas absolutas las resuelve la
 * infraestructura y se pasan como argumento.
 */

export const OUTPUT_DIR = 'code/output';

/** Líneas que se inyectan en el enunciado del agente. */
export function workspacePolicyLines(projectId, tmpRoot, { short = false } = {}) {
  const ideaTmp = `${String(tmpRoot).replace(/\/+$/, '')}/${projectId}`;
  if (short) {
    return [
      `Recuerda: temporales en \`${ideaTmp}/\`; entregables en \`${OUTPUT_DIR}/\` (ignorado por Git).`
    ];
  }
  return [
    'Ficheros temporales y entregables:',
    `- Todo fichero intermedio (descargas, renders, pruebas, logs pesados) va a \`${ideaTmp}/\`, fuera de los repositorios. Esa carpeta se puede borrar sin perder el proyecto.`,
    `- Los ZIP o artefactos que el usuario descarga van a \`${OUTPUT_DIR}/\`, que está en la vista de código pero ignorado por Git.`,
    '- No dejes esos ficheros en `code/`, `conceptual/` ni en la raíz del proyecto.'
  ];
}
