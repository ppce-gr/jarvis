# Guía de migración a otro hardware

Objetivo: llevarte Jarvis completo (ideas, código, bitácoras y programa) a otra
máquina —una Pi más potente, un mini-PC, un servidor casero— en pocos minutos.

Todo el sistema es **portable por diseño**: no hay base de datos, ni rutas
absolutas grabadas a fuego, ni dependencias compiladas.

---

## 1. Antes de migrar: sube todo a Git

En la Raspberry actual:

```bash
bash scripts/backup.sh "chore: estado antes de migrar"
git remote add origin <url-de-tu-repo>   # sólo la primera vez
git push -u origin main
```

> **¿Un repo o varios?** Uno solo. Este repositorio contiene el programa, la
> documentación y tus ideas. Un único `git clone` te devuelve el sistema entero.
> Si algún proyecto concreto crece y quieres su propio repo, puede convertirse
> en un remoto adicional, pero el repo raíz siempre debe poder reconstruir todo.

---

## 2. En la máquina nueva

Requisitos: **Node.js 20 o superior** y **Git**.

```bash
git clone <url-de-tu-repo> jarvis
cd jarvis
npm test        # verifica que todo está sano
npm start       # arranca la interfaz
```

No hay `npm install` porque no hay dependencias de runtime. Si en el futuro se
añaden, este paso aparecerá aquí y en `scripts/deploy.sh`.

---

## 3. Qué NO viaja por Git (y por qué da igual)

| Elemento | Motivo | Qué hacer |
|---|---|---|
| `projects/*/logs/*.log` | Ruido de ejecución | Se regeneran; opcional versionarlos |
| Ficheros temporales | Basura | Ignorados por `.gitignore` |
| El propio `node_modules` | No existe (cero dependencias) | — |

Todo lo que define el sistema (código, docs, ideas, servicios, scripts) **sí**
viaja en el repositorio.

---

## 4. Comprobaciones tras migrar

```bash
npm test                                  # 19 pruebas en verde
curl -s localhost:3081/api/health         # {"status":"ok"}
curl -s localhost:3081/api/projects       # aparecen tus ideas
```

Abre `http://<nueva-ip>:3081` y verifica que ves tus proyectos y notas.

---

## 5. Si quieres arranque automático

Copia la unidad de ejemplo y ajústala:

```bash
sudo cp scripts/jarvis.service /etc/systemd/system/jarvis.service
sudo nano /etc/systemd/system/jarvis.service   # ajusta User y rutas
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis
```

Para el respaldo periódico en Git:

```bash
crontab -e
# cada 30 minutos, commit de seguridad
*/30 * * * * /home/<usuario>/jarvis/scripts/backup.sh
```

---

## 6. Notas específicas de la Raspberry Pi 3B

- **Memoria:** el proceso en reposo consume muy poco (servidor `http` nativo y
  ficheros estáticos). No instales frameworks pesados.
- **SD:** cuanto más se escriba, antes se desgasta. Mantén los logs pequeños y
  evita el *watch* permanente (`npm run dev`) en producción.
- **Nube:** el LLM vive detrás de una API. Si algún día montas un modelo local
  en un PC potente, sólo tienes que escribir un `OrchestratorPort` nuevo que
  apunte a ese servidor: el resto del sistema no cambia.
