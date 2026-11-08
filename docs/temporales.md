# Ficheros temporales y entregables

Los agentes no deben crear ficheros sueltos dentro de los repositorios. Cada
idea tiene dos espacios separados:

| Espacio | Ruta | Qué va ahí | ¿Se respalda? |
|---|---|---|---|
| Temporales | `$JARVIS_TMP_DIR/<idea>/` | Descargas, renders, pruebas, logs pesados, ficheros intermedios | No. Se puede borrar entero |
| Entregables | `<idea>/code/output/` | ZIP y artefactos que el usuario descarga desde la vista de código | No. La carpeta se ignora sola |

## Temporales

Por defecto `JARVIS_TMP_DIR` es `../tmp` respecto al código, es decir
`/home/jarvis/jarvis/tmp` en esta instalación. Está **fuera** del repo de
código y del vault, así que un `rm -rf` no toca nada irremplazable.

Cada idea tiene su subcarpeta:

```text
/home/jarvis/jarvis/tmp/
├── app-movil-crystal-pulse/
├── juego-descubrir-el-asesino/
└── ...
```

Para limpiar:

```bash
bash scripts/limpiar-temporales.sh listar
bash scripts/limpiar-temporales.sh borrar-idea <idea>
bash scripts/limpiar-temporales.sh borrar-todo --si
```

## Entregables (`code/output/`)

La carpeta `code/output/` aparece en la vista de código y contiene un
`.gitignore` con:

```gitignore
*
!.gitignore
```

Así cualquier ZIP que se deje ahí **no entra en Git**, ni en el vault ni en el
repositorio propio de un proyecto. El usuario puede descargarlo desde la vista
de código o descargar la carpeta entera.

Para preparar las ideas existentes o una nueva:

```bash
bash scripts/preparar-espacios.sh
bash scripts/preparar-espacios.sh <idea>
```

## Regla para los agentes

El preámbulo de cada conversación y de cada tarea del orquestador incluye la
ruta concreta de temporales de esa idea y la regla de `code/output/`. Si un
agente necesita un fichero intermedio, debe escribir en su carpeta temporal; si
el fichero es para el usuario, en `code/output/`.
