-- Sizes table columns by their content instead of equal widths, so text-heavy columns get the room.
-- Pipe tables that wrap get their widths from the `|---|---|` separator, which is the same for every column in
-- report.md; this filter replaces those widths with ones proportional to each column's text length.
-- Usage: pandoc report.md --lua-filter colwidths.lua -o report.pdf --pdf-engine=typst

local MIN_SHARE = 0.08 -- no column narrower than 8% of the text width

local function cell_length(cell)
  return utf8.len(pandoc.utils.stringify(cell.contents)) or 0
end

local function add_row(totals, maxima, row)
  for i, cell in ipairs(row.cells) do
    local n = cell_length(cell)
    totals[i] = (totals[i] or 0) + n
    maxima[i] = math.max(maxima[i] or 0, n)
  end
end

function Table(tbl)
  local ncols = #tbl.colspecs
  if ncols < 2 then
    return nil
  end
  local totals, maxima = {}, {}
  for _, row in ipairs(tbl.head.rows) do
    add_row(totals, maxima, row)
  end
  for _, body in ipairs(tbl.bodies) do
    for _, row in ipairs(body.body) do
      add_row(totals, maxima, row)
    end
  end
  -- Weight: mostly the longest cell (it decides how many lines a row needs), softened so one very long cell
  -- doesn't starve the other columns.
  local weights, sum = {}, 0
  for i = 1, ncols do
    local w = math.sqrt(math.max(maxima[i] or 1, 1)) + 0.02 * (totals[i] or 0) / math.max(#tbl.bodies, 1)
    weights[i] = w
    sum = sum + w
  end
  local shares, total = {}, 0
  for i = 1, ncols do
    shares[i] = math.max(weights[i] / sum, MIN_SHARE)
    total = total + shares[i]
  end
  for i = 1, ncols do
    tbl.colspecs[i] = { tbl.colspecs[i][1], shares[i] / total }
  end
  return tbl
end
