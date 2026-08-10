const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

const areas = [
  { nombre: 'Obra Civil', descripcion: 'Reformas, mortero, reboque' },
  { nombre: 'Electricidad', descripcion: 'Instalaciones eléctricas' },
  { nombre: 'Hidráulica', descripcion: 'Sistemas de agua' },
  { nombre: 'Redes de Gas', descripcion: 'Instalación de gas' },
  { nombre: 'Estuco', descripcion: 'Acabado en estuco' },
  { nombre: 'Enchapes', descripcion: 'Instalación de cerámica y porcelanato' },
  { nombre: 'Pintura', descripcion: 'Pintura y acabados' },
  { nombre: 'Drywall', descripcion: 'Cielo falso y divisiones' },
  { nombre: 'Carpintería', descripcion: 'Muebles y puertas' },
  { nombre: 'Aseo', descripcion: 'Limpieza y detalles finales' }
];

const insertAreas = async () => {
  try {
    for (const area of areas) {
      await pool.query(
        'INSERT INTO areas_trabajo (nombre, descripcion) VALUES ($1, $2)',
        [area.nombre, area.descripcion]
      );
    }
    console.log('✓ 10 áreas de trabajo insertadas');
    pool.end();
  } catch (error) {
    console.error('✗ Error:', error);
    pool.end();
  }
};

insertAreas();