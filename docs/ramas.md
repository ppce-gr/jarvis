# Ramas de tarea (red de seguridad)

Cada tarea que modifica Jarvis se hace en una **rama** `tarea/<slug>`. Antes de
abrirla se guarda un **snapshot**: el commit base de `main` y una copia de los
ficheros **no seguidos/ignorados** (configuraciones, claves locales, etc.). Si
algo sale mal, se vuelve a `main` y se recupera esa configuración.

El snapshot vive dentro de **`.git/jarvis-ramas/`**: nunca se versiona ni se
sube, así que puede contener secretos sin peligro.

## Comandos

```bash
bash scripts/ramas.sh abrir <slug>   # snapshot + crea tarea/<slug>
bash scripts/ramas.sh cerrar         # pruebas + fusiona en main + borra la rama
bash scripts/ramas.sh restaurar      # vuelve a main, borra la rama y restaura
bash scripts/ramas.sh volver <ref>   # rollback de main a un snapshot (tras cerrar)
bash scripts/ramas.sh estado         # tarea abierta y rama actual
bash scripts/ramas.sh lista          # snapshots guardados
```

- **`abrir`** exige estar en `main` con el árbol limpio.
- **`cerrar`** ejecuta `npm test` (si hay `package.json`), fusiona con `--no-ff`
  y borra la rama; el snapshot se conserva por si hay que volver.
- **`restaurar`** es la salida de emergencia: `git switch -f main`, borra la rama
  y devuelve los ficheros del snapshot tal y como estaban antes de abrirla.
- **`volver ultimos`** (o un snapshot concreto) devuelve `main` al commit base y
  restaura la configuración. Ojo: usa `git reset --hard`, así que reescribe la
  historia local.

## Flujo del agente

1. `bash scripts/ramas.sh abrir <slug>`
2. Implementar y commitear en la rama.
3. `npm test`.
4. `bash scripts/ramas.sh cerrar` (fusiona en `main`).
5. Resumen + `tarea-en-curso.md` + `touch .solicitar-actualizacion`.

Si algo falla antes de cerrar: `bash scripts/ramas.sh restaurar`.

## Por qué dentro de `.git/`

- El agente sólo puede escribir dentro del repositorio; ahí puede crear el
  snapshot.
- `.git/` no se versiona ni se sube, así que las claves del snapshot **no**
  acaban en el repositorio público.
- El usuario puede lanzar exactamente los mismos comandos desde la terminal si
  Jarvis no está fino.

## Pruebas

`test/infrastructure/ramas.test.js` levanta un repositorio temporal y cubre
abrir, restaurar, cerrar y volver, incluida la recuperación de la configuración.
