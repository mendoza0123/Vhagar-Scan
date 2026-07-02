# Generates db/seed.sql from the merged master CSVs.
# Re-run any time the master data changes.
$ErrorActionPreference = "Stop"
$root      = "E:\vhagar-pos"
$stylesCsv = Join-Path $root "data\master_styles.csv"
$varsCsv   = Join-Path $root "data\master_variants.csv"
$out       = Join-Path $root "db\seed.sql"

function Sql([string]$v) {
  if ($null -eq $v -or $v -eq "") { return "NULL" }
  return "'" + ($v -replace "'", "''") + "'"
}
function Num([string]$v) {
  if ($null -eq $v -or $v -eq "") { return "NULL" }
  return ($v -replace "[^0-9.]", "")
}
# Styles flagged by the data build as still needing a confirmed price
$needPrice = @("VH-KN100","VH-PLV5197A","VH-X5C28A","VH-Y5A183B")

$styles = Import-Csv $stylesCsv
$vars   = Import-Csv $varsCsv

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("-- Vhagar POS seed data (generated from master CSVs). Run AFTER schema.sql.")
[void]$sb.AppendLine("-- Idempotent: ON CONFLICT keeps the catalog re-runnable without dupes.")
[void]$sb.AppendLine("BEGIN;")
[void]$sb.AppendLine("")

# ---- products (styles) ----
[void]$sb.AppendLine("INSERT INTO products (style_code, name, color, category, fabric, description, base_price, channels) VALUES")
$rows = foreach ($s in $styles) {
  $sc = Sql $s.style_code
  $nm = Sql $s.name
  $cl = Sql $s.color
  $ct = Sql $s.category
  $fb = Sql $s.fabric
  $ds = Sql $s.unique_name
  $bp = Num $s.price
  $ch = Sql $s.channels
  "  ($sc, $nm, $cl, $ct, $fb, $ds, $bp, $ch)"
}
[void]$sb.AppendLine(($rows -join ",`r`n"))
[void]$sb.AppendLine("ON CONFLICT (style_code) DO UPDATE SET")
[void]$sb.AppendLine("  name=EXCLUDED.name, color=EXCLUDED.color, category=EXCLUDED.category,")
[void]$sb.AppendLine("  fabric=EXCLUDED.fabric, description=EXCLUDED.description,")
[void]$sb.AppendLine("  base_price=EXCLUDED.base_price, channels=EXCLUDED.channels;")
[void]$sb.AppendLine("")

# ---- variants ----
[void]$sb.AppendLine("INSERT INTO variants (variant_sku, style_code, size, price, needs_price, qty_on_hand) VALUES")
$rows = foreach ($v in $vars) {
  $vs = Sql $v.variant_sku
  $sc = Sql $v.style_code
  $sz = Sql $v.size
  # variants.price is NOT NULL; needs_price=TRUE rows have no suggested_price yet,
  # so seed a 0 placeholder (admin sets the real price before they can be billed).
  $pr = Num $v.suggested_price
  if ($pr -eq "NULL") { $pr = "0" }
  $np = if ($needPrice -contains $v.style_code -or $v.needs_price -match '^(true|1|yes)$') { "TRUE" } else { "FALSE" }
  $qty = if ($v.qty -eq "") { "0" } else { ($v.qty -replace "[^0-9]","") }
  "  ($vs, $sc, $sz, $pr, $np, $qty)"
}
[void]$sb.AppendLine(($rows -join ",`r`n"))
[void]$sb.AppendLine("ON CONFLICT (variant_sku) DO UPDATE SET")
[void]$sb.AppendLine("  price=EXCLUDED.price, needs_price=EXCLUDED.needs_price, qty_on_hand=EXCLUDED.qty_on_hand;")
[void]$sb.AppendLine("")

# ---- opening-stock ledger ----
[void]$sb.AppendLine("-- Opening stock as the first ledger entry (only if no movements exist yet)")
[void]$sb.AppendLine("INSERT INTO stock_movements (variant_sku, delta, reason)")
[void]$sb.AppendLine("SELECT variant_sku, qty_on_hand, 'opening' FROM variants")
[void]$sb.AppendLine("WHERE NOT EXISTS (SELECT 1 FROM stock_movements);")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("COMMIT;")

Set-Content -Path $out -Value $sb.ToString() -Encoding utf8

$nStyles = $styles.Count
$nVars   = $vars.Count
$pieces  = ($vars | Measure-Object -Property qty -Sum).Sum
"seed.sql written: $out"
"  products (styles): $nStyles"
"  variants:          $nVars"
"  pieces (sum qty):  $pieces"
