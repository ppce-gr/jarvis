#!/usr/bin/env node
/**
 * Composition Root (Raíz de Composición)
 * ------------------------------------------------------------------
 * Único punto donde se instancian los adaptadores de infraestructura y
 * se inyectan en los casos de uso de la capa de aplicación.
 *
 * Gracias a la arquitectura hexagonal, cambiar de DSH a otro motor de
 * agentes, o de sistema de ficheros a una base de datos, sólo requiere
 * tocar ESTE archivo (o añadir un adaptador nuevo en infrastructure/).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileSystemProjectRepository } from './infrastructure/persistence/FileSystemProjectRepository.js';
import { FileSystemNoteRepository } from './infrastructure/persistence/FileSystemNoteRepository.js';
import { FileSystemBrowserAdapter } from './infrastructure/persistence/FileSystemBrowserAdapter.js';
import { DshHeadlessOrchestratorAdapter } from './infrastructure/orchestrator/DshHeadlessOrchestratorAdapter.js';
import { DshSdkConversationAdapter } from './infrastructure/conversation/DshSdkConversationAdapter.js';
import { AcpConversationAdapter } from './infrastructure/conversation/AcpConversationAdapter.js';
import { GitSyncAdapter } from './infrastructure/git/GitSyncAdapter.js';
import { LocalSystemUpdateAdapter } from './infrastructure/system/LocalSystemUpdateAdapter.js';
import { JarvisWebServer } from './infrastructure/http/JarvisWebServer.js';

import { GetProjectsUseCase } from './application/GetProjectsUseCase.js';
import { GetProjectConceptualTreeUseCase } from './application/GetProjectConceptualTreeUseCase.js';
import { CreateProjectUseCase } from './application/CreateProjectUseCase.js';
import { SaveNoteUseCase } from './application/SaveNoteUseCase.js';
import { RunOrchestratorTaskUseCase } from './application/RunOrchestratorTaskUseCase.js';
import { BrowseProjectFilesUseCase } from './application/BrowseProjectFilesUseCase.js';
import { GetGitStatusUseCase } from './application/GetGitStatusUseCase.js';
import { ListOrchestratorTasksUseCase } from './application/ListOrchestratorTasksUseCase.js';
import { SendChatMessageUseCase } from './application/SendChatMessageUseCase.js';
import { GetChatHistoryUseCase } from './application/GetChatHistoryUseCase.js';
import { ResetChatUseCase } from './application/ResetChatUseCase.js';
import { SubscribeChatUseCase } from './application/SubscribeChatUseCase.js';
import { CancelChatTurnUseCase } from './application/CancelChatTurnUseCase.js';
import { GetChatConfigUseCase } from './application/GetChatConfigUseCase.js';
import { SetChatConfigUseCase } from './application/SetChatConfigUseCase.js';
import { GetSystemStatusUseCase } from './application/GetSystemStatusUseCase.js';
import { RequestSystemUpdateUseCase } from './application/RequestSystemUpdateUseCase.js';
import { CheckForUpdatesUseCase } from './application/CheckForUpdatesUseCase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Raíz del CÓDIGO: este repositorio, que es público.
const workspaceRoot = path.resolve(__dirname, '..');

// Raíz de la MEMORIA: un repositorio aparte, privado. Por defecto una carpeta
// hermana (`../jarvis-vault`), para que código y datos no compartan árbol: así
// es imposible que un fallo de .gitignore publique las notas.
const brainDir = process.env.JARVIS_BRAIN_DIR
  || path.resolve(workspaceRoot, '..', 'jarvis-vault');

const PORT = Number(process.env.JARVIS_PORT || 3081);
const HOST = process.env.JARVIS_HOST || '0.0.0.0';

// --- Adaptadores de infraestructura (los "conectores") ---
const projectRepository = new FileSystemProjectRepository(brainDir);
const noteRepository = new FileSystemNoteRepository(brainDir);
const browserAdapter = new FileSystemBrowserAdapter(brainDir);
const orchestratorAdapter = new DshHeadlessOrchestratorAdapter({
  brainDir,
  dshBin: process.env.JARVIS_DSH_BIN || 'dsh',
  profile: process.env.JARVIS_DSH_PROFILE || 'headless',
  dshHome: process.env.DSH_HOME,
  timeoutMs: Number(process.env.JARVIS_TASK_TIMEOUT_MS || 15 * 60 * 1000)
});
const gitSyncAdapter = new GitSyncAdapter(workspaceRoot);

// La preferencia de modelo se guarda junto a la memoria, no en el repo público.
const chatConfigFile = path.join(brainDir, 'chat-config.json');

// Actualización del propio Jarvis. El adaptador sólo consulta y deja la
// bandera; quien actualiza es systemd desde fuera (ver docs/autoactualizacion.md).
const containerDir = path.dirname(workspaceRoot);
const systemUpdateAdapter = new LocalSystemUpdateAdapter({
  codeDir: workspaceRoot,
  stateDir: path.join(containerDir, '.update-state'),
  flagFile: path.join(containerDir, '.update-request')
});

// Chat conversacional. Por defecto ACP, que es un estándar y aporta
// cancelación real, reanudación de la memoria y desacoplamiento de DSH.
// El adaptador SDK sigue disponible por si se quiere cero dependencias.
const chatProtocol = (process.env.JARVIS_CHAT_PROTOCOL || 'acp').toLowerCase();
const conversationAdapter = chatProtocol === 'sdk'
  ? new DshSdkConversationAdapter({
      brainDir,
      dshBin: process.env.JARVIS_DSH_BIN || 'dsh',
      profile: process.env.JARVIS_CHAT_PROFILE || 'sdk',
      dshHome: process.env.DSH_HOME,
      provider: process.env.JARVIS_CHAT_PROVIDER || 'deepseek-official',
      model: process.env.JARVIS_CHAT_MODEL || 'deepseek-v4-flash',
      reasoningEffort: process.env.JARVIS_CHAT_EFFORT || 'high',
      idleTimeoutMs: Number(process.env.JARVIS_CHAT_IDLE_MS || 15 * 60 * 1000),
      configFile: chatConfigFile
    })
  : new AcpConversationAdapter({
      brainDir,
      dshBin: process.env.JARVIS_DSH_BIN || 'dsh',
      profile: process.env.JARVIS_CHAT_PROFILE || 'acp',
      dshHome: process.env.DSH_HOME,
      provider: process.env.JARVIS_CHAT_PROVIDER || 'deepseek-official',
      model: process.env.JARVIS_CHAT_MODEL || 'deepseek-v4-flash',
      reasoningEffort: process.env.JARVIS_CHAT_EFFORT || 'high',
      idleTimeoutMs: Number(process.env.JARVIS_CHAT_IDLE_MS || 15 * 60 * 1000),
      configFile: chatConfigFile
    });

// --- Casos de uso (capa de aplicación) ---
const getProjectsUseCase = new GetProjectsUseCase(projectRepository);
const getConceptualTreeUseCase = new GetProjectConceptualTreeUseCase(noteRepository);
const createProjectUseCase = new CreateProjectUseCase(projectRepository, noteRepository);
const saveNoteUseCase = new SaveNoteUseCase(noteRepository);
const runOrchestratorTaskUseCase = new RunOrchestratorTaskUseCase(orchestratorAdapter);
const browseProjectFilesUseCase = new BrowseProjectFilesUseCase(browserAdapter);
const getGitStatusUseCase = new GetGitStatusUseCase(gitSyncAdapter);
const listOrchestratorTasksUseCase = new ListOrchestratorTasksUseCase(orchestratorAdapter);
const sendChatMessageUseCase = new SendChatMessageUseCase(conversationAdapter);
const getChatHistoryUseCase = new GetChatHistoryUseCase(conversationAdapter);
const resetChatUseCase = new ResetChatUseCase(conversationAdapter);
const subscribeChatUseCase = new SubscribeChatUseCase(conversationAdapter);
const cancelChatTurnUseCase = new CancelChatTurnUseCase(conversationAdapter);
const getChatConfigUseCase = new GetChatConfigUseCase(conversationAdapter);
const setChatConfigUseCase = new SetChatConfigUseCase(conversationAdapter);
const getSystemStatusUseCase = new GetSystemStatusUseCase(systemUpdateAdapter);
const requestSystemUpdateUseCase = new RequestSystemUpdateUseCase(systemUpdateAdapter);
const checkForUpdatesUseCase = new CheckForUpdatesUseCase(systemUpdateAdapter);

// --- Servidor web (adaptador de entrada) ---
const webServer = new JarvisWebServer({
  getProjectsUseCase,
  getConceptualTreeUseCase,
  createProjectUseCase,
  saveNoteUseCase,
  runOrchestratorTaskUseCase,
  browseProjectFilesUseCase,
  getGitStatusUseCase,
  listOrchestratorTasksUseCase,
  sendChatMessageUseCase,
  getChatHistoryUseCase,
  resetChatUseCase,
  subscribeChatUseCase,
  cancelChatTurnUseCase,
  getChatConfigUseCase,
  setChatConfigUseCase,
  getSystemStatusUseCase,
  requestSystemUpdateUseCase,
  checkForUpdatesUseCase,
  publicDir: path.join(workspaceRoot, 'public'),
  host: HOST,
  port: PORT
});

// Exponer git sync de forma sencilla vía CLI interna
export { gitSyncAdapter };

const { port } = await webServer.start();

console.log('');
console.log('  ╭──────────────────────────────────────────────╮');
console.log('  │              J A R V I S   C O R E           │');
console.log('  ╰──────────────────────────────────────────────╯');
console.log(`   Interfaz web :  http://<ip-raspberry>:${port}`);
console.log(`   Local        :  http://127.0.0.1:${port}`);
console.log(`   Codigo       :  ${workspaceRoot}`);
console.log(`   Memoria      :  ${brainDir}`);
console.log('');
console.log('   Ctrl+C para detener el servicio.');
console.log('');

// Cierre ordenado: guarda estado y libera el puerto
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[Jarvis] Recibida señal ${signal}, cerrando...`);
    await conversationAdapter.closeAll();
    await webServer.stop();
    process.exit(0);
  });
}
