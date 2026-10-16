#!/usr/bin/env python3
"""Redirector fijo al DSH web.

Publica un puerto estable (por defecto el 8080) que responde SIEMPRE con un
302 a la URL real del DSH web, que lleva un token distinto en cada arranque.
Así el usuario guarda un único enlace en el móvil y no tiene que copiar el
token cada vez.

Se lanza desde `arrancar-dsh.sh`:

    redireccionar.py <host> <token=…> [puerto]

El token viaja por argumento desde el propio script; NO se guarda aquí.
"""
import http.server
import socketserver
import sys

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ""
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8080


class RedirectHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        # El token llega como "token=...": se conserva el `?` que espera DSH.
        self.send_header("Location", f"http://{HOST}:3085/?{TOKEN}")
        self.end_headers()

    def log_message(self, *args):  # silencio: no ensuciar el journal
        pass


# Permite reutilizar el puerto inmediatamente tras un reinicio.
socketserver.TCPServer.allow_reuse_address = True

if __name__ == "__main__":
    print(f"Servidor de redirección escuchando en el puerto {PORT}...")
    with socketserver.TCPServer(("0.0.0.0", PORT), RedirectHandler) as httpd:
        httpd.serve_forever()
