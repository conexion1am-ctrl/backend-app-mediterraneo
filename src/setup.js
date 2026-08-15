const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const setupDatabase = async () => {
  try {
    console.log('🔧 Inicializando base de datos...');

    // Crear tabla usuarios
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        contraseña VARCHAR(255) NOT NULL,
        nombre VARCHAR(255) NOT NULL,
        rol VARCHAR(50) DEFAULT 'usuario',
        estado VARCHAR(50) DEFAULT 'activo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla áreas de trabajo
    await pool.query(`
      CREATE TABLE IF NOT EXISTS areas_trabajo (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        descripcion TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla proyectos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proyectos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        direccion TEXT NOT NULL,
        area_m2 DECIMAL(10, 2),
        descripcion TEXT,
        estado VARCHAR(50) DEFAULT 'activo',
        usuario_id INT REFERENCES usuarios(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla cotizaciones
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cotizaciones (
        id SERIAL PRIMARY KEY,
        numero VARCHAR(100) UNIQUE NOT NULL,
        proyecto_id INT REFERENCES proyectos(id),
        usuario_id INT REFERENCES usuarios(id),
        total DECIMAL(12, 2) DEFAULT 0,
        estado VARCHAR(50) DEFAULT 'pendiente',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla items cotización
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cotizacion_items (
        id SERIAL PRIMARY KEY,
        cotizacion_id INT REFERENCES cotizaciones(id),
        descripcion TEXT NOT NULL,
        cantidad DECIMAL(10, 2),
        precio_unitario DECIMAL(10, 2),
        subtotal DECIMAL(12, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla asignaciones
    await pool.query(`
      CREATE TABLE IF NOT EXISTS asignaciones (
        id SERIAL PRIMARY KEY,
        proyecto_id INT REFERENCES proyectos(id),
        usuario_id INT REFERENCES usuarios(id),
        area_id INT REFERENCES areas_trabajo(id),
        rol VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla mensajes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mensajes (
        id SERIAL PRIMARY KEY,
        proyecto_id INT REFERENCES proyectos(id),
        usuario_id INT REFERENCES usuarios(id),
        contenido TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla archivos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS archivos (
        id SERIAL PRIMARY KEY,
        proyecto_id INT REFERENCES proyectos(id),
        nombre VARCHAR(255) NOT NULL,
        url_firebase TEXT,
        tipo VARCHAR(50),
        usuario_id INT REFERENCES usuarios(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Tablas creadas exitosamente');

    // Insertar áreas de trabajo si no existen
    const areasCheck = await pool.query('SELECT COUNT(*) FROM areas_trabajo');
    if (areasCheck.rows[0].count === '0') {
      const areas = [
        'Obra Civil',
        'Electricidad',
        'Hidráulica',
        'Redes de Gas',
        'Estuco',
        'Enchapes',
        'Pintura',
        'Drywall',
        'Carpintería',
        'Aseo'
      ];

      for (const area of areas) {
        await pool.query('INSERT INTO areas_trabajo (nombre) VALUES ($1)', [area]);
      }
      console.log('✅ Áreas de trabajo insertadas');
    }

  } catch (error) {
    console.error('❌ Error inicializando base de datos:', error.message);
  }
};

module.exports = setupDatabase;