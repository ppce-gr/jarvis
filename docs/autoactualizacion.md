# Autoactualización con reversión

Jarvis puede ponerse al día solo, y **volver atrás si el código nuevo no
arranca**. Este documento explica el método y, sobre todo, **por qué es así**:
es la pieza que puede dejar la Raspberry sin arrancar.

---

## El problema de fondo: nadie se opera a sí mismo

Un proceso no puede reiniciarse y comprobar con fiabilidad que el reinicio ha
ido bien: si el código nuevo no arranca, se queda sin la herramienta que haría
la recuperación. En una Pi sin pantalla eso significa sacar la tarjeta.

La solución es que **el disparo lo dé Jarvis y la ejecución la haga systemd**,
desde fuera de su árbol de procesos:

```text
Jarvis  ──(touch .update-request)──▶  systemd lo detecta
      (sin privilegios)                    │
                                           ▼
                          jarvis-autoupdate.service  ← FUERA de Jarvis
                                           │
                                           ▼
                          /usr/local/sbin/jarvis-actualizar
                                           │
                            reinicia, comprueba y revierte
```

Dos detalles deliberados:

- **Jarvis no necesita root.** Sólo escribe un fichero. Toda la parte peligrosa
  vive fuera.
- **El actualizador se instala fuera del repositorio.** Bash lee el fichero
  mientras lo interpreta, así que un script que se automodifica es una bomba.
  La copia que se ejecuta es `/usr/local/sbin/jarvis-actualizar`; la del
  repositorio es sólo la fuente. **Si cambias el script, hay que reinstalarlo.**

## Las cinco barreras

En orden de coste, para fallar lo antes posible y sin tocar nada:

| # | Barrera | Qué pasa si falla |
|---|---|---|
| 1 | **Árbol limpio** | Aborta. Con cambios sin commitear no se toca nada: por construcción no se pierde trabajo |
| 2 | **Respaldo previo** de los dos repos | Aborta. Sin respaldo no se actualiza |
| 3 | **Fast-forward only** | Aborta. Si hay commits locales que no están en el remoto, **no fusiona ni sobrescribe** |
| 4a | **Suite de pruebas** del código nuevo | Revierte el código y aborta. **Jarvis ni se entera** |
| 4b | **Arranque real** en un puerto aparte | Igual: revierte y aborta |
| 5 | **Reinicio + comprobación de salud** | Si no responde, revierte al último commit **probado** |

### Por qué la barrera 4b es la importante

Pasar los tests **no** demuestra que el servidor arranque: no verifica puertos,
ni variables de entorno, ni que la interfaz se sirva. La barrera 4b **levanta el
servidor de verdad** en el puerto 3099, con una carpeta de memoria **temporal**
(para no tocar las notas reales), comprueba que responde y lo mata.

Si eso falla, se revierte el código y **el servicio nunca se reinicia**: el
Jarvis en marcha sigue con el código anterior, intacto. Es el momento más
valioso del diseño, porque convierte el reinicio en algo casi sin riesgo.

### Dos anclas, no una

- **`PREV`**: el commit inmediatamente anterior. Se usa para revertir un
  fast-forward fallido.
- **`LAST_GOOD`**: el último commit que **pasó una comprobación de salud real**.
  Se guarda en `.update-state/last-good` y sólo se actualiza tras un arranque
  correcto.

Al revertir se usa `LAST_GOOD`, no `PREV`. Es más seguro: `PREV` podría ser un
commit que nunca llegó a funcionar.

## Uso

```bash
# Actualizar (lo normal es pedirlo desde la interfaz)
sudo -u jarvis /usr/local/sbin/jarvis-actualizar

# Sólo mirar si hay novedades
sudo -u jarvis /usr/local/sbin/jarvis-actualizar --check

# Volver al último commit que funcionó
sudo -u jarvis /usr/local/sbin/jarvis-actualizar --rollback

# Simular sin tocar nada
sudo -u jarvis /usr/local/sbin/jarvis-actualizar --dry-run
```

Desde la interfaz: la píldora de versión de la cabecera abre el panel, con
**Buscar novedades** y **Actualizar**. Los mismos endpoints:

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/system/status` | Versión, estado del árbol, ancla y última ejecución |
| `POST` | `/api/system/update` | Deja la bandera (responde `202`) |
| `POST` | `/api/system/check` | Consulta el remoto; no aplica nada |

Y para dispararlo a mano sin la interfaz:

```bash
touch /home/jarvis/jarvis/.update-request
```

## Instalación

**Prerequisito:** el servicio tiene que existir. Sin él no hay nada que
reiniciar ni cuya salud comprobar, y el actualizador se niega con un mensaje
claro.

```bash
sudo bash deploy/instalar.sh --jarvis       # primero el servicio
sudo bash deploy/instalar.sh --autoupdate   # luego la actualización
```

Esto instala el actualizador en `/usr/local/sbin/`, las tres unidades
(`.service`, `.path`, `.timer`) y una regla de sudoers **de un solo comando**:

```
jarvis ALL=(root) NOPASSWD: /usr/bin/systemctl restart jarvis.service
```

Es lo único que necesita privilegios. El resto (git, npm, curl) corre como el
usuario normal, para que los ficheros del repositorio no pasen a ser de root.
La regla se **valida con `visudo -cf` antes de instalarla**: un fichero mal
formado en `/etc/sudoers.d` rompe `sudo` entero, y en una Pi sin pantalla eso es
quedarse fuera del sistema.

### Disparadores

| Cuál | Cuándo |
|---|---|
| `jarvis-autoupdate.path` | Cuando aparece `.update-request` (botón de la interfaz o `touch`) |
| `jarvis-autoupdate.timer` | Cada día a las 04:30, con hasta 30 min de dispersión |

El temporizador se puede desactivar si prefieres decidir tú:

```bash
sudo systemctl disable --now jarvis-autoupdate.timer
```

## El riesgo que hay que asumir con los ojos abiertos

**Autoactualizar es ejecución remota de código por diseño.** Quien pueda
escribir en `main` ejecuta código en la Pi. Mitigaciones:

- Sólo se sigue `main`, nunca ramas de terceros.
- `--ff-only`: nada de fusiones automáticas.
- Las cinco barreras, con reversión automática.
- La credencial es una **deploy key de un solo repositorio** con escritura.
- El árbol tiene que estar limpio: no se actualiza con trabajo a medias.

Pero si esa clave se filtra, hay ejecución remota en la Pi. Es el precio de la
comodidad, y conviene saberlo.

## Lo que este mecanismo NO hace

- **No migra formatos de datos.** Si una versión futura cambia el formato de las
  notas, hace falta una migración aparte. Actualizar sólo cambia el código.
- **No toca la memoria.** El repositorio del cerebro es otro, así que una
  actualización de código no puede perder notas. Eso es por diseño.
- **No reinstala el propio actualizador.** Si `scripts/autoactualizar.sh` cambia,
  hay que volver a ejecutar `--autoupdate`. Es deliberado: systemd ejecuta una
  copia en `/usr/local/sbin` que es de **root**, así que el actualizador no puede
  escribir ahí, y reescribirse a sí mismo mientras bash lo interpreta sería
  peligroso. Para que no vuelva a pasar inadvertido, tanto el actualizador como
  el panel **comparan la copia instalada con la del repositorio y avisan** si no
  coinciden (campos `actualizadorComprobado` y `actualizadorDesfasado`).

## Cuando algo va mal

| Síntoma | Qué hacer |
|---|---|
| «hay cambios sin commitear» | Commitea o descarta en el repositorio de código |
| Commits locales sin subir | Nada: se respaldan solos antes de actualizar |
| «las ramas han divergido DE VERDAD» | Hay commits en local **y** en el remoto que no están en el otro. No se toca nada: resuélvelo a mano |
| «el ACTUALIZADOR INSTALADO no coincide con el del repositorio» | No se actualiza solo: `sudo bash deploy/instalar.sh --autoupdate` |
| «el servicio no está instalado» | `sudo bash deploy/instalar.sh --jarvis` |
| Se revirtió solo | Mira el registro: `.update-state/autoactualizacion.log` |
| Ni con el commit probado arranca | Intervención manual: `journalctl -u jarvis` |

### Las tres relaciones entre local y remoto

Antes sólo se contemplaban dos, y eso era un fallo de diseño que bloqueaba la
automodificación: en cuanto Jarvis commiteaba en esta misma máquina, el
repositorio quedaba «por delante» y el actualizador lo confundía con una
divergencia. Como el aborto ocurría **antes** del respaldo, esos commits tampoco
se subían nunca: bloqueo definitivo, con trabajo real sin respaldar.

| Relación | Qué significa | Qué hace el actualizador |
|---|---|---|
| **igual** | Local y remoto en el mismo commit | Sólo reinicia si el servicio va por detrás |
| **detrás** | El remoto trae commits nuevos | Respalda, fast-forward, verifica y reinicia |
| **delante** | Hay commits locales sin subir | **Los respalda** y, si procede, verifica y reinicia |
| **divergido** | Cada lado tiene commits que el otro no tiene | Aborta sin tocar nada |

Sólo el último caso es irresoluble de forma automática; los otros tres se
resuelven sin intervención.

El registro completo de cada intento está en
`/home/jarvis/jarvis/.update-state/autoactualizacion.log`, y cada resultado se
anota además en la bitácora del proyecto.
