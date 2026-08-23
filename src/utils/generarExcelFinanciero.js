// Genera el estado financiero de un proyecto en Excel (.xlsx), a partir de los mismos datos
// que ya calcula GET /estadisticas/:proyecto_id (valor del contrato, abonos, costos por tipo,
// resumen por categoría y el historial completo de movimientos). Se sube a Firebase Storage
// igual que los PDF de cotización/contrato, usando subirBufferAStorage.

const ExcelJS = require('exceljs');

const ETIQUETAS_TIPO = { materiales: 'Materiales', mano_obra: 'Mano de obra', imprevistos: 'Imprevistos' };

function formatearFecha(fecha) {
  if (!fecha) return '';
  const d = new Date(fecha);
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const anio = d.getUTCFullYear();
  return `${dia}/${mes}/${anio}`;
}

// Aplica formato de moneda colombiana (sin decimales) a una celda.
function aplicarFormatoMoneda(celda) {
  celda.numFmt = '"$"#,##0;[Red]-"$"#,##0';
}

async function generarExcelFinancieroBuffer({ proyectoNombre, empresaNombre, stats }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = empresaNombre || 'C&D Manager';
  workbook.created = new Date();

  const costosTotal =
    parseFloat(stats.costos_materiales || 0) +
    parseFloat(stats.valor_mano_obra || 0) +
    parseFloat(stats.valor_imprevistos || 0);

  // ---------- Hoja 1: Resumen ----------
  const hojaResumen = workbook.addWorksheet('Resumen');
  hojaResumen.columns = [{ width: 34 }, { width: 22 }];

  hojaResumen.mergeCells('A1:B1');
  hojaResumen.getCell('A1').value = empresaNombre || '';
  hojaResumen.getCell('A1').font = { bold: true, size: 14 };

  hojaResumen.mergeCells('A2:B2');
  hojaResumen.getCell('A2').value = `Estado financiero — ${proyectoNombre}`;
  hojaResumen.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF444444' } };

  hojaResumen.mergeCells('A3:B3');
  hojaResumen.getCell('A3').value = `Generado el ${formatearFecha(new Date())}`;
  hojaResumen.getCell('A3').font = { italic: true, size: 9, color: { argb: 'FF888888' } };

  const filasResumen = [
    ['Valor del contrato', parseFloat(stats.valor_contrato || 0)],
    ['Total abonado por el cliente', parseFloat(stats.total_abonado || 0)],
    ['Saldo pendiente por cobrar', parseFloat(stats.saldo_pendiente || 0)],
    [null, null],
    ['Costos en materiales', parseFloat(stats.costos_materiales || 0)],
    ['Costos en mano de obra', parseFloat(stats.valor_mano_obra || 0)],
    ['Costos en imprevistos', parseFloat(stats.valor_imprevistos || 0)],
    ['Total de costos', costosTotal],
    [null, null],
    ['Utilidad del proyecto', parseFloat(stats.utilidad || 0)],
  ];

  let fila = 5;
  filasResumen.forEach(([etiqueta, valor]) => {
    if (etiqueta === null) {
      fila += 1;
      return;
    }
    const celdaEtiqueta = hojaResumen.getCell(`A${fila}`);
    const celdaValor = hojaResumen.getCell(`B${fila}`);
    celdaEtiqueta.value = etiqueta;
    celdaValor.value = valor;
    aplicarFormatoMoneda(celdaValor);
    if (etiqueta === 'Total de costos' || etiqueta === 'Utilidad del proyecto') {
      celdaEtiqueta.font = { bold: true };
      celdaValor.font = { bold: true, color: { argb: valor < 0 ? 'FFC62828' : 'FF2E7D32' } };
    }
    fila += 1;
  });

  // ---------- Hoja 2: Costos por categoría ----------
  const hojaCategorias = workbook.addWorksheet('Costos por categoría');
  hojaCategorias.columns = [
    { header: 'Categoría', key: 'categoria', width: 26 },
    { header: 'Materiales', key: 'materiales', width: 16 },
    { header: 'Mano de obra', key: 'mano_obra', width: 16 },
    { header: 'Imprevistos', key: 'imprevistos', width: 16 },
    { header: 'Total', key: 'total', width: 16 },
  ];
  hojaCategorias.getRow(1).font = { bold: true };

  (stats.resumen_por_categoria || []).forEach((cat) => {
    const filaAgregada = hojaCategorias.addRow({
      categoria: cat.categoria_nombre,
      materiales: parseFloat(cat.total_materiales || 0),
      mano_obra: parseFloat(cat.total_mano_obra || 0),
      imprevistos: parseFloat(cat.total_imprevistos || 0),
      total: parseFloat(cat.total || 0),
    });
    ['materiales', 'mano_obra', 'imprevistos', 'total'].forEach((key) => {
      aplicarFormatoMoneda(filaAgregada.getCell(key));
    });
  });

  if (!stats.resumen_por_categoria || stats.resumen_por_categoria.length === 0) {
    hojaCategorias.addRow({ categoria: 'Sin movimientos con categoría asignada todavía' });
  }

  // ---------- Hoja 3: Historial de movimientos de costos ----------
  const hojaMovimientos = workbook.addWorksheet('Movimientos de costos');
  hojaMovimientos.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Categoría', key: 'categoria', width: 22 },
    { header: 'Tipo', key: 'tipo', width: 14 },
    { header: 'Detalle', key: 'detalle', width: 34 },
    { header: 'Valor', key: 'valor', width: 16 },
  ];
  hojaMovimientos.getRow(1).font = { bold: true };

  (stats.movimientos_costos || []).forEach((m) => {
    const filaAgregada = hojaMovimientos.addRow({
      fecha: formatearFecha(m.fecha),
      categoria: m.categoria_nombre || 'Sin categoría',
      tipo: ETIQUETAS_TIPO[m.tipo] || m.tipo,
      detalle: m.detalle || '',
      valor: parseFloat(m.valor || 0),
    });
    aplicarFormatoMoneda(filaAgregada.getCell('valor'));
  });

  if (!stats.movimientos_costos || stats.movimientos_costos.length === 0) {
    hojaMovimientos.addRow({ fecha: 'Sin movimientos registrados todavía' });
  }

  // ---------- Hoja 4: Historial de abonos ----------
  const hojaAbonos = workbook.addWorksheet('Abonos del cliente');
  hojaAbonos.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Valor abonado', key: 'valor', width: 18 },
  ];
  hojaAbonos.getRow(1).font = { bold: true };

  (stats.abonos || []).forEach((a) => {
    const filaAgregada = hojaAbonos.addRow({ fecha: formatearFecha(a.fecha), valor: parseFloat(a.valor || 0) });
    aplicarFormatoMoneda(filaAgregada.getCell('valor'));
  });

  if (!stats.abonos || stats.abonos.length === 0) {
    hojaAbonos.addRow({ fecha: 'Sin abonos registrados todavía' });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

module.exports = { generarExcelFinancieroBuffer };
