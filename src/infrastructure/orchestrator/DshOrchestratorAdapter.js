import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { OrchestratorPort } from '../../domain/ports/OrchestratorPort.js';

const execAsync = promisify(exec);

/**
 * Adaptador de Infraestructura: DshOrchestratorAdapter
 * Conecta el núcleo de Jarvis con el motor de ejecución de DeepSeek Harness (DSH)
 * o scripts de workflows existentes en la Raspberry Pi.
 */
export class DshOrchestratorAdapter extends OrchestratorPort {
  constructor(baseWorkspace = process.cwd()) {
    super();
    this.baseWorkspace = baseWorkspace;
  }

  async executeTask(projectId, instruction) {
    // Aquí invocamos de forma segura las capacidades de DSH o un workflow programado
    const projectPath = path.join(this.baseWorkspace, 'projects', projectId);
    
    try {
      // Simulación de ejecución controlada de agentes o logging de orquestación
      console.log(`[Orchestrator] Ejecutando tarea para el proyecto [${projectId}]: "${instruction}"`);
      
      // En una implementación real de DSH, aquí podemos disparar un subagente o script registrado.
      // De momento, dejamos constancia en un archivo de log dentro del proyecto.
      const logMsg = `[${new Date().toISOString()}] Tarea ejecutada: ${instruction}\n`;
      const logPath = path.join(projectPath, 'logs', 'orchestrator.log');
      
      // Asegurar carpeta logs
      await execAsync(`mkdir -p "${path.join(projectPath, 'logs')}"`);
      await execAsync(`echo '${logMsg}' >> "${logPath}"`);

      return {
        success: true,
        message: `Orquestador activado correctamente para ${projectId}. Registro guardado en logs.`,
        projectId,
        instruction
      };
    } catch (error) {
      console.error('[Orchestrator Error]:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}
