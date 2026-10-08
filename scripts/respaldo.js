// Respaldo manual de la base de datos (2026-10-08).
// Descarga TODAS las tablas a archivos .json dentro de la carpeta "respaldos/<fecha>".
// Solo LEE la base de datos: no modifica ni borra nada.
// Uso (desde la carpeta del backend):  node scripts/respaldo.js
// La carpeta "respaldos/" está en .gitignore a propósito: contiene datos reales y NO debe subirse a GitHub.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Pool } = require('pg');

function preguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(texto, (r) => { rl.close(); resolve(r.trim()); }));
}

async function main() {
  const url = process.env.DATABASE_URL_RESPALDO || (await preguntar('Pega aquí la DATABASE_URL y pulsa Enter: '));
  if (!url.startsWith('postgres')) {
    console.error('❌ Eso no parece una dirección de base de datos (debe empezar con postgresql://)');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const ahora = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const carpetaNombre = `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())}_${pad(ahora.getHours())}${pad(ahora.getMinutes())}`;
  const carpeta = path.join(__dirname, '..', 'respaldos', carpetaNombre);
  fs.mkdirSync(carpeta, { recursive: true });

  try {
    const tablas = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    );
    const resumen = {};
    for (const { table_name } of tablas.rows) {
      const datos = await pool.query(`SELECT * FROM "${table_name}"`);
      fs.writeFileSync(path.join(carpeta, `${table_name}.json`), JSON.stringify(datos.rows, null, 2));
      resumen[table_name] = datos.rows.length;
      console.log(`✓ ${table_name}: ${datos.rows.length} filas`);
    }
    fs.writeFileSync(path.join(carpeta, '_resumen.json'), JSON.stringify({ fecha: ahora.toISOString(), filas_por_tabla: resumen }, null, 2));
    console.log(`\n✅ Respaldo listo en: ${carpeta}`);
  } catch (error) {
    console.error('❌ No se pudo completar el respaldo:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
