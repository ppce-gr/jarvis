/**
 * Dominio: AgentInstructions
 * ==================================================================
 * Construye el enunciado que recibe el agente en orden de caché:
 *
 *   1. Instrucciones estáticas (rol, reglas, permisos, políticas).
 *   2. Resumen acumulado del sub-chat (semi-estático).
 *   3. Historial reciente (dinámico, pero anterior al estado actual).
 *   4. Nota de reanudación / estado (dinámico).
 *   5. Mensaje del usuario (último, siempre al final).
 *
 * El motor DSH no expone bloques `system`/`cache_control` como Anthropic:
 * la caché la gestiona él. Lo que sí controlamos es que el prefijo estable
 * vaya primero y que lo que cambia en cada turno quede al final.
 */

import { fetchPolicyLines } from './FetchPolicy.js';
import { workspacePolicyLines } from './WorkspacePolicy.js';

/**
 * Bloque estático de una idea. `projectId`, el modo de fetch y la ruta
 * temporal son estables durante la sesión; por eso van al principio.
 */
export function buildSystemInstructions({ projectId, fetchMode, tmpDir }) {
  return [
    `Trabajas dentro del proyecto "${projectId}" de Jarvis.`,
    'El directorio de trabajo actual ES la carpeta del proyecto.',
    '- El diseño y el contexto de esta idea viven en `conceptual/`; empieza por `_indice.md`.',
    '- Cuando lleguéis a un acuerdo, escríbelo en la nota conceptual que corresponda.',
    '- El código y los artefactos van en `code/`.',
    '- No modifiques nada fuera de este proyecto.',
    '',
    'Seguimiento de la conversación (notas en `conceptual/`):',
    '- `preguntas.md`: SOLO las preguntas que hace el USUARIO, con su respuesta ya',
    '  verificada (`- [x] <pregunta> — <respuesta breve>`). Las peticiones o tareas',
    '  que te pida NO se anotan aquí.',
    '- `dudas.md`: las dudas TUYAS que NO bloquean el trabajo, para que el usuario',
    '  las responda una a una en la pestaña Dudas. Anótalas como `- [ ] <duda>`.',
    '  Nunca las marques respondidas tú: las responde él. Si una duda BLOQUEA el',
    '  trabajo, pregúntala en el chat y no la escribas.',
    '- `puntos-clave.md`: los pilares de la idea; se usan para colorear el mapa.',
    'Mantén estas listas al día al final del turno en que haya algo que anotar, sin',
    'reescribir lo que ya está.',
    '',
    'Ficheros que te pasa el usuario:',
    '- Llegan a `adjuntos/`. Cuando uses uno, muévelo a su sitio dentro del',
    '  proyecto (p. ej. `code/` o `conceptual/`) sin borrarlo del disco.',
    '- La pestaña Adjuntos permite al usuario subir, mover, desasociar (quitar de',
    '  la idea sin borrar) y borrar. El historial queda registrado.',
    '',
    ...fetchPolicyLines(fetchMode),
    '',
    ...workspacePolicyLines(projectId, tmpDir),
    '',
    'Permisos de sistema (NO tienes root):',
    '- Si necesitas algo del sistema (reiniciar un servicio, editar `/etc`, GPIO,',
    '  paquetes), NO lo intentes: pide permiso y espera. Lo aprueba el usuario',
    '  1 a 1 con su PIN; nada se ejecuta hasta entonces.',
    '- Pide así (con el id de tu idea):',
    '  curl -s -XPOST localhost:3081/api/projects/<idea>/permisos \\',
    '    -H "Content-Type: application/json" \\',
    '    -d \'{"comando":"...","motivo":"..."}\'',
    '- El resultado queda en `logs/permisos/resultados/`. Si no aparece, aún no lo',
    '  ha aprobado: espera, no lo repitas en bucle.',
    '',
    'Reanudación tras un reinicio:',
    '- Si vas a pedir la actualización de Jarvis (tocar `.solicitar-actualizacion`),',
    '  ANTES escribe `tarea-en-curso.md` en la raíz del proyecto con tres apartados:',
    '  `## Qué estaba haciendo`, `## Qué falta` y `## Siguiente paso`. El reinicio',
    '  matará tu sesión; esa nota se te devolverá al reanudar.',
    '- Cuando la tarea termine, BORRA `tarea-en-curso.md`: mientras siga ahí, se te',
    '  inyectará al abrir sesión como trabajo pendiente.'
  ].join('\n');
}

export function preambleHistorial(mensajes) {
  const lineas = (mensajes || []).map((m) => {
    const quien = m.role === 'user' ? 'Usuario' : 'Jarvis';
    const texto = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    return `${quien}: ${texto}`;
  });
  return [
    'Conversación anterior de este proyecto (contexto; continúala sin repetirla):',
    ...lineas
  ].join('\n');
}

export function preambleSubchat(resumen) {
  return [
    'Este chat continúa una conversación anterior de este mismo proyecto.',
    'Resumen del contexto (continúa sin repetirlo):',
    '',
    String(resumen || '').trim()
  ].join('\n');
}

export function preambleTarea(contenido, modificadoEn) {
  const cuando = modificadoEn ? ` (dejada el ${new Date(modificadoEn).toLocaleString()})` : '';
  return [
    `Nota de reanudación${cuando}: la escribió una sesión anterior tuya en`,
    '`tarea-en-curso.md`, justo antes de reiniciar Jarvis, que mató aquella sesión.',
    'Retoma la tarea desde donde la dejó. Puede estar ya superada: verifica antes de',
    'darla por buena, y BÓRRALA cuando la tarea termine.',
    '',
    String(contenido || '').trim()
  ].join('\n');
}

/** Prompt de un turno posterior: políticas estables antes del input actual. */
export function buildFollowupMessage({ projectId, text, fetchMode, tmpDir }) {
  return [
    ...fetchPolicyLines(fetchMode),
    '',
    ...workspacePolicyLines(projectId, tmpDir, { short: true }),
    '',
    text
  ].join('\n');
}

/** Primer mensaje de la sesión, en el orden estático → dinámico. */
export function buildFirstMessage({
  projectId, text, fetchMode, tmpDir, summary = '', history = [], resume = null
}) {
  const bloques = [buildSystemInstructions({ projectId, fetchMode, tmpDir })];
  if (summary) bloques.push(preambleSubchat(summary));
  if (Array.isArray(history) && history.length) bloques.push(preambleHistorial(history));
  if (resume) bloques.push(preambleTarea(resume.contenido, resume.modificadoEn));
  bloques.push('Mensaje del usuario:', text);
  return bloques.join('\n\n');
}
