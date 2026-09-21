# Documento de Arquitectura y Especificación Funcional: Proyecto Jarvis-Pi3

## 1. Visión General
El **Proyecto Jarvis-Pi3** es un sistema personal de gestión de ideas, proyectos y automatización asistida por IA, diseñado específicamente para ejecutarse de manera ligera y resiliente sobre hardware con recursos muy limitados (**Raspberry Pi 3B**, almacenamiento basado exclusivamente en tarjeta MicroSD y acceso restringido a la red local).

El objetivo es separar la ideación conceptual (gestión de proyectos, notas y Obsidian) de la ejecución técnica (desarrollo de código mediante agentes y orquestadores), asegurando la portabilidad absoluta y la protección frente a fallos de hardware mediante **Git**.

---

## 2. Principios Arquitectónicos
1. **Minimalismo Extremo (Anti-Bloatware):** Al correr en una Raspberry Pi 3B, se evitan bases de datos pesadas (como SQL pesados o vectores locales complejos). Todo el estado persistente y documental se almacena en archivos de texto plano (**Markdown**, **JSON**).
2. **Desacoplamiento de la Inteligencia (Cloud + Edge):** 
   * La Raspberry Pi actúa como *Edge Server* (orquestador, pasarela local, gestor de archivos y automatizaciones).
   * Los Modelos de Lenguaje (LLMs) pesados se ejecutan en la nube mediante APIs externas (DeepSeek, etc.), evitando sobrecargar la CPU/RAM de la Pi 3B.
3. **Resiliencia Absoluta ante Fallos de SD:** 
   * Toda la información crítica (ideas, especificaciones, código, configuraciones) está bajo control de versiones en **Git**.
   * El sistema debe poder ser reinstalado y desplegado desde cero en una nueva tarjeta SD mediante un único script de despliegue (`deploy.sh`).
4. **Multimodalidad Asíncrona (Filosofía "Jarvis"):**
   * Respuestas de voz/texto cortas e inmediatas para confirmaciones.
   * Derivación de cargas visuales o pesadas a pantallas secundarias o archivos en segundo plano.
5. **Acceso Local Seguro:** Sistema accesible exclusivamente dentro de la red local del hogar (mediante proxy inverso local / IP directa), protegiendo la privacidad y reduciendo la complejidad de exposición exterior.
6. **Aplicación propia, desacoplada de DSH (Hexagonal + SOLID):** Jarvis es una aplicación web independiente (Node.js, cero dependencias de runtime) que se apoya en DeepSeek Harness sólo como **una herramienta externa de orquestación**. DSH nunca se modifica ni se parchea: se invoca a través de un adaptador (`OrchestratorPort`). Si mañana se cambia de motor de agentes o de hardware, sólo se escribe un adaptador nuevo. Detalle técnico en [`arquitectura-software.md`](arquitectura-software.md).
7. **La interfaz es la de Jarvis, no la del harness:** una única web propia (`http://<ip-raspberry>:3081`) donde vive todo: árbol de ideas, notas conceptuales, código, bitácoras y la barra de órdenes al orquestador. No se salta a Obsidian ni a otras aplicaciones.
8. **No reinventar la rueda:** se reutilizan estándares y herramientas existentes (Markdown, Git, `http` nativo de Node, `ripgrep`/`grep` para búsqueda) en lugar de programar motores propios.

---

## 3. Estructura de Directorios del Workspace
El espacio de trabajo se organiza de forma modular y limpia. El formato Markdown
plano mantiene la compatibilidad nativa con lectores como **Obsidian** (opcional:
si algún día quieres abrir las carpetas con Obsidian en tu móvil, funcionará),
pero la interfaz de uso diario es la web propia de Jarvis.

```text
/home/jarvis/jarvis/
├── docs/                               # Documentación y arquitectura general
├── projects/                           # Espacio aislado por proyecto/idea
│   └── <nombre-proyecto>/
│       ├── README.md                   # Resumen ejecutivo del proyecto
│       ├── conceptual/                 # Fase de diseño y notas (Markdown)
│       ├── code/                       # Fase de ejecución (código fuente)
│       └── logs/                       # Bitácoras y registro de agentes
├── src/                                # Código de Jarvis (hexagonal: domain/application/infrastructure)
├── public/                             # Interfaz web (HTML/CSS/JS sin frameworks)
├── scripts/                            # Scripts de automatización y despliegue
├── test/                               # Suite de pruebas
└── .git/                               # Control de versiones central
```

---

## 4. Flujo de Trabajo (De la Idea al Código)
Cada proyecto o idea pasa por dos etapas bien diferenciadas:

1. **Fase Conceptual (Conversación & Diseño):**
   * El usuario expone una idea.
   * Se debate y se estructura conjuntamente en la capa conceptual (`conceptual/`).
   * No se escribe código hasta que la especificación esté aprobada.
2. **Fase de Ejecución Autónoma (Orquestador & Agentes):**
   * Se activa el orquestador basado en los workflows de DSH.
   * El orquestador desglosa el plan en tareas atómicas y delega en subagentes efímeros.
   * Los agentes trabajan sobre la carpeta `code/` y registran sus acciones en `logs/`.
   * Una vez finalizado, se realiza un `git commit` automático (manteniendo al usuario como autor/propietario y al agente como colaborador/bot).

---

## 5. Estrategia de Despliegue y Recuperación
* **Identidades Git Separadas:** El usuario figura como autor de los commits en el repositorio remoto; los scripts de automatización utilizan credenciales de bot/token para los commits automáticos.
* **Script de Despliegue (`deploy.sh`):** Permite clonar el repositorio, instalar dependencias mínimas de Node.js/Python necesarias para DSH y levantar el entorno en una nueva Raspberry Pi en minutos.

---

## 6. Evolución Futura
* Integración con pasarelas de voz (Web Speech API en móvil, integración futura con Alexa / asistentes locales).
* Ampliación de pantallas secundarias para visualización de recetas y resúmenes.
* Expansión modular según surjan nuevas necesidades (mutabilidad del sistema).

---

## 7. Estado de Implementación (v1.0)
* **Aplicación web propia** operativa en `src/` + `public/` (puerto 3081).
* **Dominio, puertos y casos de uso** implementados con arquitectura hexagonal.
* **Adaptadores:** sistema de ficheros (Markdown + explorador), Git y DSH (orquestación).
* **19 pruebas automáticas** en verde (`npm test`).
* **Respaldo y migración:** `scripts/backup.sh`, `scripts/deploy.sh` y `scripts/jarvis.service`.
