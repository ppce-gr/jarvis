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

---

## 3. Estructura de Directorios del Workspace
El espacio de trabajo se organiza de forma modular y limpia, compatible de forma nativa con lectores de Markdown como **Obsidian**:

```text
/home/jarvis/jarvis/
├── docs/                               # Documentación y arquitectura general
│   └── arquitectura-jarvis-pi3.md      # Este documento
├── projects/                           # Espacio aislado por proyecto/idea
│   └── <nombre-proyecto>/
│       ├── README.md                   # Resumen ejecutivo del proyecto
│       ├── conceptual/                 # Fase de diseño y notas (Markdown)
│       ├── code/                       # Fase de ejecución (código fuente)
│       └── logs/                       # Bitácoras y registro de agentes
├── scripts/                            # Scripts de automatización y despliegue
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
* Ampliación de pantallas secundarias para visualización de recetas, recetas y resúmenes.
* Expansión modular según surjan nuevas necesidades (mutabilidad del sistema).
