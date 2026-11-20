// Small, allocation-conscious result conversion helpers shared by DatabaseWrapper.
// sql.js exposes column names for a prepared statement independent of the current row.
// Reading them once per statement avoids repeating WASM metadata lookups for every row.
function toObject(columns, values) {
  const row = {};
  for (let index = 0; index < columns.length; index++) row[columns[index]] = values[index];
  return row;
}

function readOne(statement) {
  if (!statement.step()) return undefined;
  return toObject(statement.getColumnNames(), statement.get());
}

function readAll(statement) {
  const columns = statement.getColumnNames();
  const rows = [];
  while (statement.step()) rows.push(toObject(columns, statement.get()));
  return rows;
}

module.exports = { readOne, readAll };
