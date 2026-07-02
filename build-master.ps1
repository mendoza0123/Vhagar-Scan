Add-Type -AssemblyName Microsoft.VisualBasic

$imsPath  = "C:\Users\Admin\Downloads\Vhagar IMS F1.1 - Sheet1.csv"
$listPath = "C:\Users\Admin\Downloads\Product listing.csv"
$outDir   = "E:\vhagar-pos\data"

function Norm($s) {
  if (-not $s) { return '' }
  return ($s.ToString().ToUpper().Trim().TrimEnd('_') -replace '\s','')
}
function Unpad($s) { return ($s -replace '(?<=[A-Z])0(\d\d)', '$1') }
function ToInt($s) {
  if (-not $s) { return 0 }
  $t = $s.ToString().Trim()
  $n = 0
  if ([int]::TryParse($t, [ref]$n)) { return $n }
  return 0
}

# ---- listing dictionary (price/color/category/name keyed by normalized SKU) ----
$listing = @{}
foreach ($r in (Import-Csv $listPath)) {
  $m = [regex]::Match($r.'STLYE no/SKU', 'VH-[A-Z0-9]+')
  if (-not $m.Success) { continue }
  $k = Norm($m.Value)
  if (-not $listing.ContainsKey($k)) {
    $listing[$k] = [pscustomobject]@{
      Price      = $r.Price
      Color      = $r.Color
      Category   = $r.Category
      ProductNm  = $r.'Product Name'
      UniqueNm   = $r.'Unique name of the shirt'
    }
  }
}

$alias = @{ 'VH-OPL012'='VH-OPL12'; 'VH-OPL015'='VH-OPL15'; 'VH-LLO7'='VH-LL07' }
$sizes = @('S','M','L','XL','2XL','3XL')

# ---- parse IMS ----
$parser = New-Object Microsoft.VisualBasic.FileIO.TextFieldParser($imsPath)
$parser.TextFieldType = 'Delimited'
$parser.SetDelimiters(',')
$parser.HasFieldsEnclosedInQuotes = $true

$styles   = @()
$variants = @()
$needPrice = @()

while (-not $parser.EndOfData) {
  try { $f = $parser.ReadFields() } catch { $parser.ReadLine() | Out-Null; continue }
  if ($f.Count -lt 12) { continue }
  $styleRaw = $f[1]
  if (-not $styleRaw -or $styleRaw -notmatch '^\s*VH-') { continue }

  $sn = Norm($styleRaw)
  # resolve to catalog/canonical code + price
  $canon = $sn; $price = $null
  if ($listing.ContainsKey($sn)) { $canon = $sn }
  elseif ($alias.ContainsKey($sn) -and $listing.ContainsKey($alias[$sn])) { $canon = $alias[$sn] }
  elseif ($listing.ContainsKey((Unpad $sn))) { $canon = (Unpad $sn) }
  $info = $listing[$canon]
  if ($info) { $price = $info.Price }

  $name   = ($f[2] -replace '\s+',' ').Trim()
  $fabric = if ($f.Count -gt 14) { ($f[14] -replace '\s+',' ').Trim() } else { '' }
  $tags = @()
  for ($i = 15; $i -lt $f.Count; $i++) {
    $v = ($f[$i]).Trim()
    if ($v -match 'SHOPIFY|FLIPKART|AMAZON|SUPERCOOL') { $tags += $v.ToUpper() }
  }

  $sz = @{}
  $tot = 0
  for ($i = 0; $i -lt 6; $i++) {
    $q = ToInt($f[4 + $i])
    $sz[$sizes[$i]] = $q
    $tot += $q
    if ($q -gt 0) {
      $variants += [pscustomobject]@{
        variant_sku    = "$canon-$($sizes[$i])"
        style_code     = $canon
        name           = $name
        color          = if ($info) { $info.Color } else { '' }
        size           = $sizes[$i]
        qty            = $q
        suggested_price= $price
        needs_price    = if ($price) { '' } else { 'YES' }
      }
    }
  }

  if (-not $price) { $needPrice += "$canon  ($name)" }

  $styles += [pscustomobject]@{
    style_code  = $canon
    name        = $name
    color       = if ($info) { $info.Color } else { '' }
    category    = if ($info) { $info.Category } else { '' }
    unique_name = if ($info) { $info.UniqueNm } else { '' }
    fabric      = $fabric
    price       = $price
    needs_price = if ($price) { '' } else { 'YES' }
    in_hand     = $tot
    S=$sz['S']; M=$sz['M']; L=$sz['L']; XL=$sz['XL']; XXL=$sz['2XL']; XXXL=$sz['3XL']
    channels    = ($tags -join '|')
  }
}
$parser.Close()

$styles   | Export-Csv "$outDir\master_styles.csv"   -NoTypeInformation -Encoding UTF8
$variants | Export-Csv "$outDir\master_variants.csv" -NoTypeInformation -Encoding UTF8

$totalPieces = ($variants | Measure-Object qty -Sum).Sum
"==================== MASTER BUILD SUMMARY ===================="
"Styles in stock (IN HAND rows):  $($styles.Count)"
"Sellable variants (style x size): $($variants.Count)"
"Total physical pieces (= QR labels to print): $totalPieces"
"Styles still needing a price:     $($needPrice.Count)"
""
"-- styles needing a price (type these in manually) --"
$needPrice | ForEach-Object { "   $_" }
""
"-- sample of master_variants.csv (first 12) --"
$variants | Select-Object -First 12 variant_sku,size,qty,suggested_price | Format-Table -AutoSize | Out-String
"Files written to $outDir :"
"   master_styles.csv   ($($styles.Count) rows)"
"   master_variants.csv ($($variants.Count) rows)"
