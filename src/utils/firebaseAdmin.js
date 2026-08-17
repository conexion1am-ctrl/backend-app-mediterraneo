// firebase-admin@14 cambió su forma de importarse: ya no existe el objeto clásico
// `admin.apps` / `admin.storage()` en la raíz del paquete. Ahora cada pieza se importa por
// separado desde subrutas ("API modular"). Usar la forma vieja hacía que el servidor se
// cayera al arrancar (admin.apps era undefined), dejando el deploy en Render "fallido" y
// el servidor corriendo código viejo indefinidamente.
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const path = require('path');
const fs = require('fs');

// Inicializa Firebase Admin con la clave de servicio (archivo local, NUNCA se sube a GitHub —
// está en .gitignore). En Render, esta misma variable de entorno FIREBASE_SERVICE_ACCOUNT_JSON
// se configura manualmente pegando el contenido del archivo .json como texto, ya que Render no
// tiene el archivo local.
function cargarCredenciales() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const rutaLocal = path.join(__dirname, '../../firebase-service-account.json');
  if (fs.existsSync(rutaLocal)) {
    return JSON.parse(fs.readFileSync(rutaLocal, 'utf8'));
  }
  return null;
}

let bucket = null;

// Todo este bloque está envuelto en try/catch: si algo falla al inicializar Firebase (JSON mal
// formado, versión de firebase-admin incompatible, etc.), el servidor completo NO debe caerse
// por esto — el resto de la app (base de datos, login, chat, etc.) debe seguir funcionando
// igual, solo sin la capacidad de subir/borrar archivos de Storage desde el servidor.
try {
  const credenciales = cargarCredenciales();

  if (credenciales) {
    if (getApps().length === 0) {
      initializeApp({
        credential: cert(credenciales),
        storageBucket: 'cyd-manager.firebasestorage.app',
      });
    }
    bucket = getStorage().bucket();
  } else {
    console.warn('⚠️ Firebase Admin no configurado: falta firebase-service-account.json o FIREBASE_SERVICE_ACCOUNT_JSON. No se podrán borrar ni subir archivos de Storage desde el servidor.');
  }
} catch (error) {
  console.error('⚠️ Error inicializando Firebase Admin (el servidor sigue funcionando, pero sin Storage):', error.message);
}

// Extrae el "path" interno del archivo dentro del bucket a partir de una URL de descarga de
// Firebase Storage (la que guardamos en la base de datos), por ejemplo:
// https://firebasestorage.googleapis.com/v0/b/cyd-manager.firebasestorage.app/o/fotos%2F123.jpg?alt=media...
function extraerPathDesdeUrl(url) {
  try {
    const marcador = '/o/';
    const inicio = url.indexOf(marcador);
    if (inicio === -1) return null;
    const despuesDeO = url.substring(inicio + marcador.length);
    const finPath = despuesDeO.indexOf('?');
    const pathCodificado = finPath === -1 ? despuesDeO : despuesDeO.substring(0, finPath);
    return decodeURIComponent(pathCodificado);
  } catch (error) {
    return null;
  }
}

// Borra un archivo de Firebase Storage a partir de su URL de descarga guardada en la base de
// datos. No lanza error si el archivo ya no existe o si Firebase Admin no está configurado
// (para no romper el borrado del registro en la base de datos por un archivo que ya no está).
async function borrarArchivoDeStorage(url) {
  if (!url || !bucket) return;
  const filePath = extraerPathDesdeUrl(url);
  if (!filePath) return;
  try {
    await bucket.file(filePath).delete();
  } catch (error) {
    if (error.code !== 404) {
      console.error('Error borrando archivo de Storage:', filePath, error.message);
    }
  }
}

// Sube un buffer (ej: un PDF generado en el servidor) a Firebase Storage y devuelve su URL
// de descarga pública, en el mismo formato que usa el frontend al subir archivos.
async function subirBufferAStorage(buffer, rutaDestino, contentType) {
  if (!bucket) throw new Error('Firebase Admin no está configurado en el servidor');
  const file = bucket.file(rutaDestino);
  const token = require('crypto').randomUUID();
  await file.save(buffer, {
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  const bucketName = bucket.name;
  const pathCodificado = encodeURIComponent(rutaDestino);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${pathCodificado}?alt=media&token=${token}`;
}

module.exports = { borrarArchivoDeStorage, subirBufferAStorage, bucket };
