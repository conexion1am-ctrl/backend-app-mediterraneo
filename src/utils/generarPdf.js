// Genera el PDF de cotización/contrato en el servidor (Node), usando el mismo formato de
// carta que ya existe en el frontend (app/utils/generarPdfCotizacion.js), para que quede
// guardado automáticamente en Firebase Storage sin depender de que alguien abra la app.

const formatearMoneda = (valor) => {
  const numero = parseFloat(valor) || 0;
  return numero.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
};

const formatearFechaDdMmAa = (fecha) => {
  if (!fecha) return '';
  const d = new Date(fecha);
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const anio = String(d.getUTCFullYear()).slice(-2);
  return `${dia}-${mes}-${anio}`;
};

// Agrupa los ítems por su campo "seccion". Los que no tienen sección van en un grupo sin
// título, al final. Devuelve una lista de { nombre, items, subtotal }.
function agruparPorSeccion(items) {
  const grupos = [];
  const indicePorNombre = {};
  (items || []).forEach((item) => {
    const nombre = (item.seccion || '').trim();
    const clave = nombre || '__sin_seccion__';
    if (indicePorNombre[clave] === undefined) {
      indicePorNombre[clave] = grupos.length;
      grupos.push({ nombre, items: [] });
    }
    grupos[indicePorNombre[clave]].items.push(item);
  });
  return grupos.map((g) => ({
    ...g,
    subtotal: g.items.reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0),
  }));
}

// condicionesPago: array de { porcentaje, descripcion }. Se muestra como lista con viñetas,
// sin recuadros ni tabla, tal como se definió: "25% — descripción".
function listaCondicionesPago(condicionesPago) {
  if (!Array.isArray(condicionesPago) || condicionesPago.length === 0) return '';
  const filas = condicionesPago
    .filter((c) => c.porcentaje || c.descripcion)
    .map((c) => `<li>${c.porcentaje ? `${c.porcentaje}% — ` : ''}${c.descripcion || ''}</li>`)
    .join('');
  return filas ? `<ul>${filas}</ul>` : '';
}

function construirHtml({
  tipoDocumento, empresa, cliente, numero, fecha, items, total, fechaEntrega,
  ciudad, propietario, parrafo, descuento, condicionesPago, tiempoEntrega, firmante,
}) {
  const colorEmpresa = empresa?.color_hex || '#1E90FF';
  const grupos = agruparPorSeccion(items);
  const subtotalBruto = (items || []).reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0);
  const valorDescuento = parseFloat(descuento) || 0;

  const filaItem = (item, index) => `
    <tr style="background:${index % 2 === 0 ? '#fff' : '#f7f7f7'};">
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:center;">${item.cantidad != null && item.cantidad !== '' ? item.cantidad : '-'}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee;">${item.descripcion || ''}${item.adicional ? ' <span style="color:#888; font-size:11px;">(adicional)</span>' : ''}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:right;">${formatearMoneda(item.valor)}</td>
    </tr>`;

  const tablasSecciones = grupos
    .map((grupo) => `
      ${grupo.nombre ? `<p class="tituloSeccion">${grupo.nombre.toUpperCase()}</p>` : ''}
      <table>
        <thead>
          <tr>
            <th class="cantidad">Cant.</th>
            <th>Descripción</th>
            <th class="valor">Valor</th>
          </tr>
        </thead>
        <tbody>
          ${grupo.items.map(filaItem).join('')}
          <tr class="subtotalFila">
            <td></td>
            <td>SUBTOTAL</td>
            <td style="text-align:right;">${formatearMoneda(grupo.subtotal)}</td>
          </tr>
        </tbody>
      </table>`)
    .join('');

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: Helvetica, Arial, sans-serif; color: #222; padding: 28px; font-size: 13px; line-height: 1.5; }
        .encabezado { display:flex; align-items:center; gap:14px; border-bottom: 3px solid ${colorEmpresa}; padding-bottom: 16px; margin-bottom: 20px; }
        .logo { width: 64px; height: 64px; border-radius: 32px; object-fit: cover; }
        .empresaNombre { font-size: 20px; font-weight: bold; color: ${colorEmpresa}; margin: 0; }
        .empresaWeb { font-size: 12px; color: #888; margin: 2px 0 0 0; }
        .tituloDoc { font-size: 16px; font-weight: bold; text-align:center; margin: 0 0 18px 0; color:${colorEmpresa}; letter-spacing: 1px; }
        .fechaCiudad { text-align: right; margin-bottom: 10px; }
        p { margin: 6px 0; }
        .tituloSeccion { font-weight: bold; margin: 18px 0 4px 0; color: ${colorEmpresa}; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        th { text-align:left; background:${colorEmpresa}; color:#fff; padding:8px 10px; font-size:12px; }
        th.cantidad { text-align:center; width: 50px; }
        th.valor { text-align:right; width: 110px; }
        .subtotalFila td { padding:8px 10px; font-weight:bold; border-top: 1px solid ${colorEmpresa}; background:#f2f2f2; }
        .resumen { margin-top: 18px; width: 100%; border-collapse: collapse; }
        .resumen td { padding: 6px 10px; font-size: 13px; }
        .resumen .totalGeneral td { font-weight: bold; font-size: 15px; border-top: 2px solid ${colorEmpresa}; padding-top: 10px; }
        .resumen .descuentoFila td { color: #c0392b; }
        .resumen td.etiqueta { text-align: left; }
        .resumen td.monto { text-align: right; }
        .condiciones { margin-top: 24px; }
        .condiciones ul { margin: 6px 0; padding-left: 20px; list-style: disc; }
        .condiciones li { margin: 3px 0; }
        .firma { margin-top: 30px; }
        .pie { margin-top: 30px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="encabezado">
        ${empresa?.logo_url ? `<img class="logo" src="${empresa.logo_url}" />` : ''}
        <div>
          <p class="empresaNombre">${empresa?.nombre || ''}</p>
          ${empresa?.sitio_web ? `<p class="empresaWeb">${empresa.sitio_web}</p>` : ''}
        </div>
      </div>

      <p class="tituloDoc">${tipoDocumento === 'contrato' ? 'CONTRATO DE OBRA' : 'COTIZACIÓN'}${numero ? ` N° ${numero}` : ''}</p>

      <p class="fechaCiudad">${ciudad ? `${ciudad}, ` : ''}${formatearFechaDdMmAa(fecha || new Date())}</p>

      <p>Señor(a)<br/>${propietario || cliente?.nombre || ''}${cliente?.nombre_proyecto ? `<br/>${cliente.nombre_proyecto}` : ''}</p>

      <p>Cordial saludo:</p>

      ${parrafo ? `<p>${parrafo}</p>` : ''}

      ${tablasSecciones}

      <table class="resumen">
        <tbody>
          <tr>
            <td class="etiqueta">Subtotal</td>
            <td class="monto">${formatearMoneda(subtotalBruto)}</td>
          </tr>
          ${valorDescuento > 0 ? `
          <tr class="descuentoFila">
            <td class="etiqueta">Descuento</td>
            <td class="monto">- ${formatearMoneda(valorDescuento)}</td>
          </tr>` : ''}
          <tr class="totalGeneral">
            <td class="etiqueta">TOTAL</td>
            <td class="monto">${formatearMoneda(total)}</td>
          </tr>
        </tbody>
      </table>

      ${(condicionesPago && condicionesPago.length) || tiempoEntrega ? `
      <div class="condiciones">
        ${condicionesPago && condicionesPago.length ? `<p><strong>Condiciones de pago:</strong></p>${listaCondicionesPago(condicionesPago)}` : ''}
        ${tiempoEntrega ? `<p><strong>Tiempo de entrega:</strong> ${tiempoEntrega}</p>` : ''}
      </div>` : ''}

      ${fechaEntrega ? `<p><strong>Fecha de entrega estimada:</strong> ${formatearFechaDdMmAa(fechaEntrega)}</p>` : ''}

      <p>Agradecemos por contar con nuestra empresa y estaremos atentos a resolver cualquier inquietud sobre esta ${tipoDocumento === 'contrato' ? 'contrato' : 'cotización'}.</p>

      <div class="firma">
        <p>Atentamente,</p>
        <p><strong>${firmante || ''}</strong><br/>${empresa?.nombre || ''}</p>
      </div>

      <p class="pie">Generado desde ${empresa?.nombre || 'C&D Manager'}</p>
    </body>
  </html>`;
}

// Convierte el HTML a un PDF (Buffer) usando Puppeteer con Chromium empaquetado para entornos
// tipo Render (sin depender de que Chrome esté instalado en el sistema).
async function generarPdfBuffer(datos) {
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');

  const html = construirHtml(datos);

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.pdf({ format: 'letter', printBackground: true });
    return buffer;
  } finally {
    await browser.close();
  }
}

module.exports = { construirHtml, generarPdfBuffer };
