# Manual de la interfaz web

La interfaz es una página web servida por la propia Raspberry. Todo el render
ocurre en **tu navegador** (móvil o PC), así que la Pi no sufre.

## Acceso

1. Arranca el servicio: `npm start` (o el servicio systemd, ver
   [`guia-migracion.md`](guia-migracion.md)).
2. Desde cualquier dispositivo de la red local abre:

   ```
   http://<ip-de-la-raspberry>:3081
   ```

3. En el móvil puedes añadirla a la pantalla de inicio para usarla como app.

## Zonas de la pantalla

```text
┌───────────────────────────────────────────────────────────┐
│ ☰  JARVIS  Centro de Mando          git · limpio   + Idea │
├──────────────┬────────────────────────────────────────────┤
│ PROYECTOS    │  [Conceptual] [Código] [Bitácora]  ✎ Editar│
│  📁 idea-a   ├────────────────────────────────────────────┤
│  📁 idea-b   │                                            │
│              │   Contenido de la nota / código / logs      │
│ NOTAS        │                                            │
│  📝 _indice  │                                            │
│  📝 qa-dudas │                                            │
├──────────────┴────────────────────────────────────────────┤
│ ⌘  Dile a Jarvis qué hacer…                     [Enviar]  │
└───────────────────────────────────────────────────────────┘
```

### Panel izquierdo
- **Proyectos / Ideas:** cada carpeta de la carpeta de memoria es una idea.
- **Notas:** las notas conceptuales de la idea seleccionada.
- **＋** junto a "Notas" crea una nota nueva.

### Pestañas centrales
- **Conceptual:** tus notas Markdown. Los `[[enlaces]]` son clicables para saltar
  entre ideas hermanas. Los que no existen aparecen en rojo.
- **Preguntas:** registro de lo que Jarvis anota de la conversación. Cada elemento
  es una casilla en `conceptual/preguntas.md`: `- [x]` ya registrado, `- [ ]`
  pendiente. Los pendientes traen **✓** (guardar) y **✕** (borrar); mientras haya
  pendientes, la pestaña muestra un **!**.
- **Clave (puntos clave):** lo mismo sobre `conceptual/puntos-clave.md`. Los
  puntos clave dan color a las notas relacionadas en el mapa.
- **Mapa:** grafo de notas y sus enlaces `[[…]]` (estilo Obsidian). Arrastra los
  nodos para recolocarlos y pulsa uno para abrir la nota. El color agrupa por
  punto clave.
- **Código:** explora `<memoria>/<idea>/code/`.
- **Bitácora:** explora `<memoria>/<idea>/logs/` (registro del orquestador).

El agente mantiene `preguntas.md` y `puntos-clave.md` por su cuenta: al final de
cada turno anota en ellas lo que merezca quedar registrado (`- [x]`) o lo que
deje a tu criterio (`- [ ]`). Son notas normales: puedes editarlas a mano.

### Edición
- Botón **✎ Editar** para escribir Markdown en crudo.
- **💾 Guardar** (o `Ctrl/Cmd + S`) persiste el `.md` en el disco.
- Al guardar, el fichero queda listo para el commit de Git.

### Barra de órdenes (⌘)
Escribe una instrucción en lenguaje natural y pulsa **Enviar**. Se envía al
orquestador para el proyecto seleccionado. Ejemplos:

```
Añade a la bitácora el estado actual del proyecto
Genera el esqueleto del backend en code/
Revisa las dudas abiertas de qa-dudas y propón respuestas
```

## Flujo recomendado

1. **+ Idea** → nombras la idea. Se crea con `_indice.md` y `qa-dudas.md`.
2. Conversas y escribes el diseño en las notas conceptuales.
3. Cuando quieras ejecutar, escribes la orden en la barra ⌘.
4. El orquestador deja su rastro en la pestaña **Bitácora**.
5. `scripts/backup.sh` (o un cron) sube todo a Git.

## Consejo de seguridad

La interfaz **no tiene autenticación** porque está pensada para la red local.
No la expongas directamente a internet. Si algún día quieres acceso remoto,
usa una VPN (Tailscale, WireGuard) en lugar de abrir el puerto.
