#!/usr/bin/env node
/**
 * Servidor DSH SDK falso para pruebas.
 * ------------------------------------------------------------------
 * Habla el protocolo real (`@deepseek-ai/dsh-sdk-protocol`) por stdio,
 * de modo que el adaptador se prueba de verdad: framing por líneas,
 * peticiones con id, notificaciones y cierre.
 *
 * No gasta tokens ni necesita red.
 *
 * Variables de entorno:
 *   FAKE_DSH_RECORD   ruta donde volcar las peticiones recibidas (JSONL)
 *   FAKE_DSH_FAIL_INIT  si vale "1", responde a initialize con error
 *   FAKE_DSH_SILENT     si vale "1", no emite notificaciones al promptear
 */
import readline from 'node:readline';
import fs from 'node:fs';

const FAIL_INIT = process.env.FAKE_DSH_FAIL_INIT === '1';
const SILENT = process.env.FAKE_DSH_SILENT === '1';
const GARBAGE = process.env.FAKE_DSH_GARBAGE === '1';
const RECORD = process.env.FAKE_DSH_RECORD;

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function record(entry) {
  if (!RECORD) return;
  try {
    fs.appendFileSync(RECORD, `${JSON.stringify(entry)}\n`);
  } catch { /* ignorar */ }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // el protocolo manda ignorar líneas malformadas
  }

  record({ method: message.method, params: message.params });

  switch (message.method) {
    case 'initialize': {
      if (FAIL_INIT) {
        respondError(message.id, -32603, 'no hay adaptador para ese modelo');
        return;
      }
      // El protocolo obliga al cliente a ignorar las líneas malformadas.
      if (GARBAGE) {
        process.stdout.write('esto no es json\n');
        process.stdout.write('{roto\n');
        process.stdout.write('\n');
      }
      respond(message.id, {
        serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fake-1.0' }
      });
      return;
    }

    case 'session/prompt': {
      const sessionId = message.params?.sessionId;
      respond(message.id, { messageId: `msg-${Date.now()}` });
      if (SILENT) return;

      notify('session.status', { sessionId, status: 'running' });
      notify('session.event', {
        sessionId,
        event: { type: 'tool/call', seq: 1, time: Date.now(), data: { name: 'read' } }
      });
      notify('session.event', {
        sessionId,
        event: {
          type: 'assistant/message',
          seq: 2,
          time: Date.now(),
          data: { message: { content: [{ type: 'text', text: 'Respuesta de prueba' }] } }
        }
      });
      notify('session.event', {
        sessionId,
        event: { type: 'turn/end', seq: 3, time: Date.now(), data: { reason: 'ok' } }
      });
      notify('session.status', { sessionId, status: 'idle' });
      return;
    }

    case 'shutdown': {
      respond(message.id, {});
      setTimeout(() => process.exit(0), 20);
      return;
    }

    default:
      respondError(message.id, -32601, `método desconocido: ${message.method}`);
  }
});

rl.on('close', () => {
  // EOF: el servidor real también termina por aquí.
  process.exit(0);
});
