# Permisos de sistema

Jarvis **no tiene root**. Cuando el agente necesita algo del sistema (reiniciar
un servicio, tocar `/etc`, GPIO, paquetes…) **pide permiso**; tú lo apruebas
**una a una** con tu **PIN** y un helper de root lo ejecuta. Nada se ejecuta
solo.

## Instalar (una vez, con sudo)

```bash
sudo bash deploy/instalar-permisos.sh
```

Instala:

| Fichero | Qué es |
|---|---|
| `/usr/local/sbin/jarvis-permiso` | el ejecutor (root:root 0755) |
| `/etc/sudoers.d/jarvis-permisos` | la regla (0440, validada con `visudo`) |
| `/etc/jarvis/permisos.hash` | tu PIN, **hasheado** (0600) |

Te pedirá el PIN dos veces. Para cambiarlo:

```bash
sudo JARVIS_PERMISOS_CAMBIAR_PIN=1 bash deploy/instalar-permisos.sh
```

Para desinstalarlo: `sudo bash deploy/instalar-permisos.sh --quitar`.

## Cómo funciona

1. El agente **pide**: `POST /api/projects/<idea>/permisos` con
   `{ "comando": "...", "motivo": "..." }`. Queda en
   `<idea>/logs/permisos/pendientes/` y **no se ejecuta nada**.
2. En la pestaña **Permisos** ves el **comando exacto** y el motivo. Con
   **✓** apruebas (te pide el PIN) y con **✕** rechazas.
3. Al aprobar, el servidor llama a `sudo -n /usr/local/sbin/jarvis-permiso
   aprobar <petición>` y **el PIN va por `stdin`**. El helper lo verifica,
   ejecuta el comando y deja el resultado en
   `<idea>/logs/permisos/resultados/`.

### Garantías

- El helper **solo** ejecuta peticiones que **existen** como fichero pendiente
  bajo la memoria: **jamás** un comando que le llegue por parámetro.
- El PIN **nunca** se guarda en claro ni se registra; solo se compara contra el
  hash de root.
- Tras **5 intentos** fallidos se **bloquea 5 minutos** (fuerza bruta).
- La salida de cada comando se **recorta** (6 KB) antes de guardarse.
- Todo queda en el **historial** de la pestaña Permisos.

## Seguridad: léelo

- El agente y el servidor corren como el **mismo usuario**. Por eso la
  aprobación exige un **secreto que el agente no tiene** (el PIN). Sin PIN, el
  agente podría aprobar sus propias peticiones.
- **Nunca escribas el PIN en el chat**: el chat va al modelo y se guarda en
  `logs/conversacion.jsonl`. El PIN se escribe **solo** en el diálogo de
  aprobación.
- Revisa **siempre** el comando antes de aprobar: se ejecuta **como root**.
- La interfaz **no tiene autenticación** (está pensada para la red local). No la
  expongas a internet; si la usas en remoto, hazlo por VPN.
- El **sandbox** del agente sigue puesto: la raíz es **solo lectura** y la
  escritura está confinada a su workspace. Lo de fuera pasa por este helper.

## Si aprobar falla

- **«no new privileges»**: la unidad `jarvis.service` tiene `NoNewPrivileges=true`
  y eso desactiva `sudo` para todo el servicio. Hay que quitarlo (la plantilla
  `deploy/systemd/jarvis.service.in` ya lo trae así) y reinstalar la unidad:

  ```bash
  sudo bash deploy/instalar.sh --jarvis
  ```

- **«PIN incorrecto»**: prueba otra vez; a los 5 fallos se bloquea 5 minutos
  (`sudo -n /usr/local/sbin/jarvis-permiso estado` dice si está `bloqueado`).
- **«no hay PIN configurado»**: falta el paso del PIN; vuelve a lanzar
  `sudo bash deploy/instalar-permisos.sh`.

## De cara al futuro

El PIN es la primera barrera. La **alternativa robusta** —cuando toque— es
**separar el usuario del agente** del de Jarvis, para que ni siquiera pueda
llamar al helper. Ver `conceptual/permisos-sistema.md`.
