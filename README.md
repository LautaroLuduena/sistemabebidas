# 🥤 Sistema Bebidas

Sistema de gestión para una distribuidora de bebidas **mayorista y minorista**: caja, ventas, compras, cuentas corrientes de clientes y proveedores, inventario con stock, catálogo con fotos y códigos de barras, y listas de precios descargables.

Funciona en tu computadora (Windows, Mac o Linux) y se usa desde el navegador. También se puede abrir desde el celular o la tablet si están en la misma red WiFi.

## Funciones

| Módulo | Qué hace |
|---|---|
| **Inicio** | Saldos de ambas cajas, cuánto te deben los clientes y cuánto les debés a los proveedores, ventas del día y del mes, ganancia bruta, stock valorizado, más vendidos y alertas de stock bajo. |
| **Vender** | Punto de venta: escaneás el código de barras (o buscás por nombre) y se agrega. Elegís cliente → se aplica su lista de precios. Botón “+ bulto”. Descuento. Pago en efectivo, transferencia, cuenta corriente o combinado (calcula el vuelto). Comprobante imprimible. |
| **Ventas** | Historial con filtros por fecha y cliente, detalle, reimpresión y **anulación** (devuelve stock y revierte caja y cuenta corriente). |
| **Comprar / Compras** | Ingreso de mercadería por proveedor con N° de factura: suma stock, actualiza el costo y registra el pago (efectivo / transferencia / a cuenta). |
| **Caja** | Dos cajas: **Efectivo** y **Transferencia**. Ver saldos y movimientos, cargar ingresos y gastos, y traspasar entre cajas (ej: depositar efectivo). Sin cierres. |
| **Clientes / Proveedores** | Ficha, saldo de **cuenta corriente** con historial (debe / haber / saldo), registrar cobros y pagos, ajustes, saldo inicial y límite de crédito. |
| **Cuentas corrientes** | Resumen de todos los saldos pendientes de clientes y proveedores. |
| **Catálogo y stock** | Productos con **foto**, **código de barras**, código interno, categoría, marca, presentación, unidades por bulto, costo, stock y stock mínimo. Vista en tarjetas o tabla, ajustes de stock (roturas, conteos) e historial de movimientos. |
| **Listas de precios** | Todas las listas que quieras (Minorista, Mayorista, Bares…). Cada una con un % de recargo sobre el costo o precios fijos por producto. **Actualización masiva** por %. Descarga en **Excel**, **PDF** (lista o catálogo con fotos), por lista o directamente **según el cliente**. |
| **Importar / Exportar** | Carga masiva de productos desde **Excel (.xlsx) o CSV**, carga masiva de **fotos** (nombradas con el código de barras) y exportación del inventario completo. |

## Instalación

1. Instalá **Node.js 20 o superior** desde <https://nodejs.org> (versión LTS).
2. Descargá este proyecto y, dentro de la carpeta, ejecutá:

```bash
npm install
npm start
```

3. Abrí el navegador en **http://localhost:3000**

En Windows también podés hacer doble clic en `iniciar.bat`.

Para usarlo desde otro dispositivo de la misma red, entrá a `http://IP-DE-LA-PC:3000` (ej: `http://192.168.0.10:3000`).

## Carga masiva de productos

Desde **Importar / Exportar** descargá la plantilla. Columnas reconocidas (solo `nombre` es obligatoria):

| Columna | Ejemplo |
|---|---|
| `codigo` | BEB001 |
| `codigo_barras` | 7790895000997 |
| `nombre` | Coca-Cola Original 2.25L |
| `categoria` | Gaseosas (se crea sola si no existe) |
| `marca` | Coca-Cola |
| `presentacion` | Botella 2.25L |
| `unidades_bulto` | 8 |
| `costo` | 1800 o 1.800,50 |
| `stock` | 48 |
| `stock_minimo` | 16 |
| `descripcion` | |
| `precio_<lista>` | `precio_minorista`, `precio_mayorista`… (opcional: si queda vacío se usa el recargo de la lista) |

- Si el código de barras (o el código) ya existe, el producto se **actualiza**; si no, se **crea**.
- Podés elegir si la columna `stock` **reemplaza** o **se suma** al stock actual.
- Se aceptan CSV separados por `;` o `,` y números con formato argentino (`1.234,56`).
- Tip: exportá el inventario, editalo en Excel y volvé a importarlo para actualizar precios o stock de muchos productos a la vez.

**Fotos en masa:** seleccioná muchas imágenes juntas; cada archivo debe llamarse como el código de barras o el código interno (`7790895000997.jpg`).

## Lector de código de barras

Cualquier lector USB/Bluetooth que funcione como teclado sirve: en **Vender**, **Comprar** o **Catálogo** hacé foco en el buscador y escaneá. En la ficha del producto también podés escanear para cargar el código, o generar un código interno con el botón ⚙️ para productos sin código.

## Datos y respaldo

Todo se guarda en la carpeta `data/`:

- `data/sistema.db` → base de datos (SQLite)
- `data/uploads/` → fotos de los productos

**Hacé copias de esa carpeta periódicamente** (pendrive, Google Drive, etc.). Para restaurar, reemplazá la carpeta `data/` con la copia.

Variables opcionales: `PORT` (puerto, por defecto 3000) y `DATA_DIR` (carpeta de datos).

## Cómo se calculan los saldos

- **Caja:** cada venta/cobro suma en la caja elegida; cada compra/pago/gasto resta. El saldo es la suma de los movimientos.
- **Cuenta corriente:** saldo positivo = deuda pendiente (el cliente nos debe / le debemos al proveedor). La parte no pagada de una venta o compra va a la cuenta corriente; los cobros y pagos la reducen.
- **Precio de un producto en una lista:** precio fijo si se cargó; si no, `costo × (1 + recargo de la lista)`.

## Desarrollo

```bash
npm run dev   # reinicia el servidor al guardar cambios
npm test      # tests de la API
```

Estructura:

```
server/           API (Node.js + Express + SQLite)
  db.js           esquema de la base de datos
  services.js     lógica de precios, caja, cuentas corrientes y stock
  routes/         catálogo, clientes/proveedores, ventas/compras, caja, reportes, importación/exportación
public/           interfaz web (HTML + CSS + JavaScript, sin compilación)
test/             tests
```
