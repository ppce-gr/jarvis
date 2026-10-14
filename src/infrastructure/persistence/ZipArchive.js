import { deflateRawSync } from 'node:zlib';

/**
 * Infraestructura: ZipArchive
 * ==================================================================
 * Generador de ficheros **ZIP** en memoria, sin dependencias. Se usa para
 * descargar una carpeta entera del explorador: se recorren sus ficheros y se
 * empaquetan al vuelo.
 *
 * Formato: cabecera local + datos por entrada, directorio central y registro
 * final (End Of Central Directory). Los nombres van con barras `/` y marca
 * UTF-8; cada fichero se comprime con deflate y, si no gana nada, se guarda
 * tal cual.
 */

const CRC_TABLE = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Fecha/hora en el formato MS-DOS que usa el ZIP. */
function dosFecha(d) {
  const time = ((d.getHours() & 0x1f) << 11)
    | ((d.getMinutes() & 0x3f) << 5)
    | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9)
    | (((d.getMonth() + 1) & 0x0f) << 5)
    | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * Construye un ZIP a partir de una lista de ficheros.
 * @param {Array<{name: string, data: Buffer|string}>} entradas
 * @returns {Buffer}
 */
export function crearZip(entradas = []) {
  const partes = [];
  const central = [];
  const { time, date } = dosFecha(new Date());
  let offset = 0;

  for (const entrada of entradas) {
    const nombre = Buffer.from(String(entrada.name).replace(/\\/g, '/'), 'utf8');
    const datos = Buffer.isBuffer(entrada.data) ? entrada.data : Buffer.from(entrada.data ?? '');
    const comprimido = deflateRawSync(datos);
    const usarDeflate = comprimido.length < datos.length;
    const cuerpo = usarDeflate ? comprimido : datos;
    const metodo = usarDeflate ? 8 : 0;
    const crc = crc32(datos);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // firma
    local.writeUInt16LE(20, 4);           // versión necesaria
    local.writeUInt16LE(0x0800, 6);       // nombres UTF-8
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(cuerpo.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);           // extra
    partes.push(local, nombre, cuerpo);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // firma directorio central
    cd.writeUInt16LE(20, 4);              // versión que lo creó
    cd.writeUInt16LE(20, 6);              // versión necesaria
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(metodo, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(cuerpo.length, 20);
    cd.writeUInt32LE(datos.length, 24);
    cd.writeUInt16LE(nombre.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comentario
    cd.writeUInt16LE(0, 34);              // disco
    cd.writeUInt16LE(0, 36);              // atributos internos
    cd.writeUInt32LE(0, 38);              // atributos externos
    cd.writeUInt32LE(offset, 42);         // offset de la cabecera local
    central.push(cd, nombre);

    offset += local.length + nombre.length + cuerpo.length;
  }

  const cdBuffer = Buffer.concat(central);
  const total = entradas.length;
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);       // firma EOCD
  fin.writeUInt16LE(0, 4);                // nº de disco
  fin.writeUInt16LE(0, 6);                // disco del directorio
  fin.writeUInt16LE(total, 8);            // entradas en este disco
  fin.writeUInt16LE(total, 10);           // entradas totales
  fin.writeUInt32LE(cdBuffer.length, 12);
  fin.writeUInt32LE(offset, 16);          // offset del directorio central
  fin.writeUInt16LE(0, 20);               // comentario

  return Buffer.concat([...partes, cdBuffer, fin]);
}
