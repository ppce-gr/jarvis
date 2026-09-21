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
import { DshOrchestratorAdapter } from './infrastructure/orchestrator/DshOrchestratorAdapter.js';
import { GitSyncAdapter } from './infrastructure/git/GitSyncAdapter.js';
import { JarvisWebServer } from './infrastructure/http/JarvisWebServer.js';

import { GetProjectsUseCase } from './application/GetProjectsUseCase.js';
import { GetProjectConceptualTreeUseCase } from './application/GetProjectConceptualTreeUseCase.js';
import { CreateProjectUseCase } from './application/CreateProjectUseCase.js';
import { SaveNoteUseCase } from './application/SaveNoteUseCase.js';
import { RunOrchestratorTaskUseCase } from './application/RunOrchestratorTaskUseCase.js';
import { BrowseProjectFilesUseCase } from './application/BrowseProjectFilesUseCase.js';
import { GetGitStatusUseCase } from './application/GetGitStatusUseCase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.JARVIS_PORT || 3081);
const HOST = process.env.JARVIS_HOST || '0.0.0.0';

// --- Adaptadores de infraestructura (los "conectores") ---
const projectRepository = new FileSystemProjectRepository(
  path.join(workspaceRoot, 'projects')
);
const noteRepository = new FileSystemNoteRepository(
  path.join(workspaceRoot, 'projects')
);
const browserAdapter = new FileSystemBrowserAdapter(
  path.join(workspaceRoot, 'projects')
);
const orchestratorAdapter = new DshOrchestratorAdapter(workspaceRoot);
const gitSyncAdapter = new GitSyncAdapter(workspaceRoot);

// --- Casos de uso (capa de aplicación) ---
const getProjectsUseCase = new GetProjectsUseCase(projectRepository);
const getConceptualTreeUseCase = new GetProjectConceptualTreeUseCase(noteRepository);
const createProjectUseCase = new CreateProjectUseCase(projectRepository, noteRepository);
const saveNoteUseCase = new SaveNoteUseCase(noteRepository);
const runOrchestratorTaskUseCase = new RunOrchestratorTaskUseCase(orchestratorAdapter);
const browseProjectFilesUseCase = new BrowseProjectFilesUseCase(browserAdapter);
const getGitStatusUseCase = new GetGitStatusUseCase(gitSyncAdapter);

// --- Servidor web (adaptador de entrada) ---
const webServer = new JarvisWebServer({
  getProjectsUseCase,
  getConceptualTreeUseCase,
  createProjectUseCase,
  saveNoteUseCase,
  runOrchestratorTaskUseCase,
  browseProjectFilesUseCase,
  getGitStatusUseCase,
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
console.log(`   Workspace    :  ${workspaceRoot}`);
console.log('');
console.log('   Ctrl+C para detener el servicio.');
console.log('');

// Cierre ordenado: guarda estado y libera el puerto
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[Jarvis] Recibida señal ${signal}, cerrando...`);
    await webServer.stop();
    process.exit(0);
  });
}
