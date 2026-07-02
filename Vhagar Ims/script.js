/**
 * Vhagar Inventory Management System
 * Apps Script backend — bound to the Vhagar IMS spreadsheet.
 *
 * Setup (run once):
 *   1. Run setupInventorySystem() from the editor.
 *   2. Deploy → New deployment → Web app.
 *      Execute as: Me   |   Access: Anyone with Google account (or restrict).
 */

// ============================================================
// CONFIGURATION
// ============================================================

const STOCK_SHEET_NAME      = 'Sheet1';      // Existing stock sheet
const ORDERS_SHEET_NAME     = 'Orders';
const MOVEMENTS_SHEET_NAME  = 'Movements';
const CONFIG_SHEET_NAME     = 'Config';
const REQUISITIONS_SHEET_NAME = 'Requisitions';

// Shortage reason categories
const SHORTAGE_REASONS = ['Defective', 'Fabric Shortage', 'Cutting Waste', 'Master Error', 'Shrinkage', 'Other'];

// Column layout of the existing stock sheet (1-indexed)
const STOCK_DATA_START_ROW    = 4;   // Data starts row 4 (rows 1-3 are headers)
const STOCK_IMAGE_COL         = 1;   // A
const STOCK_STYLE_NO_COL      = 2;   // B
const STOCK_PRODUCT_NAME_COL  = 3;   // C
const STOCK_IN_HAND_COL       = 12;  // L

const SIZE_COLUMNS = {
  'S':   5,   // E
  'M':   6,   // F
  'L':   7,   // G
  'XL':  8,   // H
  '2XL': 9,   // I
  '3XL': 10   // J
};

const SIZES     = ['S', 'M', 'L', 'XL', '2XL', '3XL'];
const CHANNELS  = ['Shopify', 'Flipkart', 'Amazon', 'Meesho', 'Direct'];
const STATUSES  = ['Pending', 'Confirmed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Returned'];

const LOW_STOCK_THRESHOLD = 3;

// Image storage
const IMAGES_FOLDER_NAME = 'Vhagar Product Images';
const IMAGE_ROW_HEIGHT   = 100;  // px — so image is visible in the sheet too

// ============================================================
// WEB APP ENTRY POINT
// ============================================================

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Vhagar Inventory')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ============================================================
// ONE-TIME SETUP
// ============================================================

function setupInventorySystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Orders sheet
  let orders = ss.getSheetByName(ORDERS_SHEET_NAME);
  if (!orders) {
    orders = ss.insertSheet(ORDERS_SHEET_NAME);
    const headers = ['order_id', 'order_date', 'channel', 'buyer_name', 'buyer_contact',
                     'style_no', 'product_name', 'size', 'quantity', 'status', 'notes',
                     'submitted_at', 'submitted_by'];
    orders.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    orders.setFrozenRows(1);
    orders.setColumnWidths(1, headers.length, 130);
  }

  // Movements sheet
  let movements = ss.getSheetByName(MOVEMENTS_SHEET_NAME);
  if (!movements) {
    movements = ss.insertSheet(MOVEMENTS_SHEET_NAME);
    const headers = ['movement_id', 'timestamp', 'style_no', 'size', 'change',
                     'type', 'reason', 'order_id', 'user'];
    movements.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    movements.setFrozenRows(1);
    movements.setColumnWidths(1, headers.length, 130);
  }

  // Config sheet
  let config = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!config) {
    config = ss.insertSheet(CONFIG_SHEET_NAME);
    config.getRange(1, 1, 1, 2).setValues([['Channels', 'Statuses']])
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    config.getRange(2, 1, CHANNELS.length, 1).setValues(CHANNELS.map(c => [c]));
    config.getRange(2, 2, STATUSES.length, 1).setValues(STATUSES.map(s => [s]));
    config.setFrozenRows(1);
  }

  // Requisitions sheet
  let reqs = ss.getSheetByName(REQUISITIONS_SHEET_NAME);
  if (!reqs) {
    reqs = ss.insertSheet(REQUISITIONS_SHEET_NAME);
    const headers = [
      'req_id', 'line_no', 'created_at', 'received_at',
      'master', 'fabric_name', 'meters_issued',
      'style_no', 'product_name',
      'est_S', 'est_M', 'est_L', 'est_XL', 'est_2XL', 'est_3XL', 'est_total',
      'act_S', 'act_M', 'act_L', 'act_XL', 'act_2XL', 'act_3XL', 'act_total',
      'defective', 'fabric_shortage', 'cutting_waste', 'master_error', 'shrinkage', 'other_loss',
      'total_loss', 'variance',
      'status', 'created_by', 'received_by', 'notes'
    ];
    reqs.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    reqs.setFrozenRows(1);
    reqs.setColumnWidths(1, headers.length, 120);
  }

  SpreadsheetApp.getUi().alert(
    'Setup complete.\n\n' +
    'Created tabs: Orders, Movements, Config, Requisitions.\n\n' +
    'Next: Deploy → New deployment → Web app.'
  );
}

// ============================================================
// UTILITIES
// ============================================================

/**
 * ONE-TIME UTILITY — run from the Apps Script editor.
 *
 * For every row in Sheet1 where column L (IN HAND) is blank,
 * writes the sum of size columns E–J so the dashboard total
 * matches the sheet exactly.
 *
 * Safe to run multiple times — only touches blank cells.
 * Rows where L already has a value are left untouched.
 */
function syncInHandColumn() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STOCK_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < STOCK_DATA_START_ROW) {
    SpreadsheetApp.getUi().alert('No data rows found.');
    return;
  }

  const numRows = lastRow - STOCK_DATA_START_ROW + 1;
  // Read columns A–L (1–12)
  const values = sheet.getRange(STOCK_DATA_START_ROW, 1, numRows, STOCK_IN_HAND_COL).getValues();

  let fixed = 0;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const styleNo = String(row[STOCK_STYLE_NO_COL - 1] || '').trim();
    if (!styleNo) continue; // skip empty rows

    const inHandRaw = row[STOCK_IN_HAND_COL - 1];
    if (inHandRaw !== '' && inHandRaw !== null) continue; // already has a value

    // Compute sum of size columns E–J
    let sizeSum = 0;
    SIZES.forEach(size => {
      const v = row[SIZE_COLUMNS[size] - 1];
      sizeSum += (v === '' || v === null) ? 0 : Number(v) || 0;
    });

    // Write the sum into column L
    sheet.getRange(STOCK_DATA_START_ROW + i, STOCK_IN_HAND_COL).setValue(sizeSum);
    fixed++;
  }

  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert(
    `Sync complete.\n\n` +
    `${fixed} row(s) had a blank IN HAND — filled with sum of sizes.\n` +
    `${numRows - fixed} row(s) already had values — left untouched.\n\n` +
    `Refresh the web app to see the updated total.`
  );
}

/**
 * ONE-TIME UTILITY — run from the Apps Script editor if the Orders tab
 * shows empty despite having rows in the Orders sheet.
 *
 * Inserts a proper header row at row 1 when it is missing.
 * Existing order data shifts down to row 2 and the web app can read it.
 * Safe to run multiple times — skips if headers already exist.
 */
function repairOrdersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ORDERS_SHEET_NAME);
  if (!sheet) { SpreadsheetApp.getUi().alert('Orders sheet not found.'); return; }

  const firstCell = String(sheet.getRange(1, 1).getValue() || '').toLowerCase();

  if (firstCell === 'order_id') {
    SpreadsheetApp.getUi().alert('Header row already exists — no action needed.\n\nIf orders still do not appear, refresh the web app.');
    return;
  }

  // Insert blank row at position 1 (pushes data to row 2)
  sheet.insertRowBefore(1);

  const headers = ['order_id', 'order_date', 'channel', 'buyer_name', 'buyer_contact',
                   'style_no', 'product_name', 'size', 'quantity', 'status', 'notes',
                   'submitted_at', 'submitted_by'];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#1a1a1a')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert(
    'Header row added to Orders sheet.\n\n' +
    'Your existing orders are now in row 2 onwards.\n' +
    'Refresh the web app — orders should now appear.'
  );
}

// ============================================================
// READ FUNCTIONS
// ============================================================

function getConfig() {
  return {
    channels: CHANNELS,
    statuses: STATUSES,
    sizes: SIZES,
    shortage_reasons: SHORTAGE_REASONS,
    low_stock_threshold: LOW_STOCK_THRESHOLD,
    user_email: Session.getActiveUser().getEmail() || ''
  };
}

function getProducts() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_SHEET_NAME);
  if (!sheet) throw new Error('Stock sheet "' + STOCK_SHEET_NAME + '" not found.');

  const lastRow = sheet.getLastRow();
  if (lastRow < STOCK_DATA_START_ROW) return [];

  const numRows  = lastRow - STOCK_DATA_START_ROW + 1;
  const range    = sheet.getRange(STOCK_DATA_START_ROW, 1, numRows, STOCK_IN_HAND_COL);
  const values   = range.getValues();
  const formulas = range.getFormulas();   // To read =IMAGE() in column A

  const products = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const styleNo = String(row[STOCK_STYLE_NO_COL - 1] || '').trim();
    if (!styleNo) continue;

    const productName = String(row[STOCK_PRODUCT_NAME_COL - 1] || '').trim();

    const sizes = {};
    let computedTotal = 0;
    SIZES.forEach(size => {
      const v = row[SIZE_COLUMNS[size] - 1];
      const n = (v === '' || v === null) ? 0 : Number(v) || 0;
      sizes[size] = n;
      computedTotal += n;
    });

    const inHandRaw = row[STOCK_IN_HAND_COL - 1];
    // Strictly use column L.  Never fall back to the size sum —
    // that was causing inflated totals for rows where L was blank.
    // Blank L = 0 (stock not yet counted, treated as unavailable).
    const inHand = (inHandRaw === '' || inHandRaw === null) ? 0 : Number(inHandRaw) || 0;

    // Extract image file ID from column A formula (if any)
    const imageFormula = formulas[i][STOCK_IMAGE_COL - 1] || '';
    const imageId = extractFileIdFromImageFormula_(imageFormula);

    products.push({
      style_no: styleNo,
      product_name: productName,
      row: STOCK_DATA_START_ROW + i,
      sizes: sizes,
      in_hand: inHand,
      image_id: imageId
    });
  }
  return products;
}

function getOrders(filters) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ORDERS_SHEET_NAME);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];

  // Read ALL rows from row 1 so we can auto-detect header presence.
  // If row 1 cell A = 'order_id' → it's a header, skip it.
  // If row 1 cell A starts with 'ORD-' → no header, data starts at row 1.
  const allData = sheet.getRange(1, 1, lastRow, 13).getValues();
  const hasHeader = String(allData[0][0] || '').toLowerCase() === 'order_id';
  const data = hasHeader ? allData.slice(1) : allData;

  if (!data.length) return [];

  const tz = Session.getScriptTimeZone();

  const map = {};
  for (const row of data) {
    const oid = row[0];
    if (!oid) continue;

    if (!map[oid]) {
      map[oid] = {
        order_id: oid,
        order_date: row[1] instanceof Date
          ? Utilities.formatDate(row[1], tz, 'yyyy-MM-dd') : String(row[1] || ''),
        channel: row[2],
        buyer_name: row[3],
        buyer_contact: row[4],
        status: row[9],
        notes: row[10] || '',
        submitted_at: row[11] instanceof Date
          ? Utilities.formatDate(row[11], tz, 'yyyy-MM-dd HH:mm:ss') : String(row[11] || ''),
        submitted_by: row[12] || '',
        items: [],
        total_quantity: 0
      };
    }

    map[oid].items.push({
      style_no: row[5],
      product_name: row[6],
      size: row[7],
      quantity: Number(row[8]) || 0
    });
    map[oid].total_quantity += Number(row[8]) || 0;

    // If any line still shows non-cancelled, prefer that as the order status.
    if (map[oid].status === 'Cancelled' && row[9] !== 'Cancelled') map[oid].status = row[9];
  }

  let orders = Object.values(map);

  if (filters) {
    if (filters.channel)   orders = orders.filter(o => o.channel === filters.channel);
    if (filters.status)    orders = orders.filter(o => o.status === filters.status);
    if (filters.from_date) orders = orders.filter(o => o.order_date >= filters.from_date);
    if (filters.to_date)   orders = orders.filter(o => o.order_date <= filters.to_date);
    if (filters.search) {
      const s = String(filters.search).toLowerCase();
      orders = orders.filter(o =>
        String(o.order_id).toLowerCase().includes(s) ||
        String(o.buyer_name).toLowerCase().includes(s) ||
        String(o.buyer_contact).toLowerCase().includes(s)
      );
    }
  }

  orders.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  return orders;
}

function getMovements(limit) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MOVEMENTS_SHEET_NAME);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const tz = Session.getScriptTimeZone();

  const movements = data.map(r => ({
    movement_id: r[0],
    timestamp: r[1] instanceof Date
      ? Utilities.formatDate(r[1], tz, 'yyyy-MM-dd HH:mm:ss') : String(r[1] || ''),
    style_no: r[2],
    size: r[3],
    change: Number(r[4]) || 0,
    type: r[5],
    reason: r[6] || '',
    order_id: r[7] || '',
    user: r[8] || ''
  }));

  movements.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return limit ? movements.slice(0, limit) : movements;
}

function getDashboard() {
  const products = getProducts();
  const orders = getOrders();
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  let totalInHand = 0;
  let lowStockCount = 0;
  products.forEach(p => {
    totalInHand += p.in_hand;
    if (p.in_hand > 0 && p.in_hand <= LOW_STOCK_THRESHOLD) lowStockCount++;
  });

  const todayOrders = orders.filter(o => o.order_date === today && o.status !== 'Cancelled');
  let todayUnits = 0;
  todayOrders.forEach(o => { todayUnits += o.total_quantity; });

  const channelBreakdown = {};
  CHANNELS.forEach(c => channelBreakdown[c] = 0);
  todayOrders.forEach(o => { channelBreakdown[o.channel] = (channelBreakdown[o.channel] || 0) + o.total_quantity; });

  return {
    total_products: products.length,
    total_in_hand: totalInHand,
    low_stock_count: lowStockCount,
    today_orders: todayOrders.length,
    today_units: todayUnits,
    channel_breakdown: channelBreakdown
  };
}

// ============================================================
// WRITE FUNCTIONS — ORDERS
// ============================================================

function submitOrder(orderData) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    // ---- Validate header
    if (!orderData || typeof orderData !== 'object')
      return { success: false, error: 'Invalid order data' };
    if (!orderData.channel || CHANNELS.indexOf(orderData.channel) < 0)
      return { success: false, error: 'Please choose a valid channel' };
    if (!orderData.buyer_name || !String(orderData.buyer_name).trim())
      return { success: false, error: 'Buyer name is required' };
    if (!orderData.buyer_contact || !String(orderData.buyer_contact).trim())
      return { success: false, error: 'Buyer contact is required' };
    if (!Array.isArray(orderData.items) || orderData.items.length === 0)
      return { success: false, error: 'Add at least one line item' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const stockSheet     = ss.getSheetByName(STOCK_SHEET_NAME);
    const ordersSheet    = ss.getSheetByName(ORDERS_SHEET_NAME);
    const movementsSheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);

    if (!ordersSheet || !movementsSheet)
      return { success: false, error: 'System not set up. Run setupInventorySystem() first.' };

    // ---- Read fresh stock and build lookup
    const products = getProducts();
    const productMap = {};
    products.forEach(p => productMap[p.style_no] = p);

    // ---- Aggregate items by (style_no + size) so duplicate lines combine
    const aggregated = {};
    for (const raw of orderData.items) {
      const styleNo = String(raw.style_no || '').trim();
      const size = String(raw.size || '').trim();
      const qty = Number(raw.quantity);
      if (!styleNo || !size || !qty || qty <= 0)
        return { success: false, error: 'Each item must have a product, size, and quantity > 0' };
      if (SIZES.indexOf(size) < 0)
        return { success: false, error: 'Invalid size: ' + size };
      const key = styleNo + '|' + size;
      aggregated[key] = aggregated[key] || { style_no: styleNo, size: size, quantity: 0 };
      aggregated[key].quantity += qty;
    }
    const items = Object.values(aggregated);

    // ---- Validate stock (fail fast — no partial writes)
    for (const item of items) {
      const product = productMap[item.style_no];
      if (!product)
        return { success: false, error: 'Product not found: ' + item.style_no };
      const available = product.sizes[item.size] || 0;
      if (item.quantity > available) {
        return {
          success: false,
          error: `Not enough stock for ${item.style_no} (${item.size}). Available: ${available}, requested: ${item.quantity}.`
        };
      }
    }

    // ---- Generate IDs and metadata
    const now = new Date();
    const tz = Session.getScriptTimeZone();
    const orderId = 'ORD-' + Utilities.formatDate(now, tz, 'yyyyMMdd-HHmmss');
    const submittedAt = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const orderDate = orderData.order_date || Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    const status = (orderData.status && STATUSES.indexOf(orderData.status) >= 0) ? orderData.status : 'Confirmed';
    const notes = String(orderData.notes || '').trim();
    const user = Session.getActiveUser().getEmail() || 'unknown';

    // ---- Apply deductions and prepare append rows
    const orderRows = [];
    const movementRows = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const product = productMap[item.style_no];
      const sizeCol = SIZE_COLUMNS[item.size];
      const newSizeQty = product.sizes[item.size] - item.quantity;

      // Update size cell first, then update local cache
      stockSheet.getRange(product.row, sizeCol).setValue(newSizeQty);
      product.sizes[item.size] = newSizeQty;

      // Recompute IN HAND as sum of ALL sizes — never use arithmetic on the old
      // in_hand value because it may have been blank/unsynced in the sheet.
      const newInHand = SIZES.reduce((s, sz) => s + (product.sizes[sz] || 0), 0);
      stockSheet.getRange(product.row, STOCK_IN_HAND_COL).setValue(newInHand);
      product.in_hand = newInHand;

      orderRows.push([
        orderId, orderDate, orderData.channel,
        String(orderData.buyer_name).trim(),
        String(orderData.buyer_contact).trim(),
        item.style_no, product.product_name, item.size, item.quantity,
        status, notes, submittedAt, user
      ]);

      const mid = 'MOV-' + Utilities.formatDate(now, tz, 'yyyyMMdd-HHmmss') + '-' + (i + 1).toString().padStart(3, '0');
      movementRows.push([
        mid, submittedAt, item.style_no, item.size, -item.quantity,
        'SALE', `Order ${orderId} via ${orderData.channel}`, orderId, user
      ]);
    }

    // ---- Bulk append (single API call each)
    if (orderRows.length) {
      ordersSheet.getRange(ordersSheet.getLastRow() + 1, 1, orderRows.length, orderRows[0].length).setValues(orderRows);
    }
    if (movementRows.length) {
      movementsSheet.getRange(movementsSheet.getLastRow() + 1, 1, movementRows.length, movementRows[0].length).setValues(movementRows);
    }

    SpreadsheetApp.flush();

    return {
      success: true,
      order_id: orderId,
      items_count: items.length,
      total_quantity: items.reduce((s, i) => s + i.quantity, 0)
    };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

function cancelOrder(orderId) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    if (!orderId) return { success: false, error: 'Order ID required' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ordersSheet    = ss.getSheetByName(ORDERS_SHEET_NAME);
    const stockSheet     = ss.getSheetByName(STOCK_SHEET_NAME);
    const movementsSheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);

    const lastRow = ordersSheet.getLastRow();
    if (lastRow < 1) return { success: false, error: 'Order not found' };

    // Auto-detect header: if row 1 cell A = 'order_id', data starts at row 2 (offset = 2).
    // If no header, data starts at row 1 (offset = 1).
    const firstCell = String(ordersSheet.getRange(1, 1).getValue() || '').toLowerCase();
    const hasHeader = firstCell === 'order_id';
    const dataStartRow = hasHeader ? 2 : 1;
    const dataRows = hasHeader ? lastRow - 1 : lastRow;
    if (dataRows < 1) return { success: false, error: 'Order not found' };

    const ordersData = ordersSheet.getRange(dataStartRow, 1, dataRows, 13).getValues();

    const matching = [];
    for (let i = 0; i < ordersData.length; i++) {
      if (ordersData[i][0] === orderId) {
        matching.push({
          rowIndex: i + dataStartRow,   // correct 1-based sheet row regardless of header
          style_no: ordersData[i][5],
          size: ordersData[i][7],
          quantity: Number(ordersData[i][8]) || 0,
          status: ordersData[i][9]
        });
      }
    }

    if (matching.length === 0) return { success: false, error: 'Order not found' };
    if (matching.every(m => m.status === 'Cancelled'))
      return { success: false, error: 'Order is already cancelled' };
    if (matching.every(m => m.status === 'Delivered'))
      return { success: false, error: 'Cannot cancel a delivered order. Use Return instead.' };
    if (matching.every(m => m.status === 'Returned'))
      return { success: false, error: 'This order has already been returned.' };

    const products = getProducts();
    const productMap = {};
    products.forEach(p => productMap[p.style_no] = p);

    const now = new Date();
    const tz = Session.getScriptTimeZone();
    const ts = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const user = Session.getActiveUser().getEmail() || 'unknown';
    const movementRows = [];

    for (let i = 0; i < matching.length; i++) {
      const m = matching[i];
      if (m.status === 'Cancelled') continue;

      const product = productMap[m.style_no];
      if (product) {
        const sizeCol = SIZE_COLUMNS[m.size];
        const newSizeQty = (product.sizes[m.size] || 0) + m.quantity;

        stockSheet.getRange(product.row, sizeCol).setValue(newSizeQty);
        product.sizes[m.size] = newSizeQty;

        // Recompute IN HAND from all sizes — never use arithmetic to avoid
        // propagating any pre-existing blank/unsynced IN HAND values.
        const newInHand = SIZES.reduce((s, sz) => s + (product.sizes[sz] || 0), 0);
        stockSheet.getRange(product.row, STOCK_IN_HAND_COL).setValue(newInHand);
        product.in_hand = newInHand;
      }

      ordersSheet.getRange(m.rowIndex, 10).setValue('Cancelled');

      const mid = 'MOV-' + Utilities.formatDate(now, tz, 'yyyyMMdd-HHmmss') + '-' + (i + 1).toString().padStart(3, '0');
      movementRows.push([
        mid, ts, m.style_no, m.size, m.quantity,
        'CANCEL', 'Cancelled order ' + orderId, orderId, user
      ]);
    }

    if (movementRows.length) {
      movementsSheet.getRange(movementsSheet.getLastRow() + 1, 1, movementRows.length, movementRows[0].length).setValues(movementRows);
    }

    SpreadsheetApp.flush();
    return { success: true, items_restored: movementRows.length };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Return a Delivered order — mirrors cancelOrder, but only works on Delivered status.
 * Restores stock (returned items go back into inventory) and sets status to 'Returned'.
 * Optional reason gets appended to the notes column.
 */
function returnOrder(orderId, reason) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    if (!orderId) return { success: false, error: 'Order ID required' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ordersSheet    = ss.getSheetByName(ORDERS_SHEET_NAME);
    const stockSheet     = ss.getSheetByName(STOCK_SHEET_NAME);
    const movementsSheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);

    const lastRow = ordersSheet.getLastRow();
    if (lastRow < 1) return { success: false, error: 'Order not found' };

    const firstCell = String(ordersSheet.getRange(1, 1).getValue() || '').toLowerCase();
    const hasHeader = firstCell === 'order_id';
    const dataStartRow = hasHeader ? 2 : 1;
    const dataRows = hasHeader ? lastRow - 1 : lastRow;
    if (dataRows < 1) return { success: false, error: 'Order not found' };

    const ordersData = ordersSheet.getRange(dataStartRow, 1, dataRows, 13).getValues();

    const matching = [];
    for (let i = 0; i < ordersData.length; i++) {
      if (ordersData[i][0] === orderId) {
        matching.push({
          rowIndex: i + dataStartRow,
          style_no: ordersData[i][5],
          size: ordersData[i][7],
          quantity: Number(ordersData[i][8]) || 0,
          status: ordersData[i][9]
        });
      }
    }

    if (matching.length === 0) return { success: false, error: 'Order not found' };
    if (matching.every(m => m.status === 'Returned'))
      return { success: false, error: 'This order has already been returned' };

    // Only Delivered orders can be returned
    if (!matching.every(m => m.status === 'Delivered'))
      return { success: false, error: 'Only delivered orders can be returned. Current status: ' + matching[0].status };

    const products = getProducts();
    const productMap = {};
    products.forEach(p => productMap[p.style_no] = p);

    const now = new Date();
    const tz = Session.getScriptTimeZone();
    const ts = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const user = Session.getActiveUser().getEmail() || 'unknown';
    const cleanReason = String(reason || '').trim();
    const movementRows = [];

    for (let i = 0; i < matching.length; i++) {
      const m = matching[i];
      const product = productMap[m.style_no];

      // Restore stock (returned items come back to inventory)
      if (product) {
        const sizeCol = SIZE_COLUMNS[m.size];
        const newSizeQty = (product.sizes[m.size] || 0) + m.quantity;
        stockSheet.getRange(product.row, sizeCol).setValue(newSizeQty);
        product.sizes[m.size] = newSizeQty;

        const newInHand = SIZES.reduce((s, sz) => s + (product.sizes[sz] || 0), 0);
        stockSheet.getRange(product.row, STOCK_IN_HAND_COL).setValue(newInHand);
        product.in_hand = newInHand;
      }

      // Update status to Returned
      ordersSheet.getRange(m.rowIndex, 10).setValue('Returned');

      // Append return reason to notes (col 11), preserving existing notes
      if (cleanReason) {
        const existingNotes = String(ordersSheet.getRange(m.rowIndex, 11).getValue() || '').trim();
        const newNotes = existingNotes
          ? existingNotes + ' | RETURN: ' + cleanReason
          : 'RETURN: ' + cleanReason;
        ordersSheet.getRange(m.rowIndex, 11).setValue(newNotes);
      }

      const mid = 'MOV-' + Utilities.formatDate(now, tz, 'yyyyMMdd-HHmmss') + '-RET-' + (i + 1).toString().padStart(3, '0');
      movementRows.push([
        mid, ts, m.style_no, m.size, m.quantity,
        'RETURN',
        'Returned order ' + orderId + (cleanReason ? ' · ' + cleanReason : ''),
        orderId, user
      ]);
    }

    if (movementRows.length) {
      movementsSheet.getRange(movementsSheet.getLastRow() + 1, 1, movementRows.length, movementRows[0].length).setValues(movementRows);
    }

    SpreadsheetApp.flush();
    return { success: true, items_restored: movementRows.length };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// UPDATE STOCK  (restock / manual set)
// ============================================================

// ── Allowed status transitions (non-cancel) ──
const STATUS_TRANSITIONS = {
  'Pending':          ['Confirmed', 'Shipped', 'Out for Delivery'],
  'Confirmed':        ['Shipped', 'Out for Delivery'],
  'Shipped':          ['Out for Delivery'],
  'Out for Delivery': ['Delivered'],
  'Delivered':        [],   // Terminal in updateOrderStatus — use returnOrder() for returns
  'Cancelled':        [],
  'Returned':         []
};

/**
 * Update the status of an order (non-cancellation, non-return transitions).
 * For cancellation use cancelOrder().
 * For returns from Delivered status, use returnOrder() (restores stock).
 */
function updateOrderStatus(orderId, newStatus) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    if (!orderId) return { success: false, error: 'Order ID required' };
    if (!newStatus || STATUSES.indexOf(newStatus) < 0)
      return { success: false, error: 'Invalid status: ' + newStatus };
    if (newStatus === 'Cancelled')
      return { success: false, error: 'Use cancelOrder() for cancellations' };
    if (newStatus === 'Returned')
      return { success: false, error: 'Use returnOrder() for returns — it restores stock' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ordersSheet    = ss.getSheetByName(ORDERS_SHEET_NAME);
    const movementsSheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);

    const lastRow = ordersSheet.getLastRow();
    if (lastRow < 1) return { success: false, error: 'Order not found' };

    const firstCell = String(ordersSheet.getRange(1, 1).getValue() || '').toLowerCase();
    const hasHeader = firstCell === 'order_id';
    const dataStartRow = hasHeader ? 2 : 1;
    const dataRows = hasHeader ? lastRow - 1 : lastRow;
    if (dataRows < 1) return { success: false, error: 'Order not found' };

    const ordersData = ordersSheet.getRange(dataStartRow, 1, dataRows, 13).getValues();

    const matching = [];
    let currentStatus = '';
    for (let i = 0; i < ordersData.length; i++) {
      if (ordersData[i][0] === orderId) {
        matching.push({ rowIndex: i + dataStartRow });
        if (!currentStatus) currentStatus = String(ordersData[i][9] || '').trim();
      }
    }

    if (matching.length === 0) return { success: false, error: 'Order not found' };

    // Validate transition
    const allowed = STATUS_TRANSITIONS[currentStatus] || [];
    if (allowed.indexOf(newStatus) < 0)
      return { success: false, error: 'Cannot transition from "' + currentStatus + '" to "' + newStatus + '"' };

    // Update all rows for this order
    for (let i = 0; i < matching.length; i++) {
      ordersSheet.getRange(matching[i].rowIndex, 10).setValue(newStatus);
    }

    // Log a movement
    const now = new Date();
    const tz = Session.getScriptTimeZone();
    const ts = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const user = Session.getActiveUser().getEmail() || 'unknown';
    const mid = 'MOV-' + Utilities.formatDate(now, tz, 'yyyyMMddHHmmss') + '-STAT';
    if (movementsSheet) {
      movementsSheet.appendRow([
        mid, ts, '', '', 0,
        'STATUS_CHANGE',
        'Order ' + orderId + ': ' + currentStatus + ' → ' + newStatus,
        orderId, user
      ]);
    }

    SpreadsheetApp.flush();
    return { success: true, order_id: orderId, old_status: currentStatus, new_status: newStatus };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * data = {
 *   style_no : string,
 *   mode     : 'add' | 'set',   // add = increment, set = overwrite
 *   updates  : [{ size, quantity }],
 *   notes    : string
 * }
 */
function updateStock(data) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    if (!data || !data.style_no)
      return { success: false, error: 'No product selected' };
    if (!Array.isArray(data.updates) || data.updates.length === 0)
      return { success: false, error: 'No size quantities provided' };

    const mode = data.mode === 'set' ? 'set' : 'add';

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const stockSheet     = ss.getSheetByName(STOCK_SHEET_NAME);
    const movementsSheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);

    const products = getProducts();
    const product = products.find(p => p.style_no === data.style_no);
    if (!product) return { success: false, error: 'Product not found: ' + data.style_no };

    const now = new Date();
    const tz = Session.getScriptTimeZone();
    const ts = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const user = Session.getActiveUser().getEmail() || 'unknown';
    const notes = String(data.notes || 'Manual stock update').trim();

    const movementRows = [];

    for (let i = 0; i < data.updates.length; i++) {
      const { size, quantity } = data.updates[i];
      if (SIZES.indexOf(size) < 0) continue;
      const qty = Number(quantity);
      if (isNaN(qty) || qty === 0) continue;

      const sizeCol = SIZE_COLUMNS[size];
      const currentQty = product.sizes[size] || 0;
      let newQty, change;

      if (mode === 'set') {
        if (qty < 0) return { success: false, error: 'Cannot set negative stock for ' + size };
        newQty = qty;
        change = newQty - currentQty;
      } else {
        newQty = currentQty + qty;
        if (newQty < 0) return {
          success: false,
          error: `Cannot deduct ${Math.abs(qty)} from ${size} — only ${currentQty} available`
        };
        change = qty;
      }

      stockSheet.getRange(product.row, sizeCol).setValue(newQty);
      product.sizes[size] = newQty; // update local cache

      const movType = mode === 'set'
        ? 'MANUAL_SET'
        : (change > 0 ? 'RESTOCK' : 'MANUAL_ADJUST');

      const mid = 'MOV-' + Utilities.formatDate(now, tz, 'yyyyMMddHHmmss') + '-' + i.toString().padStart(3, '0');
      movementRows.push([mid, ts, data.style_no, size, change, movType, notes, '', user]);
    }

    if (movementRows.length === 0)
      return { success: false, error: 'No valid quantities entered — nothing changed' };

    // Recalculate IN HAND from updated sizes (source of truth)
    const newInHand = SIZES.reduce((s, sz) => s + (product.sizes[sz] || 0), 0);
    stockSheet.getRange(product.row, STOCK_IN_HAND_COL).setValue(newInHand);

    movementsSheet.getRange(movementsSheet.getLastRow() + 1, 1, movementRows.length, movementRows[0].length)
      .setValues(movementRows);

    SpreadsheetApp.flush();

    return {
      success: true,
      product_name: product.product_name,
      changes: movementRows.length,
      new_in_hand: newInHand,
      updated_sizes: movementRows.map(r => ({ size: r[3], change: r[4] }))
    };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// ADD NEW PRODUCT  (appends a fresh row to Sheet1)
// ============================================================

/**
 * data = {
 *   style_no    : string   (required, must be unique)
 *   product_name: string   (required)
 *   fabric      : string   (optional)
 *   channels    : string[] (up to 3 — written to columns P, Q, R)
 *   sizes       : { S, M, L, XL, '2XL', '3XL' }  initial stock
 * }
 */
function addNewProduct(data) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    const styleNo     = String(data.style_no    || '').trim();
    const productName = String(data.product_name || '').trim();

    if (!styleNo)     return { success: false, error: 'Style No. is required' };
    if (!productName) return { success: false, error: 'Product Name is required' };

    // Duplicate check
    const existing = getProducts();
    if (existing.find(p => p.style_no.toLowerCase() === styleNo.toLowerCase()))
      return { success: false, error: `Style No. "${styleNo}" already exists in Sheet1` };

    const sz     = data.sizes || {};
    const sQty   = Math.max(0, Number(sz['S']   || 0));
    const mQty   = Math.max(0, Number(sz['M']   || 0));
    const lQty   = Math.max(0, Number(sz['L']   || 0));
    const xlQty  = Math.max(0, Number(sz['XL']  || 0));
    const xxlQty = Math.max(0, Number(sz['2XL'] || 0));
    const xxxlQty= Math.max(0, Number(sz['3XL'] || 0));
    const inHand = sQty + mQty + lQty + xlQty + xxlQty + xxxlQty;

    const channels = Array.isArray(data.channels) ? data.channels : [];

    // Sheet1 column layout A–R (18 columns)
    // A=image  B=style_no  C=product_name  D=avr(skip)
    // E=S  F=M  G=L  H=XL  I=2XL  J=3XL
    // K=ttl_cutting(skip)  L=in_hand  M=trims(skip)  N=updates(skip)
    // O=fabric  P=channel1  Q=channel2  R=channel3
    const row = [
      '',           // A  image — leave blank
      styleNo,      // B
      productName,  // C
      '',           // D  AVR — ignored
      sQty,         // E  S
      mQty,         // F  M
      lQty,         // G  L
      xlQty,        // H  XL
      xxlQty,       // I  2XL
      xxxlQty,      // J  3XL
      '',           // K  TTL CUTTING — ignored
      inHand,       // L  IN HAND
      '',           // M  TRIMS AVG — ignored
      '',           // N  UPDATES — manual
      String(data.fabric || '').trim(),  // O  FABRIC
      channels[0] || '',  // P
      channels[1] || '',  // Q
      channels[2] || ''   // R
    ];

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const stockSheet = ss.getSheetByName(STOCK_SHEET_NAME);
    const nextRow = stockSheet.getLastRow() + 1;
    stockSheet.getRange(nextRow, 1, 1, row.length).setValues([row]);

    // Log initial stock to Movements
    const movementsSheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);
    if (movementsSheet && inHand > 0) {
      const now  = new Date();
      const tz   = Session.getScriptTimeZone();
      const ts   = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
      const user = Session.getActiveUser().getEmail() || 'unknown';
      const qtys = [sQty, mQty, lQty, xlQty, xxlQty, xxxlQty];
      const movRows = [];
      SIZES.forEach((size, i) => {
        if (qtys[i] <= 0) return;
        const mid = 'MOV-' + Utilities.formatDate(now, tz, 'yyyyMMddHHmmss') + '-NP-' + size;
        movRows.push([mid, ts, styleNo, size, qtys[i], 'NEW_PRODUCT',
                      'New product added: ' + productName, '', user]);
      });
      if (movRows.length) {
        movementsSheet.getRange(movementsSheet.getLastRow() + 1, 1, movRows.length, movRows[0].length)
          .setValues(movRows);
      }
    }

    SpreadsheetApp.flush();
    return { success: true, style_no: styleNo, product_name: productName, in_hand: inHand, row: nextRow };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// PRODUCT IMAGES
// ============================================================

/**
 * Returns (creating if necessary) the Drive folder for product images.
 * Placed alongside the spreadsheet so it follows the same access scope.
 */
function getOrCreateImagesFolder_() {
  const ssFile = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  const parents = ssFile.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const existing = parent.getFoldersByName(IMAGES_FOLDER_NAME);
  return existing.hasNext() ? existing.next() : parent.createFolder(IMAGES_FOLDER_NAME);
}

/**
 * Pulls the Drive file ID out of an IMAGE() formula in column A.
 * Supports both lh3.googleusercontent.com/d/ID and drive.google.com/...?id=ID forms.
 */
function extractFileIdFromImageFormula_(formula) {
  if (!formula || typeof formula !== 'string') return null;
  let m = formula.match(/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = formula.match(/drive\.google\.com\/(?:uc|thumbnail|file\/d)[^"]*[?&\/]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = formula.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

/**
 * Upload (or replace) an image for a product.
 * data = { style_no, image_base64, mime_type, filename }
 *
 * - Saves the image to the Drive folder
 * - Sets sharing to ANYONE_WITH_LINK (view) so the web app can render it
 * - Writes =IMAGE("…") into column A so it shows in the sheet
 * - Trashes the previous image file if there was one
 */
function uploadProductImage(data) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    const styleNo = String((data && data.style_no) || '').trim();
    if (!styleNo)            return { success: false, error: 'Style No. is required' };
    if (!data.image_base64)  return { success: false, error: 'Image data is required' };

    const mime = String(data.mime_type || 'image/jpeg').trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mime))
      return { success: false, error: 'Unsupported image type — use JPG, PNG, WebP, or GIF' };

    const products = getProducts();
    const product = products.find(p => p.style_no === styleNo);
    if (!product) return { success: false, error: 'Product not found: ' + styleNo };

    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(STOCK_SHEET_NAME);

    // Capture old image (for cleanup) BEFORE overwriting
    const oldFormula = sheet.getRange(product.row, STOCK_IMAGE_COL).getFormula();
    const oldFileId  = extractFileIdFromImageFormula_(oldFormula);

    // Decode + save new image
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    const safeName = String(data.filename || (styleNo + '.' + ext)).replace(/[\/\\:*?"<>|]/g, '_');
    const blob = Utilities.newBlob(Utilities.base64Decode(data.image_base64), mime, safeName);

    const folder = getOrCreateImagesFolder_();
    const file = folder.createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (shareErr) {
      // Workspace policies may block ANYONE_WITH_LINK — image still works inside Sheets
      // but won't render in the web app for non-domain users
    }

    const fileId   = file.getId();
    const imageUrl = 'https://lh3.googleusercontent.com/d/' + fileId;

    sheet.getRange(product.row, STOCK_IMAGE_COL).setFormula('=IMAGE("' + imageUrl + '")');
    if (sheet.getRowHeight(product.row) < IMAGE_ROW_HEIGHT) {
      sheet.setRowHeight(product.row, IMAGE_ROW_HEIGHT);
    }

    // Best-effort trash the previous file
    if (oldFileId && oldFileId !== fileId) {
      try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) { /* ignore */ }
    }

    SpreadsheetApp.flush();
    return { success: true, style_no: styleNo, image_id: fileId, image_url: imageUrl };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Removes a product's image — clears column A and trashes the Drive file.
 */
function removeProductImage(styleNo) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    styleNo = String(styleNo || '').trim();
    if (!styleNo) return { success: false, error: 'Style No. required' };

    const products = getProducts();
    const product = products.find(p => p.style_no === styleNo);
    if (!product) return { success: false, error: 'Product not found' };

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_SHEET_NAME);
    const cell  = sheet.getRange(product.row, STOCK_IMAGE_COL);
    const fileId = extractFileIdFromImageFormula_(cell.getFormula());

    cell.clearContent();
    if (fileId) {
      try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* ignore */ }
    }

    SpreadsheetApp.flush();
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// BATCH IMAGE EXPORT (for PDF generation)
// ============================================================

/**
 * Fetch product images from Drive and return them as base64 data URIs.
 * Used by the frontend PDF export to embed images directly in the document.
 *
 * imageIds: string[] — array of Drive file IDs
 * Returns: { [fileId]: "data:image/jpeg;base64,..." }
 *
 * Skips any IDs that fail to load (deleted files, permission issues).
 * Images are fetched as-is (already compressed during upload).
 */
function getProductImagesBatch(imageIds) {
  if (!Array.isArray(imageIds) || imageIds.length === 0) return {};

  var results = {};
  for (var i = 0; i < imageIds.length; i++) {
    var id = imageIds[i];
    if (!id || typeof id !== 'string') continue;
    try {
      var file = DriveApp.getFileById(id);
      var blob = file.getBlob();
      var mime = blob.getContentType() || 'image/jpeg';
      var b64 = Utilities.base64Encode(blob.getBytes());
      results[id] = 'data:' + mime + ';base64,' + b64;
    } catch (e) {
      // File not found, permission denied, or other error — skip
    }
  }
  return results;
}

// ============================================================
// REQUISITION ID GENERATOR — VH-YYYY-NN (sequential, yearly reset)
// ============================================================

/**
 * Generates the next sequential requisition ID in the format VH-YYYY-NN.
 *
 *   - Per-year counter (auto-resets on January 1)
 *   - Counter is stored in Script Properties (durable, persists across deployments)
 *   - Atomic: uses LockService so two simultaneous submits never collide
 *   - Reserved numbers: cancelled reqs DO NOT reuse their number (gaps allowed —
 *     matches invoice-number convention)
 *
 * Property key format: 'reqCounter_2026' → stores last issued number
 * Returns: e.g. 'VH-2026-01', 'VH-2026-12', 'VH-2026-247'
 */
function getNextRequisitionId_() {
  const tz = Session.getScriptTimeZone();
  const year = Utilities.formatDate(new Date(), tz, 'yyyy');
  const propKey = 'reqCounter_' + year;
  const props = PropertiesService.getScriptProperties();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const lastRaw = props.getProperty(propKey);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    const next = (isNaN(last) ? 0 : last) + 1;
    props.setProperty(propKey, String(next));

    // Pad to minimum 2 digits: 01, 02 … 09, 10, 11 … 99, 100, 101 …
    const padded = next < 100 ? ('0' + next).slice(-2) : String(next);
    return 'VH-' + year + '-' + padded;
  } finally {
    lock.releaseLock();
  }
}

/**
 * UTILITY — view the current counter state for all years.
 * Run from the editor to see "where am I at?"
 */
function showReqCounterStatus() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const counters = Object.keys(props)
    .filter(k => k.indexOf('reqCounter_') === 0)
    .map(k => ({ year: k.replace('reqCounter_', ''), last: parseInt(props[k], 10) }))
    .sort((a, b) => a.year.localeCompare(b.year));

  if (!counters.length) {
    SpreadsheetApp.getUi().alert(
      'No requisition counter set yet.\n\n' +
      'The first requisition you create will start at VH-' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy') + '-01.'
    );
    return;
  }

  let msg = 'REQUISITION COUNTER STATUS\n\n';
  counters.forEach(c => {
    const nextNum = c.last + 1;
    const padded = nextNum < 100 ? ('0' + nextNum).slice(-2) : String(nextNum);
    msg += 'Year ' + c.year + ': last issued = ' + c.last + ', next = VH-' + c.year + '-' + padded + '\n';
  });
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * UTILITY — manually set the counter for a specific year.
 * Useful for:
 *   - Seeding to match a paper-based system already in use
 *   - Recovering from accidental deletion of script properties
 *
 * Edit the YEAR and LAST_USED values below, then run from the editor.
 */
function setReqCounter() {
  const YEAR = '2026';        // ← change as needed
  const LAST_USED = 0;        // ← set to the last issued number for that year

  const ui = SpreadsheetApp.getUi();
  const nextNum = LAST_USED + 1;
  const padded = nextNum < 100 ? ('0' + nextNum).slice(-2) : String(nextNum);

  const confirm = ui.alert(
    'Set Counter',
    'Set ' + YEAR + ' requisition counter to ' + LAST_USED + '?\n\n' +
    'Next requisition will be VH-' + YEAR + '-' + padded + '.\n\n' +
    'This does NOT affect existing requisitions in the sheet.',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  PropertiesService.getScriptProperties().setProperty('reqCounter_' + YEAR, String(LAST_USED));
  ui.alert('Counter set. Next ID: VH-' + YEAR + '-' + padded);
}

/**
 * UTILITY — scan existing requisitions in the sheet and report on numbering.
 * Useful right after deployment to understand the mix of old (REQ-...) and
 * new (VH-...) IDs you have.
 */
function auditRequisitionIds() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(REQUISITIONS_SHEET_NAME);
  if (!sheet) { SpreadsheetApp.getUi().alert('Requisitions sheet not found.'); return; }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { SpreadsheetApp.getUi().alert('No requisitions yet.'); return; }

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0]).trim()).filter(Boolean);
  const unique = Array.from(new Set(ids));

  const oldFormat = unique.filter(id => /^REQ-/.test(id));
  const newFormat = unique.filter(id => /^VH-\d{4}-\d+$/.test(id));
  const other = unique.filter(id => !/^REQ-/.test(id) && !/^VH-\d{4}-\d+$/.test(id));

  let msg = 'REQUISITION ID AUDIT\n\n';
  msg += 'Total unique requisitions: ' + unique.length + '\n';
  msg += '  • Old format (REQ-...): ' + oldFormat.length + '\n';
  msg += '  • New format (VH-YYYY-NN): ' + newFormat.length + '\n';
  if (other.length) msg += '  • Other/unknown: ' + other.length + '\n';

  // Highest sequence number per year (from new-format IDs only)
  const perYear = {};
  newFormat.forEach(id => {
    const m = id.match(/^VH-(\d{4})-(\d+)$/);
    if (m) {
      const y = m[1], n = parseInt(m[2], 10);
      if (!perYear[y] || n > perYear[y]) perYear[y] = n;
    }
  });
  const years = Object.keys(perYear).sort();
  if (years.length) {
    msg += '\nHighest VH number per year:\n';
    years.forEach(y => msg += '  • ' + y + ': VH-' + y + '-' + perYear[y] + '\n');
  }

  SpreadsheetApp.getUi().alert(msg);
}

// ============================================================
// REQUISITIONS — PRODUCTION TRACKING
// ============================================================

/**
 * Read all requisitions, grouped by req_id.
 * filters: { status, master, search }
 */
function getRequisitions(filters) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(REQUISITIONS_SHEET_NAME);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const allData = sheet.getRange(1, 1, lastRow, 35).getValues();
  const headers = allData[0];
  const data = allData.slice(1);
  const tz = Session.getScriptTimeZone();

  // Group by req_id
  const map = {};
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const reqId = String(row[0] || '').trim();
    if (!reqId) continue;

    if (!map[reqId]) {
      map[reqId] = {
        req_id: reqId,
        created_at: row[2] instanceof Date
          ? Utilities.formatDate(row[2], tz, 'yyyy-MM-dd HH:mm:ss') : String(row[2] || ''),
        received_at: row[3] instanceof Date
          ? Utilities.formatDate(row[3], tz, 'yyyy-MM-dd HH:mm:ss') : String(row[3] || ''),
        master: String(row[4] || ''),
        fabric_name: String(row[5] || ''),
        meters_issued: Number(row[6]) || 0,
        status: String(row[31] || 'OPEN'),
        created_by: String(row[32] || ''),
        received_by: String(row[33] || ''),
        notes: String(row[34] || ''),
        items: [],
        est_total: 0,
        act_total: 0,
        total_loss: 0
      };
    }

    const item = {
      line_no: Number(row[1]) || 0,
      style_no: String(row[7] || ''),
      product_name: String(row[8] || ''),
      estimates: {},
      actuals: {},
      est_total: Number(row[15]) || 0,
      act_total: Number(row[22]) || 0,
      defective: Number(row[23]) || 0,
      fabric_shortage: Number(row[24]) || 0,
      cutting_waste: Number(row[25]) || 0,
      master_error: Number(row[26]) || 0,
      shrinkage: Number(row[27]) || 0,
      other_loss: Number(row[28]) || 0,
      total_loss: Number(row[29]) || 0,
      variance: Number(row[30]) || 0,
      notes: String(row[34] || '')
    };

    // Size-wise estimates (cols 9-14 = est_S..est_3XL)
    for (let s = 0; s < SIZES.length; s++) {
      item.estimates[SIZES[s]] = Number(row[9 + s]) || 0;
      item.actuals[SIZES[s]] = Number(row[16 + s]) || 0;
    }

    map[reqId].items.push(item);
    map[reqId].est_total += item.est_total;
    map[reqId].act_total += item.act_total;
    map[reqId].total_loss += item.total_loss;
  }

  let reqs = Object.values(map);

  // Apply filters
  if (filters) {
    if (filters.status) reqs = reqs.filter(r => r.status === filters.status);
    if (filters.master) {
      const m = String(filters.master).toLowerCase();
      reqs = reqs.filter(r => r.master.toLowerCase().includes(m));
    }
    if (filters.search) {
      const s = String(filters.search).toLowerCase();
      reqs = reqs.filter(r =>
        r.req_id.toLowerCase().includes(s) ||
        r.master.toLowerCase().includes(s) ||
        r.fabric_name.toLowerCase().includes(s) ||
        r.items.some(it => it.style_no.toLowerCase().includes(s) || it.product_name.toLowerCase().includes(s))
      );
    }
  }

  reqs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return reqs;
}

/**
 * Create a new requisition (fabric issued for stitching).
 * data = {
 *   master       : string,
 *   fabric_name  : string,
 *   meters_issued: number,
 *   notes        : string,
 *   items: [{ style_no, estimates: { S, M, L, XL, '2XL', '3XL' } }]
 * }
 */
function createRequisition(data) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    if (!data || typeof data !== 'object')
      return { success: false, error: 'Invalid data' };
    if (!data.master || !String(data.master).trim())
      return { success: false, error: 'Master/tailor name is required' };
    if (!data.fabric_name || !String(data.fabric_name).trim())
      return { success: false, error: 'Fabric name is required' };
    if (!data.meters_issued || Number(data.meters_issued) <= 0)
      return { success: false, error: 'Meters issued must be > 0' };
    if (!Array.isArray(data.items) || data.items.length === 0)
      return { success: false, error: 'Add at least one style/product' };

    const products = getProducts();
    const productMap = {};
    products.forEach(p => productMap[p.style_no] = p);

    // Validate items
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const styleNo = String(item.style_no || '').trim();
      if (!styleNo) return { success: false, error: 'Item ' + (i + 1) + ': Style No. required' };
      if (!productMap[styleNo]) return { success: false, error: 'Product not found: ' + styleNo };
      const est = item.estimates || {};
      const estTotal = SIZES.reduce((s, sz) => s + (Number(est[sz]) || 0), 0);
      if (estTotal <= 0) return { success: false, error: 'Item ' + (i + 1) + ' (' + styleNo + '): estimated quantity must be > 0' };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(REQUISITIONS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Requisitions sheet not found. Run setupInventorySystem().' };

    const now = new Date();
    const tz = Session.getScriptTimeZone();

    // ── Sequential VH-YYYY-NN ID (atomic, yearly reset) ──
    const reqId = getNextRequisitionId_();

    const createdAt = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const user = Session.getActiveUser().getEmail() || 'unknown';

    const rows = [];
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const styleNo = String(item.style_no).trim();
      const product = productMap[styleNo];
      const est = item.estimates || {};
      const estValues = SIZES.map(sz => Number(est[sz]) || 0);
      const estTotal = estValues.reduce((s, v) => s + v, 0);

      rows.push([
        reqId,                                    // req_id
        i + 1,                                    // line_no
        now,                                      // created_at
        '',                                       // received_at
        String(data.master).trim(),               // master
        String(data.fabric_name).trim(),          // fabric_name
        Number(data.meters_issued),               // meters_issued
        styleNo,                                  // style_no
        product.product_name,                     // product_name
        estValues[0], estValues[1], estValues[2],  // est_S, est_M, est_L
        estValues[3], estValues[4], estValues[5],  // est_XL, est_2XL, est_3XL
        estTotal,                                 // est_total
        '', '', '', '', '', '',                   // act_S..act_3XL (empty until received)
        '',                                       // act_total
        '', '', '', '', '', '',                   // defective..other_loss
        '',                                       // total_loss
        '',                                       // variance
        'OPEN',                                   // status
        user,                                     // created_by
        '',                                       // received_by
        String(data.notes || '').trim()           // notes
      ]);
    }

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    SpreadsheetApp.flush();

    return {
      success: true,
      req_id: reqId,
      items_count: data.items.length,
      est_total: rows.reduce((s, r) => s + r[15], 0)
    };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Receive a requisition (FINAL) — mark finished goods received, add to stock.
 * Handles both OPEN and PARTIAL requisitions. For PARTIAL reqs, actuals in
 * data.items are THIS BATCH only; the function adds them to previously received.
 *
 * data = {
 *   req_id: string,
 *   items: [{
 *     line_no: number,
 *     actuals: { S, M, L, XL, '2XL', '3XL' },   // THIS BATCH quantities
 *     defective: number,
 *     fabric_shortage: number,
 *     cutting_waste: number,
 *     master_error: number,
 *     shrinkage: number,
 *     other_loss: number
 *   }],
 *   notes: string
 * }
 */
function receiveRequisition(data) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    if (!data || !data.req_id)
      return { success: false, error: 'Requisition ID required' };
    if (!Array.isArray(data.items) || data.items.length === 0)
      return { success: false, error: 'No items provided' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const reqSheet = ss.getSheetByName(REQUISITIONS_SHEET_NAME);
    const stockSheet = ss.getSheetByName(STOCK_SHEET_NAME);
    const movementsSheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);

    if (!reqSheet) return { success: false, error: 'Requisitions sheet not found' };

    const lastRow = reqSheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Requisition not found' };

    const allData = reqSheet.getRange(1, 1, lastRow, 35).getValues();
    const dataRows = allData.slice(1);

    // Find all rows for this req_id
    const matching = [];
    for (let i = 0; i < dataRows.length; i++) {
      if (String(dataRows[i][0]).trim() === data.req_id) {
        matching.push({ idx: i, sheetRow: i + 2, row: dataRows[i] });
      }
    }

    if (matching.length === 0)
      return { success: false, error: 'Requisition not found: ' + data.req_id };
    const currentStatus = String(matching[0].row[31]).trim();
    if (currentStatus !== 'OPEN' && currentStatus !== 'PARTIAL')
      return { success: false, error: 'Requisition is not OPEN or PARTIAL (current status: ' + currentStatus + ')' };

    // Build lookup for received items
    const itemMap = {};
    for (const item of data.items) {
      itemMap[item.line_no] = item;
    }

    const products = getProducts();
    const productMap = {};
    products.forEach(p => productMap[p.style_no] = p);

    const now = new Date();
    const tz = Session.getScriptTimeZone();
    const ts = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const user = Session.getActiveUser().getEmail() || 'unknown';
    const movementRows = [];

    // Validate all items first (fail fast)
    for (const m of matching) {
      const lineNo = Number(m.row[1]);
      const received = itemMap[lineNo];
      if (!received)
        return { success: false, error: 'Missing received data for line ' + lineNo };

      // Read previously received actuals from the sheet row
      const prevActuals = SIZES.map((sz, idx) => Number(m.row[16 + idx]) || 0);
      const thisBatch = received.actuals || {};
      const thisBatchValues = SIZES.map(sz => Number(thisBatch[sz]) || 0);

      // Cumulative = previous + this batch
      const cumulativeValues = SIZES.map((sz, idx) => prevActuals[idx] + thisBatchValues[idx]);
      const cumulativeTotal = cumulativeValues.reduce((s, v) => s + v, 0);
      const estTotal = Number(m.row[15]) || 0;

      // Validate shortage breakdown accounts for the gap
      const defective = Number(received.defective) || 0;
      const fabricShortage = Number(received.fabric_shortage) || 0;
      const cuttingWaste = Number(received.cutting_waste) || 0;
      const masterError = Number(received.master_error) || 0;
      const shrinkage = Number(received.shrinkage) || 0;
      const otherLoss = Number(received.other_loss) || 0;
      const totalLoss = defective + fabricShortage + cuttingWaste + masterError + shrinkage + otherLoss;
      const gap = estTotal - cumulativeTotal;

      // If cumulative actual < estimate, loss breakdown MUST account for the gap exactly
      if (gap > 0 && totalLoss !== gap)
        return { success: false, error: 'Line ' + lineNo + ': shortage is ' + gap + ' but loss breakdown totals ' + totalLoss + '. Must account for every missing piece.' };

      const styleNo = String(m.row[7]).trim();
      if (!productMap[styleNo])
        return { success: false, error: 'Product not found in stock: ' + styleNo };
    }

    // All validations passed — apply updates
    for (const m of matching) {
      const lineNo = Number(m.row[1]);
      const received = itemMap[lineNo];
      const thisBatch = received.actuals || {};
      const thisBatchValues = SIZES.map(sz => Number(thisBatch[sz]) || 0);
      const thisBatchTotal = thisBatchValues.reduce((s, v) => s + v, 0);

      // Read previously received and compute cumulative
      const prevActuals = SIZES.map((sz, idx) => Number(m.row[16 + idx]) || 0);
      const cumulativeValues = SIZES.map((sz, idx) => prevActuals[idx] + thisBatchValues[idx]);
      const cumulativeTotal = cumulativeValues.reduce((s, v) => s + v, 0);
      const estTotal = Number(m.row[15]) || 0;

      const defective = Number(received.defective) || 0;
      const fabricShortage = Number(received.fabric_shortage) || 0;
      const cuttingWaste = Number(received.cutting_waste) || 0;
      const masterError = Number(received.master_error) || 0;
      const shrinkage_ = Number(received.shrinkage) || 0;
      const otherLoss = Number(received.other_loss) || 0;
      const totalLoss = defective + fabricShortage + cuttingWaste + masterError + shrinkage_ + otherLoss;
      const variance = cumulativeTotal - estTotal;

      const styleNo = String(m.row[7]).trim();
      const product = productMap[styleNo];

      reqSheet.getRange(m.sheetRow, 4).setValue(now);                       // received_at
      reqSheet.getRange(m.sheetRow, 17, 1, 6).setValues([cumulativeValues]); // act_S..act_3XL (cumulative)
      reqSheet.getRange(m.sheetRow, 23).setValue(cumulativeTotal);           // act_total (cumulative)
      reqSheet.getRange(m.sheetRow, 24).setValue(defective);
      reqSheet.getRange(m.sheetRow, 25).setValue(fabricShortage);
      reqSheet.getRange(m.sheetRow, 26).setValue(cuttingWaste);
      reqSheet.getRange(m.sheetRow, 27).setValue(masterError);
      reqSheet.getRange(m.sheetRow, 28).setValue(shrinkage_);
      reqSheet.getRange(m.sheetRow, 29).setValue(otherLoss);
      reqSheet.getRange(m.sheetRow, 30).setValue(totalLoss);
      reqSheet.getRange(m.sheetRow, 31).setValue(variance);
      reqSheet.getRange(m.sheetRow, 32).setValue('RECEIVED');
      reqSheet.getRange(m.sheetRow, 34).setValue(user);
      // Build notes: general note + other_loss reason
      var lineNotes = [];
      if (data.notes) lineNotes.push(String(data.notes).trim());
      if (received.other_note && otherLoss > 0) lineNotes.push('Other loss reason: ' + String(received.other_note).trim());
      if (lineNotes.length) reqSheet.getRange(m.sheetRow, 35).setValue(lineNotes.join(' | '));

      // Add ONLY THIS BATCH quantities to Sheet1 stock (not cumulative — avoids double-counting)
      for (let s = 0; s < SIZES.length; s++) {
        const qty = thisBatchValues[s];
        if (qty <= 0) continue;
        const sizeCol = SIZE_COLUMNS[SIZES[s]];
        const currentQty = product.sizes[SIZES[s]] || 0;
        const newQty = currentQty + qty;
        stockSheet.getRange(product.row, sizeCol).setValue(newQty);
        product.sizes[SIZES[s]] = newQty;

        const mid = 'MOV-' + Utilities.formatDate(now, tz, 'yyyyMMddHHmmss') + '-REQ-' + lineNo + '-' + SIZES[s];
        movementRows.push([
          mid, ts, styleNo, SIZES[s], qty,
          'PRODUCTION_RECEIVED',
          'Requisition ' + data.req_id + ' (final) · Master: ' + String(m.row[4]),
          data.req_id, user
        ]);
      }

      // Recompute IN HAND
      const newInHand = SIZES.reduce((s, sz) => s + (product.sizes[sz] || 0), 0);
      stockSheet.getRange(product.row, STOCK_IN_HAND_COL).setValue(newInHand);
      product.in_hand = newInHand;
    }

    if (movementRows.length && movementsSheet) {
      movementsSheet.getRange(movementsSheet.getLastRow() + 1, 1, movementRows.length, movementRows[0].length)
        .setValues(movementRows);
    }

    SpreadsheetApp.flush();

    const totalAdded = matching.reduce((s, m) => {
      const received = itemMap[Number(m.row[1])];
      return s + SIZES.reduce((ss, sz) => ss + (Number((received.actuals || {})[sz]) || 0), 0);
    }, 0);

    return {
      success: true,
      req_id: data.req_id,
      total_added: totalAdded,
      lines_received: matching.length
    };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Partially receive a requisition — add goods to stock, keep req open for more.
 * Sets status to PARTIAL. No loss reconciliation required.
 *
 * data = {
 *   req_id: string,
 *   items: [{ line_no: number, actuals: { S, M, L, XL, '2XL', '3XL' } }],
 *   notes: string
 * }
 */
function partialReceiveRequisition(data) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    if (!data || !data.req_id)
      return { success: false, error: 'Requisition ID required' };
    if (!Array.isArray(data.items) || data.items.length === 0)
      return { success: false, error: 'No items provided' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const reqSheet = ss.getSheetByName(REQUISITIONS_SHEET_NAME);
    const stockSheet = ss.getSheetByName(STOCK_SHEET_NAME);
    const movementsSheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);

    if (!reqSheet) return { success: false, error: 'Requisitions sheet not found' };

    const lastRow = reqSheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Requisition not found' };

    const allData = reqSheet.getRange(1, 1, lastRow, 35).getValues();
    const dataRows = allData.slice(1);

    // Find all rows for this req_id
    const matching = [];
    for (let i = 0; i < dataRows.length; i++) {
      if (String(dataRows[i][0]).trim() === data.req_id) {
        matching.push({ idx: i, sheetRow: i + 2, row: dataRows[i] });
      }
    }

    if (matching.length === 0)
      return { success: false, error: 'Requisition not found: ' + data.req_id };
    const currentStatus = String(matching[0].row[31]).trim();
    if (currentStatus !== 'OPEN' && currentStatus !== 'PARTIAL')
      return { success: false, error: 'Cannot partially receive — current status: ' + currentStatus };

    // Build lookup
    const itemMap = {};
    for (const item of data.items) {
      itemMap[item.line_no] = item;
    }

    const products = getProducts();
    const productMap = {};
    products.forEach(p => productMap[p.style_no] = p);

    const now = new Date();
    const tz = Session.getScriptTimeZone();
    const ts = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
    const user = Session.getActiveUser().getEmail() || 'unknown';
    const movementRows = [];

    // Validate: at least one item must have a quantity > 0
    let anyQty = false;
    for (const m of matching) {
      const lineNo = Number(m.row[1]);
      const received = itemMap[lineNo];
      if (!received) continue;
      const thisBatch = received.actuals || {};
      const thisBatchTotal = SIZES.reduce((s, sz) => s + (Number(thisBatch[sz]) || 0), 0);
      if (thisBatchTotal > 0) anyQty = true;

      // Check cumulative won't exceed estimate (warning only — allow surplus)
      const styleNo = String(m.row[7]).trim();
      if (!productMap[styleNo])
        return { success: false, error: 'Product not found in stock: ' + styleNo };
    }

    if (!anyQty)
      return { success: false, error: 'Enter at least one quantity to receive' };

    // Apply updates
    let totalAdded = 0;
    for (const m of matching) {
      const lineNo = Number(m.row[1]);
      const received = itemMap[lineNo];
      if (!received) continue;

      const thisBatch = received.actuals || {};
      const thisBatchValues = SIZES.map(sz => Number(thisBatch[sz]) || 0);
      const thisBatchTotal = thisBatchValues.reduce((s, v) => s + v, 0);

      // Read previous actuals and compute new cumulative
      const prevActuals = SIZES.map((sz, idx) => Number(m.row[16 + idx]) || 0);
      const cumulativeValues = SIZES.map((sz, idx) => prevActuals[idx] + thisBatchValues[idx]);
      const cumulativeTotal = cumulativeValues.reduce((s, v) => s + v, 0);

      // Update requisition row: cumulative actuals and status
      reqSheet.getRange(m.sheetRow, 17, 1, 6).setValues([cumulativeValues]); // act_S..act_3XL
      reqSheet.getRange(m.sheetRow, 23).setValue(cumulativeTotal);            // act_total
      reqSheet.getRange(m.sheetRow, 32).setValue('PARTIAL');                  // status

      // Append partial receive note
      const existingNotes = String(m.row[34] || '').trim();
      const newNote = 'Partial recv ' + ts + ': +' + thisBatchTotal + ' pcs';
      const combinedNotes = existingNotes ? existingNotes + ' | ' + newNote : newNote;
      if (data.notes) {
        reqSheet.getRange(m.sheetRow, 35).setValue(combinedNotes + ' | ' + String(data.notes).trim());
      } else {
        reqSheet.getRange(m.sheetRow, 35).setValue(combinedNotes);
      }

      // Add THIS BATCH quantities to Sheet1 stock
      const styleNo = String(m.row[7]).trim();
      const product = productMap[styleNo];

      for (let s = 0; s < SIZES.length; s++) {
        const qty = thisBatchValues[s];
        if (qty <= 0) continue;
        const sizeCol = SIZE_COLUMNS[SIZES[s]];
        const currentQty = product.sizes[SIZES[s]] || 0;
        const newQty = currentQty + qty;
        stockSheet.getRange(product.row, sizeCol).setValue(newQty);
        product.sizes[SIZES[s]] = newQty;

        const mid = 'MOV-' + Utilities.formatDate(now, tz, 'yyyyMMddHHmmss') + '-PREQ-' + lineNo + '-' + SIZES[s];
        movementRows.push([
          mid, ts, styleNo, SIZES[s], qty,
          'PRODUCTION_PARTIAL',
          'Requisition ' + data.req_id + ' (partial) · Master: ' + String(m.row[4]),
          data.req_id, user
        ]);
      }

      // Recompute IN HAND
      const newInHand = SIZES.reduce((s, sz) => s + (product.sizes[sz] || 0), 0);
      stockSheet.getRange(product.row, STOCK_IN_HAND_COL).setValue(newInHand);
      product.in_hand = newInHand;

      totalAdded += thisBatchTotal;
    }

    if (movementRows.length && movementsSheet) {
      movementsSheet.getRange(movementsSheet.getLastRow() + 1, 1, movementRows.length, movementRows[0].length)
        .setValues(movementRows);
    }

    SpreadsheetApp.flush();

    return {
      success: true,
      req_id: data.req_id,
      total_added: totalAdded,
      status: 'PARTIAL'
    };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Cancel an OPEN requisition.
 * Note: The cancelled requisition's number remains "reserved" — the counter
 * is not rolled back. This is intentional (matches invoice-number convention).
 */
function cancelRequisition(reqId, reason) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return { success: false, error: 'System busy. Please try again.' }; }

  try {
    if (!reqId) return { success: false, error: 'Requisition ID required' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(REQUISITIONS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Requisitions sheet not found' };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Requisition not found' };

    const data = sheet.getRange(2, 1, lastRow - 1, 35).getValues();
    let found = false;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === reqId) {
        found = true;
        if (String(data[i][31]).trim() !== 'OPEN' && String(data[i][31]).trim() !== 'PARTIAL')
          return { success: false, error: 'Can only cancel OPEN or PARTIAL requisitions (current: ' + data[i][31] + ')' };
        sheet.getRange(i + 2, 32).setValue('CANCELLED'); // status
        if (reason) sheet.getRange(i + 2, 35).setValue(String(reason).trim()); // notes
      }
    }

    if (!found) return { success: false, error: 'Requisition not found: ' + reqId };

    SpreadsheetApp.flush();
    return { success: true };

  } catch (e) {
    return { success: false, error: 'Error: ' + (e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Get requisition summary stats for the dashboard.
 */
function getRequisitionStats() {
  const reqs = getRequisitions();
  const open = reqs.filter(r => r.status === 'OPEN' || r.status === 'PARTIAL');
  const received = reqs.filter(r => r.status === 'RECEIVED');

  let totalEstimated = 0, totalReceived = 0, totalLoss = 0;
  let defectiveTotal = 0, fabricShortageTotal = 0, cuttingWasteTotal = 0;
  let masterErrorTotal = 0, shrinkageTotal = 0, otherLossTotal = 0;

  received.forEach(r => {
    r.items.forEach(it => {
      totalEstimated += it.est_total;
      totalReceived += it.act_total;
      defectiveTotal += it.defective;
      fabricShortageTotal += it.fabric_shortage;
      cuttingWasteTotal += it.cutting_waste;
      masterErrorTotal += it.master_error;
      shrinkageTotal += it.shrinkage;
      otherLossTotal += it.other_loss;
    });
  });
  totalLoss = defectiveTotal + fabricShortageTotal + cuttingWasteTotal + masterErrorTotal + shrinkageTotal + otherLossTotal;

  // Master performance
  const masterStats = {};
  received.forEach(r => {
    const name = r.master;
    if (!masterStats[name]) masterStats[name] = { est: 0, act: 0, defective: 0, batches: 0 };
    masterStats[name].batches++;
    r.items.forEach(it => {
      masterStats[name].est += it.est_total;
      masterStats[name].act += it.act_total;
      masterStats[name].defective += it.defective;
    });
  });

  return {
    open_count: open.length,
    open_est_total: open.reduce((s, r) => s + r.est_total, 0),
    received_count: received.length,
    total_estimated: totalEstimated,
    total_received: totalReceived,
    total_loss: totalLoss,
    efficiency: totalEstimated > 0 ? Math.round((totalReceived / totalEstimated) * 100) : 0,
    loss_breakdown: {
      defective: defectiveTotal,
      fabric_shortage: fabricShortageTotal,
      cutting_waste: cuttingWasteTotal,
      master_error: masterErrorTotal,
      shrinkage: shrinkageTotal,
      other_loss: otherLossTotal
    },
    master_stats: Object.keys(masterStats).map(name => ({
      master: name,
      batches: masterStats[name].batches,
      est: masterStats[name].est,
      act: masterStats[name].act,
      defective: masterStats[name].defective,
      efficiency: masterStats[name].est > 0
        ? Math.round((masterStats[name].act / masterStats[name].est) * 100) : 0
    })),
    total_batches: reqs.length
  };
}

// ============================================================
// PRODUCTION REPORT
// ============================================================

/**
 * Per-product Made / Sold / In Hand report.
 *
 * FORMULA (simple and always reconciles):
 *   Sold (Net) = sum of quantities from non-cancelled Orders
 *   In Hand    = current stock from Sheet1 column L
 *   Made       = In Hand + Sold (Net)
 *
 * Why this formula:
 *   "Made" colloquially means everything ever produced.
 *   Whatever is currently in stock was made. Whatever has been sold was also
 *   made. So Made = Stock + Sold by inventory identity. This works for both
 *   newly-added products AND for products that existed in Sheet1 before this
 *   app was deployed (which have no Movement records to aggregate from).
 *
 * Sold is read from the Orders sheet (source of truth for sales) rather than
 * the Movements sheet, so it's reliable even if movements were missed.
 *
 * Returns: { products: [...], totals: {...}, generated_at: 'yyyy-MM-dd HH:mm:ss' }
 */
function getProductionReport() {
  const products = getProducts();

  // Initialize aggregator. If two rows in Sheet1 share the same style_no
  // (data-entry duplicate), MERGE by summing — same behavior as the
  // Dashboard, so the two reports never disagree on totals.
  const agg = {};
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (agg[p.style_no]) {
      agg[p.style_no].in_hand     += p.in_hand;
      agg[p.style_no].duplicate_count += 1;
    } else {
      agg[p.style_no] = {
        style_no: p.style_no,
        product_name: p.product_name,
        image_id: p.image_id || null,
        sold: 0,
        in_hand: p.in_hand,
        duplicate_count: 1
      };
    }
  }

  // Read Orders sheet directly — Orders is the source of truth for sales.
  // Auto-detect header row (same approach as getOrders).
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordersSheet = ss.getSheetByName(ORDERS_SHEET_NAME);
  if (ordersSheet) {
    const lastRow = ordersSheet.getLastRow();
    if (lastRow >= 1) {
      const allData = ordersSheet.getRange(1, 1, lastRow, 13).getValues();
      const hasHeader = String(allData[0][0] || '').toLowerCase() === 'order_id';
      const data = hasHeader ? allData.slice(1) : allData;

      for (let i = 0; i < data.length; i++) {
        const styleNo = String(data[i][5] || '').trim();   // col F = style_no
        const qty     = Number(data[i][8]) || 0;            // col I = quantity
        const status  = String(data[i][9] || '').trim();    // col J = status
        if (!styleNo) continue;
        if (status === 'Cancelled') continue;               // exclude cancelled orders
        const a = agg[styleNo];
        if (a) a.sold += qty;
      }
    }
  }

  // Compute Made = In Hand + Sold for each product, plus global totals
  let totalMade = 0, totalSold = 0, totalInHand = 0;
  const items = [];
  const keys = Object.keys(agg);
  for (let i = 0; i < keys.length; i++) {
    const a = agg[keys[i]];
    const made = a.in_hand + a.sold;
    const sellThrough = made > 0 ? Math.round((a.sold / made) * 100) : 0;
    totalMade   += made;
    totalSold   += a.sold;
    totalInHand += a.in_hand;
    items.push({
      style_no:     a.style_no,
      product_name: a.product_name,
      image_id:     a.image_id,
      manufactured: made,
      sold:         a.sold,
      in_hand:      a.in_hand,
      sell_through: sellThrough
    });
  }

  const tz = Session.getScriptTimeZone();
  return {
    products: items,
    totals: {
      manufactured:  totalMade,
      sold:          totalSold,
      in_hand:       totalInHand,
      sell_through:  totalMade > 0 ? Math.round((totalSold / totalMade) * 100) : 0,
      product_count: items.length
    },
    generated_at: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
  };
}

// ============================================================
// DUPLICATE STYLE-NUMBER FINDER
// ============================================================

/**
 * UTILITY — run from the Apps Script editor when totals don't match
 * between Dashboard and Production Report.
 *
 * Scans Sheet1, finds any style_no that appears in more than one row,
 * and shows you the exact row numbers + product names + in-hand values.
 *
 * Use this to clean up duplicate entries in Sheet1 manually.
 */
function findDuplicateStyleNumbers() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Stock sheet "' + STOCK_SHEET_NAME + '" not found.');
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < STOCK_DATA_START_ROW) {
    SpreadsheetApp.getUi().alert('No data rows in Sheet1.');
    return;
  }

  const numRows = lastRow - STOCK_DATA_START_ROW + 1;
  const values = sheet.getRange(STOCK_DATA_START_ROW, 1, numRows, STOCK_IN_HAND_COL).getValues();

  // Group rows by style_no
  const groups = {};
  for (let i = 0; i < values.length; i++) {
    const styleNo = String(values[i][STOCK_STYLE_NO_COL - 1] || '').trim();
    if (!styleNo) continue;
    const productName = String(values[i][STOCK_PRODUCT_NAME_COL - 1] || '').trim();
    const inHand = Number(values[i][STOCK_IN_HAND_COL - 1]) || 0;
    const sheetRow = STOCK_DATA_START_ROW + i;

    if (!groups[styleNo]) groups[styleNo] = [];
    groups[styleNo].push({ row: sheetRow, product_name: productName, in_hand: inHand });
  }

  // Find duplicates
  const duplicates = [];
  const keys = Object.keys(groups);
  for (let i = 0; i < keys.length; i++) {
    if (groups[keys[i]].length > 1) {
      duplicates.push({ style_no: keys[i], rows: groups[keys[i]] });
    }
  }

  if (duplicates.length === 0) {
    SpreadsheetApp.getUi().alert(
      'No duplicates found.\n\n' +
      'Scanned ' + numRows + ' rows / ' + keys.length + ' unique style numbers.\n\n' +
      'If totals still differ, send the issue back to the developer.'
    );
    return;
  }

  // Build readable report
  let msg = 'Found ' + duplicates.length + ' duplicate style number(s):\n\n';
  for (let i = 0; i < duplicates.length; i++) {
    const d = duplicates[i];
    let totalForStyle = 0;
    msg += '──────────────\n';
    msg += 'Style: ' + d.style_no + '\n';
    for (let j = 0; j < d.rows.length; j++) {
      const r = d.rows[j];
      msg += '  Row ' + r.row + ': "' + r.product_name + '" — in hand: ' + r.in_hand + '\n';
      totalForStyle += r.in_hand;
    }
    msg += '  Total across duplicates: ' + totalForStyle + '\n';
    if (i >= 9) { // safety cap on alert length
      msg += '\n…and ' + (duplicates.length - 10) + ' more (see Logger).\n';
      break;
    }
  }
  msg += '\nTo fix: open Sheet1, decide which row is correct, delete the other(s).\n';
  msg += 'Then refresh the web app.';

  // Always log full details too (in case alert truncates)
  Logger.log(JSON.stringify(duplicates, null, 2));

  SpreadsheetApp.getUi().alert(msg);
}